// =============================================================================
// SEQUENCE API — what the Follow-up sequence page talks to.
// -----------------------------------------------------------------------------
// GET    -> the sequence, its steps, ramp, live counters, recent activity
// PATCH  -> save config (audience, steps, ramp, hours, name)
// POST   -> { action: 'start' | 'pause' | 'resume' | 'stop' }
//
// Counters are computed with the admin client so they are exact, not limited
// by row caps on the browser side.
// =============================================================================
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { intakeLimitFor } from '@/lib/sequence-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IST = 'Asia/Kolkata';
const istDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(d);

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

export async function GET() {
  const a = await auth();
  if ('error' in a) return a.error;
  const { ws, admin } = a;

  const { data: seq } = await admin
    .from('relay_sequences').select('*').eq('workspace_id', ws)
    .order('created_at').limit(1).maybeSingle();
  if (!seq) return NextResponse.json({ ok: false, error: 'Run migration 112 first.' }, { status: 404 });

  const dayStartIst = new Date(`${istDate()}T00:00:00+05:30`).toISOString();
  const stages = seq.audience === 'both' ? ['cold', 'hot'] : [seq.audience];

  const count = (q: PromiseLike<{ count: number | null }>) => q.then((r) => r.count ?? 0);
  const statusCount = (st: string) =>
    count(admin.from('relay_lead_sequences').select('id', { count: 'exact', head: true })
      .eq('sequence_id', seq.id).eq('status', st));

  const [steps, ramp, audienceTotal, enrolledTotal, active, completed, replied, skipped, stopped,
         enrolledToday, sentToday, sends, delivery, failures] = await Promise.all([
    admin.from('relay_sequence_steps').select('*').eq('sequence_id', seq.id).order('step_no').then((r) => r.data || []),
    admin.from('relay_sequence_ramp').select('*').eq('sequence_id', seq.id).order('stage_no').then((r) => r.data || []),
    count(admin.from('leads').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws).in('stage', stages).not('phone', 'is', null).neq('phone', '')),
    count(admin.from('relay_lead_sequences').select('id', { count: 'exact', head: true }).eq('sequence_id', seq.id)),
    statusCount('active'), statusCount('completed'), statusCount('replied'), statusCount('skipped'), statusCount('stopped'),
    count(admin.from('relay_lead_sequences').select('id', { count: 'exact', head: true })
      .eq('sequence_id', seq.id).gte('enrolled_at', dayStartIst)),
    count(admin.from('relay_sequence_sends').select('id', { count: 'exact', head: true })
      .eq('sequence_id', seq.id).eq('ok', true).gte('sent_at', dayStartIst)),
    admin.from('relay_sequence_sends').select('*').eq('sequence_id', seq.id)
      .order('sent_at', { ascending: false }).limit(15).then((r) => r.data || []),
    // Receipts rolled up across every send this sequence has made (113).
    admin.rpc('relay_sequence_delivery', { p_sequence_id: seq.id })
      .then((r) => (Array.isArray(r.data) ? r.data[0] : r.data) || { sent: 0, delivered: 0, read: 0, failed: 0 }),
    // Why messages bounced, so the number is actionable rather than alarming.
    admin.rpc('relay_sequence_failures', { p_sequence_id: seq.id })
      .then((r) => (Array.isArray(r.data) ? r.data : []) as { code: string; detail: string; hits: number }[]),
  ]);

  // Names for the activity list.
  const leadIds = [...new Set(sends.map((s) => s.lead_id).filter(Boolean))] as string[];
  const names: Record<string, string> = {};
  if (leadIds.length) {
    const { data: leads } = await admin.from('leads').select('id, full_name').in('id', leadIds);
    for (const l of leads || []) names[l.id] = l.full_name;
  }

  // Ramp day + today's limit, for the "Sent today 12 / 80" line.
  const day = seq.started_at
    ? Math.floor((new Date(`${istDate()}T00:00:00+05:30`).getTime() -
        new Date(`${istDate(new Date(seq.started_at))}T00:00:00+05:30`).getTime()) / 86_400_000) + 1
    : 0;
  const intakeLimit = seq.started_at ? intakeLimitFor(day, ramp) : (ramp[0]?.per_day ?? 0);

  return NextResponse.json({
    ok: true,
    sequence: seq,
    steps,
    ramp,
    stats: {
      audienceTotal,
      pending: Math.max(0, audienceTotal - enrolledTotal),
      active, completed, replied, skipped, stopped,
      enrolledToday, intakeLimit, sentToday, rampDay: day,
      delivery: {
        sent: Number(delivery.sent) || 0,
        delivered: Number(delivery.delivered) || 0,
        read: Number(delivery.read) || 0,
        failed: Number(delivery.failed) || 0,
      },
      failures: (failures || []).map((f) => ({
        code: f.code, detail: f.detail, hits: Number(f.hits) || 0,
      })),
    },
    activity: sends.map((s) => ({
      ...s, lead_name: (s.lead_id && names[s.lead_id]) || s.phone_e164,
    })),
  });
}

export async function PATCH(req: NextRequest) {
  const a = await auth();
  if ('error' in a) return a.error;
  const { ws, admin } = a;
  const body = await req.json().catch(() => ({}));

  const { data: seq } = await admin
    .from('relay_sequences').select('id').eq('workspace_id', ws)
    .order('created_at').limit(1).maybeSingle();
  if (!seq) return NextResponse.json({ ok: false, error: 'No sequence.' }, { status: 404 });

  if (body.sequence) {
    const allowed: Record<string, unknown> = {};
    for (const k of ['name', 'audience', 'hours_enabled', 'send_start_hour', 'send_end_hour']) {
      if (k in body.sequence) allowed[k] = body.sequence[k];
    }
    if (Object.keys(allowed).length) {
      const { error } = await admin.from('relay_sequences')
        .update({ ...allowed, updated_at: new Date().toISOString() }).eq('id', seq.id);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  // Steps and ramp are replaced wholesale — a handful of rows, and it makes
  // reordering/removal on the page trivially correct.
  if (Array.isArray(body.steps)) {
    const rows = body.steps
      .filter((st: { template_name?: string }) => st.template_name)
      .map((st: { template_name: string; template_language?: string; gap_days?: number }, i: number) => ({
        sequence_id: seq.id, workspace_id: ws, step_no: i + 1,
        template_name: st.template_name,
        template_language: st.template_language || 'en',
        gap_days: Math.max(0, Math.min(90, Number(st.gap_days ?? 3))),
      }));
    await admin.from('relay_sequence_steps').delete().eq('sequence_id', seq.id);
    if (rows.length) {
      const { error } = await admin.from('relay_sequence_steps').insert(rows);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  if (Array.isArray(body.ramp)) {
    const rows = body.ramp
      .filter((r: { per_day?: number }) => Number(r.per_day) > 0)
      .map((r: { per_day: number; duration_days?: number | null }, i: number, arr: unknown[]) => ({
        sequence_id: seq.id, workspace_id: ws, stage_no: i + 1,
        per_day: Math.max(1, Math.min(1000, Number(r.per_day))),
        duration_days: i === arr.length - 1 ? null : Math.max(1, Math.min(365, Number(r.duration_days ?? 10))),
      }));
    await admin.from('relay_sequence_ramp').delete().eq('sequence_id', seq.id);
    if (rows.length) {
      const { error } = await admin.from('relay_sequence_ramp').insert(rows);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const a = await auth();
  if ('error' in a) return a.error;
  const { ws, admin } = a;
  const { action } = await req.json().catch(() => ({}));

  const { data: seq } = await admin
    .from('relay_sequences').select('id, status, started_at').eq('workspace_id', ws)
    .order('created_at').limit(1).maybeSingle();
  if (!seq) return NextResponse.json({ ok: false, error: 'No sequence.' }, { status: 404 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (action === 'start' || action === 'resume') {
    patch.status = 'running';
    if (!seq.started_at) patch.started_at = new Date().toISOString(); // ramp day 1
  } else if (action === 'pause') patch.status = 'paused';
  else if (action === 'stop') patch.status = 'stopped';
  else return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 });

  const { error } = await admin.from('relay_sequences').update(patch).eq('id', seq.id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, status: patch.status });
}
