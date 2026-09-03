// =============================================================================
// PER-LEAD SEQUENCE CONTROL — the Pause / Resume beside a customer's details.
// -----------------------------------------------------------------------------
// GET  ?phone=+91…            -> where this person is in the follow-up sequence
// POST { phone, action }      -> 'pause' | 'resume' | 'remove' | 'send_next'
//
// Pausing is per-lead and independent of the sequence's own on/off switch: the
// machine keeps running for everyone else. A paused lead is simply not 'active',
// so the engine's due-query skips them without any special case.
// =============================================================================
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { toE164 } from '@/lib/phone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 }) };
  const { data: member } = await supabase
    .from('workspace_members').select('workspace_id, status').eq('user_id', user.id).maybeSingle();
  if (!member || member.status !== 'active') {
    return { error: NextResponse.json({ ok: false, error: 'No active membership.' }, { status: 403 }) };
  }
  const admin = createAdminClient();
  if (!admin) return { error: NextResponse.json({ ok: false, error: 'Server not configured.' }, { status: 500 }) };
  return { ws: member.workspace_id as string, admin };
}

export async function GET(req: NextRequest) {
  const a = await auth();
  if ('error' in a) return a.error;

  const phone = toE164(req.nextUrl.searchParams.get('phone') || '');
  if (!phone) return NextResponse.json({ ok: true, enrolled: false });

  const { data: row } = await a.admin
    .from('relay_lead_sequences')
    .select('id, sequence_id, status, current_step, next_send_at, exit_reason, last_sent_at')
    .eq('workspace_id', a.ws)
    .eq('phone_e164', phone)
    .maybeSingle();

  if (!row) {
    // Not enrolled — but the panel still wants to offer "add them", and to say
    // what they would receive, so report the sequence that exists.
    const { data: seq } = await a.admin
      .from('relay_sequences').select('id, name, status').eq('workspace_id', a.ws)
      .order('created_at').limit(1).maybeSingle();
    const { count } = await a.admin
      .from('relay_sequence_steps').select('id', { count: 'exact', head: true })
      .eq('sequence_id', seq?.id || '00000000-0000-0000-0000-000000000000');
    return NextResponse.json({
      ok: true, enrolled: false,
      sequenceExists: !!seq,
      sequenceName: seq?.name || null,
      sequenceRunning: seq?.status === 'running',
      totalSteps: count ?? 0,
    });
  }

  // How far through are they, and what is coming next?
  const [{ data: seq }, { data: steps }] = await Promise.all([
    a.admin.from('relay_sequences').select('name, status').eq('id', row.sequence_id).maybeSingle(),
    a.admin.from('relay_sequence_steps').select('step_no, template_name').eq('sequence_id', row.sequence_id).order('step_no'),
  ]);

  const total = (steps || []).length;
  const next = (steps || []).find((s) => s.step_no === row.current_step + 1);

  return NextResponse.json({
    ok: true,
    enrolled: true,
    sequenceName: seq?.name || 'Follow-up',
    sequenceRunning: seq?.status === 'running',
    status: row.status,
    currentStep: row.current_step,
    totalSteps: total,
    nextTemplate: next?.template_name || null,
    nextSendAt: row.status === 'active' ? row.next_send_at : null,
    exitReason: row.exit_reason,
    lastSentAt: row.last_sent_at,
  });
}

export async function POST(req: NextRequest) {
  const a = await auth();
  if ('error' in a) return a.error;

  const body = await req.json().catch(() => ({}));
  const phone = toE164(body.phone || '');
  const action = String(body.action || '');
  if (!phone) return NextResponse.json({ ok: false, error: 'No phone number.' }, { status: 400 });

  const { data: row } = await a.admin
    .from('relay_lead_sequences')
    .select('id, status, current_step')
    .eq('workspace_id', a.ws)
    .eq('phone_e164', phone)
    .maybeSingle();

  // Put someone into the sequence by hand, ahead of the daily intake queue.
  if (action === 'add') {
    if (row) return NextResponse.json({ ok: false, error: 'Already in the sequence.' }, { status: 400 });
    const { data: seq } = await a.admin
      .from('relay_sequences').select('id').eq('workspace_id', a.ws)
      .order('created_at').limit(1).maybeSingle();
    if (!seq) return NextResponse.json({ ok: false, error: 'No sequence exists yet.' }, { status: 404 });

    const { data: lead } = await a.admin
      .from('leads').select('id').eq('workspace_id', a.ws)
      .or(`phone.eq.${phone},phone.like.%${phone.slice(-10)}`).limit(1).maybeSingle();

    const { error } = await a.admin.from('relay_lead_sequences').insert({
      workspace_id: a.ws, sequence_id: seq.id, lead_id: lead?.id ?? null,
      phone_e164: phone, status: 'active', current_step: 0,
      next_send_at: new Date().toISOString(),
    });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, status: 'active' });
  }

  if (!row) return NextResponse.json({ ok: false, error: 'This person is not in the sequence.' }, { status: 404 });

  const now = new Date().toISOString();
  let patch: Record<string, unknown>;

  switch (action) {
    case 'pause':
      // 'stopped' is the engine's "do not send" state; the reason distinguishes
      // a deliberate pause from an opt-out, so Resume knows it may undo it.
      patch = { status: 'stopped', exit_reason: 'paused by hand', exited_at: now, updated_at: now };
      break;
    case 'resume':
      // Back to active, next message due now — they have already waited.
      patch = { status: 'active', exit_reason: null, exited_at: null, next_send_at: now, updated_at: now };
      break;
    case 'remove':
      patch = { status: 'stopped', exit_reason: 'removed by hand', exited_at: now, updated_at: now };
      break;
    case 'send_next':
      if (row.status !== 'active') {
        return NextResponse.json({ ok: false, error: 'Resume them first.' }, { status: 400 });
      }
      patch = { next_send_at: now, updated_at: now };
      break;
    default:
      return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 });
  }

  const { error } = await a.admin.from('relay_lead_sequences').update(patch).eq('id', row.id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, status: patch.status ?? row.status });
}
