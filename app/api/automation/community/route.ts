// =============================================================================
// COMMUNITY INVITE API — Settings → Automation → Community invite.
// -----------------------------------------------------------------------------
// GET → the whole tab in one answer: the switch, the exact message, today's
//       and all-time numbers, who is next (from the engine's own planner),
//       who was invited, who is excluded. Any active member may look.
//
// POST → the actions (admins only):
//   {enabled}    the engine's switch
//   {dailyCap}   invites per day (0 = no limit)
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { planCommunity, COMMUNITY_KEY, COMMUNITY_RULE_KEY } from '@/lib/automation/community';
import { loadCommunityRule, loadCommunityPeople } from '@/lib/automation/community-data';

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
    const rule = await loadCommunityRule(admin, who.ws);
    if (!rule) return NextResponse.json({ ok: false, error: 'The community invite is not set up.' }, { status: 404 });
    const people = await loadCommunityPeople(admin, { ws: who.ws, now });
    const plan = planCommunity({ now, enabled: true, people });   // enabled=true: show the real queue even while off

    const [qrRes, sentTodayRes, sentAllRes, recentSentRes] = await Promise.all([
      rule.quickReplyShortcut
        ? admin.from('relay_quick_replies').select('body').eq('workspace_id', who.ws).eq('shortcut', rule.quickReplyShortcut).maybeSingle()
        : Promise.resolve({ data: null }),
      admin.from('relay_automation_sent').select('id', { count: 'exact', head: true })
        .eq('workspace_id', who.ws).eq('automation_key', COMMUNITY_KEY).eq('ok', true)
        .gte('sent_at', istMidnightIso()),
      admin.from('relay_automation_sent').select('id', { count: 'exact', head: true })
        .eq('workspace_id', who.ws).eq('automation_key', COMMUNITY_KEY).eq('ok', true),
      admin.from('relay_automation_sent').select('lead_id, phone_e164, sent_at')
        .eq('workspace_id', who.ws).eq('automation_key', COMMUNITY_KEY).eq('ok', true)
        .order('sent_at', { ascending: false }).limit(100),
    ]);
    const sentRows = (recentSentRes.data || []) as { lead_id: string | null; phone_e164: string; sent_at: string }[];
    // Names for the recent invites, in one bounded read.
    const nameById = new Map<string, string | null>();
    const ids = [...new Set(sentRows.map((r) => r.lead_id).filter(Boolean) as string[])];
    if (ids.length) {
      const { data } = await admin.from('leads').select('id, full_name').in('id', ids);
      for (const l of (data || []) as { id: string; full_name: string | null }[]) nameById.set(l.id, l.full_name);
    }

    return NextResponse.json({
      ok: true,
      isAdmin: who.isAdmin,
      rule: { enabled: rule.enabled, dailyCap: rule.dailyCap, shortcut: rule.quickReplyShortcut },
      body: (qrRes.data as { body: string } | null)?.body ?? null,
      talkersNow: people.length,
      sentToday: sentTodayRes.count ?? 0,
      sentTotal: sentAllRes.count ?? 0,
      next: [
        ...plan.jobs.map((j) => ({ phone: j.phoneE164, name: j.name, at: new Date(now).toISOString(), state: 'due' as string })),
        ...plan.upcoming.map((u) => ({ phone: u.phoneE164, name: u.name, at: new Date(u.dueMs).toISOString(), state: u.wait as string })),
      ].slice(0, 100),
      sent: sentRows.map((r) => ({ phone: r.phone_e164, name: r.lead_id ? nameById.get(r.lead_id) ?? null : null, at: r.sent_at })),
      waitingNotes: plan.skipped.slice(0, 50),
    });
  } catch (e) {
    console.error('[community overview]', e);
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
      .update(patch).eq('workspace_id', who.ws).eq('key', COMMUNITY_RULE_KEY)
      .select('enabled, daily_cap').maybeSingle();
    if (error || !data) return NextResponse.json({ ok: false, error: error?.message || 'The community invite is not set up.' }, { status: 500 });
    console.info('[community switch]', { by: who.user.email, ...patch });
    return NextResponse.json({ ok: true, rule: { enabled: data.enabled, dailyCap: data.daily_cap } });
  }

  return NextResponse.json({ ok: false, error: 'Nothing to do.' }, { status: 400 });
}
