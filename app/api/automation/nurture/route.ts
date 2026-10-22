// =============================================================================
// NURTURE API — Settings → Automation → Hot & Spotlight, and the chat panel.
// -----------------------------------------------------------------------------
// GET → the whole tab in one answer: the switch, today's numbers, each step's
//       wording and send count, who is next (from the engine's own planner),
//       who is paused, who is out and why. Any active member may look.
//       ?phone=… → just that person's nurture state, for the chat side panel.
//
// POST → the actions:
//   {enabled} / {dailyCap}            admin only — the engine's switch and cap
//   {action:'pause',  phone}          any member — this person sends nothing
//   {action:'resume', phone}          any member — pick up where they left off
//   {action:'skipStep', phone, key}   admin — skip ONE message, series moves on
//
// Pause and skip are relay_automation_sent rows (keys nurture_hs_pause and the
// step's own key), so the engine and this screen can never disagree.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  planNurture, templateOfStep, NURTURE_KEYS, NURTURE_PAUSE_KEY, NURTURE_RULE_KEY, NURTURE_MAX_ATTEMPTS,
} from '@/lib/automation/nurture';
import { loadNurtureRule, loadNurtureFacts } from '@/lib/automation/nurture-data';

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

export async function GET(req: Request) {
  const who = await caller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });
  const now = Date.now();

  try {
    const rule = await loadNurtureRule(admin, who.ws, now);
    if (!rule) return NextResponse.json({ ok: false, error: 'The nurture is not set up.' }, { status: 404 });
    const { people, history } = await loadNurtureFacts(admin, { ws: who.ws, now });
    const plan = planNurture({ now, enabled: true, people, history });   // enabled=true: show the real queue even while off
    const byPhone = new Map(people.map((p) => [p.phoneE164, p]));

    // ---- one person, for the chat side panel -----------------------------------
    const phone = new URL(req.url).searchParams.get('phone');
    if (phone) {
      const last10 = (x: string) => x.replace(/\D/g, '').slice(-10);
      const p = people.find((x) => last10(x.phoneE164) === last10(phone)) || null;
      if (!p) return NextResponse.json({ ok: true, inAudience: false });
      const doneKeys = NURTURE_KEYS.filter((k) => {
        const row = history.find((h) => h.automation_key === k && h.phone_e164 === p.phoneE164);
        return row && (row.ok || (row.error || '').startsWith('skipped'));
      });
      const next = plan.jobs.find((j) => j.phoneE164 === p.phoneE164) || null;
      const waitRow = plan.upcoming.find((u) => u.phoneE164 === p.phoneE164) || null;
      const stoppedRow = history.find((h) => h.phone_e164 === p.phoneE164 && (h.error || '').startsWith('stopped')) || null;
      return NextResponse.json({
        ok: true, inAudience: true, isAdmin: who.isAdmin,
        phoneE164: p.phoneE164, paused: p.paused, spotlight: p.spotlight,
        done: doneKeys.length, total: NURTURE_KEYS.length,
        state: stoppedRow ? 'stopped' : p.paused ? 'paused' : doneKeys.length >= NURTURE_KEYS.length ? 'finished' : next ? 'due' : waitRow ? waitRow.wait : 'waiting',
        nextStep: next?.key ?? waitRow?.key ?? null,
        nextAt: next ? new Date(now).toISOString() : waitRow ? new Date(waitRow.dueMs).toISOString() : null,
        stoppedReason: stoppedRow ? (stoppedRow.error || '').replace(/^stopped — /, '') : null,
      });
    }

    // ---- the full tab -----------------------------------------------------------
    const [tplRes, sentTodayRes] = await Promise.all([
      admin.from('relay_templates').select('name, body').eq('workspace_id', who.ws)
        .in('name', NURTURE_KEYS.map(templateOfStep)),
      admin.from('relay_automation_sent').select('automation_key')
        .eq('workspace_id', who.ws).in('automation_key', NURTURE_KEYS).eq('ok', true)
        .gte('sent_at', istMidnightIso()).limit(2000),
    ]);
    const bodies = new Map(((tplRes.data || []) as { name: string; body: string }[]).map((t) => [t.name, t.body]));

    const nameOf = (p: string) => byPhone.get(p)?.name ?? null;
    const sentRows = history.filter((h) => h.ok && NURTURE_KEYS.includes(h.automation_key))
      .sort((a, b) => b.sent_at.localeCompare(a.sent_at));
    const stopped = history.filter((h) => (h.error || '').startsWith('stopped'))
      .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
      .map((h) => ({ phone: h.phone_e164, name: nameOf(h.phone_e164), key: h.automation_key, at: h.sent_at, reason: (h.error || '').replace(/^stopped — /, '') }));

    const stepStats = NURTURE_KEYS.map((k) => ({
      key: k,
      template: templateOfStep(k),
      body: bodies.get(templateOfStep(k)) ?? null,
      sent: history.filter((h) => h.automation_key === k && h.ok).length,
    }));

    return NextResponse.json({
      ok: true,
      isAdmin: who.isAdmin,
      rule: { enabled: rule.enabled, dailyCap: rule.dailyCap },
      audience: {
        total: people.length,
        spotlight: people.filter((p) => p.spotlight).length,
        paused: people.filter((p) => p.paused).length,
      },
      sentToday: (sentTodayRes.data || []).length,
      steps: stepStats,
      next: [
        ...plan.jobs.map((j) => ({ phone: j.phoneE164, name: j.name, key: j.key, spotlight: j.spotlight, at: new Date(now).toISOString(), state: 'due' })),
        ...plan.upcoming.map((u) => ({ phone: u.phoneE164, name: u.name, key: u.key, spotlight: u.spotlight, at: new Date(u.dueMs).toISOString(), state: u.wait })),
      ].slice(0, 300),
      sent: sentRows.slice(0, 100).map((h) => ({ phone: h.phone_e164, name: nameOf(h.phone_e164), key: h.automation_key, at: h.sent_at })),
      paused: people.filter((p) => p.paused).map((p) => ({ phone: p.phoneE164, name: p.name, spotlight: p.spotlight })),
      stopped: stopped.slice(0, 200),
    });
  } catch (e) {
    console.error('[nurture overview]', e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const who = await caller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  let body: { enabled?: unknown; dailyCap?: unknown; action?: string; phone?: string; key?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 }); }

  // ---- the engine's switch and cap: admins only --------------------------------
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
      .update(patch).eq('workspace_id', who.ws).eq('key', NURTURE_RULE_KEY)
      .select('enabled, daily_cap').maybeSingle();
    if (error || !data) return NextResponse.json({ ok: false, error: error?.message || 'The nurture is not set up.' }, { status: 500 });
    console.info('[nurture switch]', { by: who.user.email, ...patch });
    return NextResponse.json({ ok: true, rule: { enabled: data.enabled, dailyCap: data.daily_cap } });
  }

  // ---- per-person actions --------------------------------------------------------
  const phone = String(body.phone || '');
  if (!/^\+\d{8,15}$/.test(phone)) return NextResponse.json({ ok: false, error: 'Bad phone.' }, { status: 400 });

  if (body.action === 'pause' || body.action === 'resume') {
    const paused = body.action === 'pause';
    const stamp = `${paused ? 'paused' : 'resumed'} — by ${who.user.email} on ${new Date().toISOString().slice(0, 10)}`;
    const { error } = await admin.from('relay_automation_sent').upsert(
      { workspace_id: who.ws, automation_key: NURTURE_PAUSE_KEY, lead_id: null, phone_e164: phone, method: 'skipped', ok: false, error: stamp, attempts: 0 },
      { onConflict: 'workspace_id,automation_key,phone_e164' },
    );
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    console.info('[nurture]', stamp, phone);
    return NextResponse.json({ ok: true, paused });
  }

  if (body.action === 'skipStep') {
    if (!who.isAdmin) return NextResponse.json({ ok: false, error: 'Only an admin can skip a step.' }, { status: 403 });
    const key = String(body.key || '');
    if (!NURTURE_KEYS.includes(key)) return NextResponse.json({ ok: false, error: 'Unknown step.' }, { status: 400 });
    // Insert-only: if the step already has a row (sent, in flight, stopped),
    // skipping must not overwrite history — the screen refreshes instead.
    const { data, error } = await admin.from('relay_automation_sent')
      .upsert(
        { workspace_id: who.ws, automation_key: key, lead_id: null, phone_e164: phone, method: 'skipped', ok: false, error: `skipped — by ${who.user.email}`, attempts: NURTURE_MAX_ATTEMPTS },
        { onConflict: 'workspace_id,automation_key,phone_e164', ignoreDuplicates: true },
      ).select('id');
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    if (!data?.length) return NextResponse.json({ ok: false, error: 'That step already has history — refresh.' }, { status: 409 });
    console.info('[nurture] skipped', { by: who.user.email, phone, key });
    return NextResponse.json({ ok: true, skipped: key });
  }

  return NextResponse.json({ ok: false, error: 'Nothing to do.' }, { status: 400 });
}
