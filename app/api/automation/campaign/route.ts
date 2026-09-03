// =============================================================================
// CAMPAIGN API — the one-time blast.
// -----------------------------------------------------------------------------
// GET                      -> recent campaigns + their live counters
// POST { action:'preview'} -> how many people an audience would reach
// POST { action:'create' } -> build the recipient list and send now, or schedule
// POST { action:'pause'|'resume'|'cancel', id }
//
// Recipients are frozen at creation time, so editing a lead's stage afterwards
// cannot silently change who a campaign goes to.
// =============================================================================
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { toE164 } from '@/lib/phone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_RECIPIENTS = 5000;

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
  return { ws: member.workspace_id as string, admin, userId: user.id };
}

/** The people an audience resolves to, oldest first, minus anyone opted out. */
async function resolveAudience(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  ws: string,
  audience: string,
  limit: number,
  selectedPhones?: string[],
) {
  const { data: suppressed } = await admin
    .from('relay_suppressions').select('phone_e164').eq('workspace_id', ws);
  const stop = new Set((suppressed || []).map((s) => s.phone_e164));

  let leads: { id: string; full_name: string; phone: string }[] = [];

  if (audience === 'selected') {
    const wanted = (selectedPhones || []).map((p) => toE164(p)).filter(Boolean) as string[];
    if (!wanted.length) return { people: [], suppressedCount: 0 };
    const last10 = wanted.map((p) => p.slice(-10));
    const { data } = await admin
      .from('leads').select('id, full_name, phone')
      .eq('workspace_id', ws).not('phone', 'is', null)
      .or(last10.map((t) => `phone.like.%${t}`).join(','))
      .limit(MAX_RECIPIENTS);
    leads = (data || []) as typeof leads;
  } else {
    const stages = audience === 'both' ? ['cold', 'hot'] : [audience];
    const { data } = await admin
      .from('leads').select('id, full_name, phone')
      .eq('workspace_id', ws)
      .in('stage', stages)
      .not('phone', 'is', null).neq('phone', '')
      .order('created_at', { ascending: true })   // oldest first, same as the sequence
      .limit(Math.min(limit, MAX_RECIPIENTS));
    leads = (data || []) as typeof leads;
  }

  const seen = new Set<string>();
  const people: { lead_id: string; phone_e164: string; full_name: string }[] = [];
  let suppressedCount = 0;

  for (const l of leads) {
    const phone = toE164(l.phone);
    if (!phone || seen.has(phone)) continue;      // duplicate CRM rows collapse here
    seen.add(phone);
    if (stop.has(phone)) { suppressedCount++; continue; }
    people.push({ lead_id: l.id, phone_e164: phone, full_name: l.full_name });
    if (people.length >= limit) break;
  }
  return { people, suppressedCount };
}

export async function GET() {
  const a = await auth();
  if ('error' in a) return a.error;

  const { data: campaigns } = await a.admin
    .from('relay_campaigns').select('*').eq('workspace_id', a.ws)
    .order('created_at', { ascending: false }).limit(10);

  return NextResponse.json({ ok: true, campaigns: campaigns || [] });
}

export async function POST(req: NextRequest) {
  const a = await auth();
  if ('error' in a) return a.error;
  const { ws, admin } = a;
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');
  const nowIso = new Date().toISOString();

  // ---- how many would this reach? -----------------------------------------
  if (action === 'preview') {
    const { people, suppressedCount } = await resolveAudience(
      admin, ws, String(body.audience || 'cold'),
      Math.min(Number(body.limit) || MAX_RECIPIENTS, MAX_RECIPIENTS),
      body.phones,
    );
    return NextResponse.json({ ok: true, count: people.length, suppressed: suppressedCount });
  }

  // ---- build it ------------------------------------------------------------
  if (action === 'create') {
    const templateName = String(body.templateName || '').trim();
    if (!templateName) return NextResponse.json({ ok: false, error: 'Choose a template.' }, { status: 400 });

    const audience = String(body.audience || 'cold');
    const limit = Math.min(Number(body.limit) || MAX_RECIPIENTS, MAX_RECIPIENTS);
    const { people } = await resolveAudience(admin, ws, audience, limit, body.phones);
    if (!people.length) return NextResponse.json({ ok: false, error: 'That audience has nobody in it.' }, { status: 400 });

    const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt).toISOString() : null;

    const { data: campaign, error: cErr } = await admin.from('relay_campaigns').insert({
      workspace_id: ws,
      name: String(body.name || '').trim() || `${templateName} · ${people.length} people`,
      template_name: templateName,
      template_language: String(body.templateLanguage || 'en'),
      audience,
      status: scheduledAt ? 'scheduled' : 'sending',
      scheduled_at: scheduledAt,
      total: people.length,
      created_by: a.userId,
      started_at: scheduledAt ? null : nowIso,
    }).select('id').single();
    if (cErr || !campaign) return NextResponse.json({ ok: false, error: cErr?.message || 'Could not create.' }, { status: 500 });

    // Insert recipients in chunks — one 5,000-row insert can exceed the limit.
    for (let i = 0; i < people.length; i += 500) {
      const chunk = people.slice(i, i + 500).map((p) => ({
        campaign_id: campaign.id, workspace_id: ws,
        lead_id: p.lead_id, phone_e164: p.phone_e164, full_name: p.full_name,
        status: 'queued',
      }));
      const { error } = await admin.from('relay_campaign_recipients').insert(chunk);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, id: campaign.id, total: people.length, scheduled: !!scheduledAt });
  }

  // ---- pause / resume / cancel --------------------------------------------
  const id = String(body.id || '');
  if (!id) return NextResponse.json({ ok: false, error: 'Which campaign?' }, { status: 400 });

  const status =
    action === 'pause'  ? 'paused'
    : action === 'resume' ? 'sending'
    : action === 'cancel' ? 'cancelled'
    : null;
  if (!status) return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 });

  const { error } = await admin.from('relay_campaigns')
    .update({ status, updated_at: nowIso }).eq('id', id).eq('workspace_id', ws);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, status });
}
