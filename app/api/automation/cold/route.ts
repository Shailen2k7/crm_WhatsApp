// =============================================================================
// COLD CHASE API — Settings → Automation → Cold lead chase.
// -----------------------------------------------------------------------------
// GET → the whole tab in one answer: the switch, the audience by tier, today's
//       numbers, each step's wording and send count, who is next (from the
//       engine's own planner), who is out and why. Any active member may look.
//
// POST → the actions (admins only):
//   {enabled}    the engine's switch — flipping it on stamps activated_at
//   {dailyCap}   the total messages per day, paced through the sending window
//
// There is deliberately no pause and no skip here: the cold chase stops for
// good the moment the person (or the team) speaks — there is nothing to pause.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  planCold, templateOfColdStep, COLD_KEYS, COLD_RULE_KEY, COLD_START_CAP,
} from '@/lib/automation/cold';
import { loadColdRule, loadColdFacts } from '@/lib/automation/cold-data';

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

function istMidnightIso(): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return new Date(`${today}T00:00:00+05:30`).toISOString();
}

export async function GET() {
  const who = await caller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });
  const now = Date.now();

  try {
    const rule = await loadColdRule(admin, who.ws, now);
    if (!rule) return NextResponse.json({ ok: false, error: 'The cold chase is not set up.' }, { status: 404 });
    // The screen looks further ahead than a tick (more starters, every series
    // person), so the Next up list shows the real queue, not just this run's.
    const { people, history, audience } = await loadColdFacts(admin, {
      ws: who.ws, now, starterSlice: 300, mode: 'screen',
    });
    const plan = planCold({ now, enabled: true, activatedAtMs: rule.activatedAtMs, people, history });   // enabled=true: show the real queue even while off
    const byLead = new Map(people.map((p) => [p.leadId, p]));
    const byPhone = new Map(people.map((p) => [p.phoneE164, p]));
    const nameOf = (phone: string, leadId?: string | null) =>
      (leadId ? byLead.get(leadId)?.name : undefined) ?? byPhone.get(phone)?.name ?? null;

    const [tplRes, sentTodayRes, startsTodayRes] = await Promise.all([
      admin.from('relay_templates').select('name, body').eq('workspace_id', who.ws)
        .in('name', COLD_KEYS.map(templateOfColdStep)),
      admin.from('relay_automation_sent').select('id', { count: 'exact', head: true })
        .eq('workspace_id', who.ws).in('automation_key', COLD_KEYS).eq('ok', true)
        .gte('sent_at', istMidnightIso()),
      admin.from('relay_automation_sent').select('id', { count: 'exact', head: true })
        .eq('workspace_id', who.ws).eq('automation_key', COLD_KEYS[0]).eq('ok', true)
        .gte('sent_at', istMidnightIso()),
    ]);
    const bodies = new Map(((tplRes.data || []) as { name: string; body: string }[]).map((t) => [t.name, t.body]));

    const sentRows = history.filter((h) => h.ok && COLD_KEYS.includes(h.automation_key))
      .sort((a, b) => b.sent_at.localeCompare(a.sent_at));
    const stopped = history.filter((h) => (h.error || '').startsWith('stopped'))
      .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
      .map((h) => ({ phone: h.phone_e164, name: nameOf(h.phone_e164, h.lead_id), key: h.automation_key, at: h.sent_at, reason: (h.error || '').replace(/^stopped — /, '') }));
    // Stops the engine keeps re-deriving instead of writing down (it never
    // overwrites the record of a message that went) — shown here all the same.
    const listed = new Set(stopped.map((x) => x.phone));
    for (const st of plan.settles) {
      if (listed.has(st.phoneE164) || st.reason.startsWith('series complete')) continue;
      stopped.push({ phone: st.phoneE164, name: nameOf(st.phoneE164, st.leadId), key: st.key, at: new Date(now).toISOString(), reason: st.reason.replace(/^stopped — /, '') });
      listed.add(st.phoneE164);
    }
    const finished = history.filter((h) => h.automation_key === 'cold_cc_flag' && (h.error || '').startsWith('series complete')).length;

    const stepStats = COLD_KEYS.map((k) => ({
      key: k,
      template: templateOfColdStep(k),
      body: bodies.get(templateOfColdStep(k)) ?? null,
      sent: history.filter((h) => h.automation_key === k && h.ok).length,
    }));

    return NextResponse.json({
      ok: true,
      isAdmin: who.isAdmin,
      rule: { enabled: rule.enabled, dailyCap: rule.dailyCap, startCap: COLD_START_CAP },
      audience,
      sentToday: sentTodayRes.count ?? 0,
      startsToday: startsTodayRes.count ?? 0,
      finished,
      steps: stepStats,
      next: [
        ...plan.jobs.map((j) => ({ phone: j.phoneE164, name: j.name, key: j.key, priority: j.priority, at: new Date(now).toISOString(), state: 'due' as string })),
        ...plan.upcoming.map((u) => ({ phone: u.phoneE164, name: u.name, key: u.key, priority: u.priority, at: new Date(u.dueMs).toISOString(), state: u.wait as string })),
      ].slice(0, 300),
      sent: sentRows.slice(0, 100).map((h) => ({ phone: h.phone_e164, name: nameOf(h.phone_e164, h.lead_id), key: h.automation_key, at: h.sent_at })),
      stopped: stopped.slice(0, 200),
    });
  } catch (e) {
    console.error('[cold overview]', e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const who = await caller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  let body: { enabled?: unknown; dailyCap?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 }); }

  if (typeof body.enabled === 'boolean' || body.dailyCap !== undefined) {
    if (!who.isAdmin) return NextResponse.json({ ok: false, error: 'Only an admin can change this.' }, { status: 403 });
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.enabled === 'boolean') {
      patch.enabled = body.enabled;
      if (body.enabled) patch.activated_at = new Date().toISOString();
    }
    if (body.dailyCap !== undefined) {
      const cap = Number(body.dailyCap);
      if (!Number.isInteger(cap) || cap < 0 || cap > 500) return NextResponse.json({ ok: false, error: 'Daily limit must be 0–500 (0 = no limit).' }, { status: 400 });
      patch.daily_cap = cap;
    }
    const { data, error } = await admin.from('relay_automations')
      .update(patch).eq('workspace_id', who.ws).eq('key', COLD_RULE_KEY)
      .select('enabled, daily_cap').maybeSingle();
    if (error || !data) return NextResponse.json({ ok: false, error: error?.message || 'The cold chase is not set up.' }, { status: 500 });
    console.info('[cold switch]', { by: who.user.email, ...patch });
    return NextResponse.json({ ok: true, rule: { enabled: data.enabled, dailyCap: data.daily_cap, startCap: COLD_START_CAP } });
  }

  return NextResponse.json({ ok: false, error: 'Nothing to do.' }, { status: 400 });
}
