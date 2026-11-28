// =============================================================================
// CALL MESSAGES API — Settings → Automation → Call messages (PC1 / PC2).
// -----------------------------------------------------------------------------
// GET  → both switches, the exact template wording, who is waiting (from the
//        engine's own planner) and the last messages sent. Any member may look.
// POST → {key, enabled}: switch PC1 or PC2 on or off (admins only). Switching
//        on stamps activated_at, so only calls booked / completed from that
//        moment on are ever messaged.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { planMeetingMessages, MEETING_RULE_KEYS, type MeetingRuleKey } from '@/lib/automation/meetings';
import { loadMeetingRules, loadMeetingFacts } from '@/lib/automation/meetings-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function caller() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 }) };
  const { data: member } = await supabase.from('workspace_members')
    .select('workspace_id, role, status').eq('user_id', user.id).maybeSingle();
  if (!member || member.status !== 'active') {
    return { error: NextResponse.json({ ok: false, error: 'No active workspace membership.' }, { status: 403 }) };
  }
  return { user, ws: member.workspace_id as string, isAdmin: member.role === 'admin' };
}

export async function GET() {
  const who = await caller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });
  const now = Date.now();

  try {
    const loaded = await loadMeetingRules(admin, who.ws);
    if (!loaded) return NextResponse.json({ ok: false, error: 'PC1 / PC2 are not set up.' }, { status: 404 });
    const facts = await loadMeetingFacts(admin, { ws: who.ws, now, templates: loaded.rules.map((r) => r.templateName).filter(Boolean) as string[] });
    const plan = planMeetingMessages({ now, rules: loaded.rules, meetings: facts.meetings, history: facts.history, ignoreSwitch: true });

    const names = loaded.rules.map((r) => r.templateName).filter(Boolean) as string[];
    const [tplRes, sentRes] = await Promise.all([
      admin.from('relay_templates').select('name, body').eq('workspace_id', who.ws).in('name', names.length ? names : ['-']),
      admin.from('relay_automation_sent').select('automation_key, lead_id, phone_e164, sent_at')
        .eq('workspace_id', who.ws).eq('ok', true)
        .like('automation_key', 'meeting_%:%').not('meeting_id', 'is', null)
        .order('sent_at', { ascending: false }).limit(60),
    ]);
    const bodyOf = new Map(((tplRes.data || []) as { name: string; body: string | null }[]).map((t) => [t.name, t.body]));
    const sentRows = (sentRes.data || []) as { automation_key: string; lead_id: string | null; phone_e164: string; sent_at: string }[];
    const nameById = new Map<string, string | null>();
    const ids = [...new Set(sentRows.map((r) => r.lead_id).filter(Boolean) as string[])];
    if (ids.length) {
      const { data } = await admin.from('leads').select('id, full_name').in('id', ids);
      for (const l of (data || []) as { id: string; full_name: string | null }[]) nameById.set(l.id, l.full_name);
    }

    return NextResponse.json({
      ok: true,
      isAdmin: who.isAdmin,
      rules: loaded.rules.map((r) => ({ key: r.key, enabled: r.enabled, template: r.templateName, body: r.templateName ? bodyOf.get(r.templateName) ?? null : null })),
      due: plan.jobs.map((j) => ({ rule: j.rule, name: j.name, phone: j.phoneE164 })),
      waiting: plan.waiting,
      sent: sentRows.map((r) => ({
        rule: r.automation_key.split(':')[0] as MeetingRuleKey, phone: r.phone_e164,
        name: r.lead_id ? nameById.get(r.lead_id) ?? null : null, at: r.sent_at,
      })),
    });
  } catch (e) {
    console.error('[meetings overview]', e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const who = await caller();
  if ('error' in who) return who.error;
  if (!who.isAdmin) return NextResponse.json({ ok: false, error: 'Only an admin can change this.' }, { status: 403 });
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  let body: { key?: unknown; enabled?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 }); }
  const key = body.key as MeetingRuleKey;
  if (!MEETING_RULE_KEYS.includes(key) || typeof body.enabled !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'Nothing to do.' }, { status: 400 });
  }
  const patch: Record<string, unknown> = { enabled: body.enabled, updated_at: new Date().toISOString() };
  if (body.enabled) patch.activated_at = new Date().toISOString();
  const { data, error } = await admin.from('relay_automations')
    .update(patch).eq('workspace_id', who.ws).eq('key', key).select('key, enabled').maybeSingle();
  if (error || !data) return NextResponse.json({ ok: false, error: error?.message || 'This message is not set up.' }, { status: 500 });
  console.info('[meetings switch]', { by: who.user.email, key, ...patch });
  return NextResponse.json({ ok: true, rule: data });
}
