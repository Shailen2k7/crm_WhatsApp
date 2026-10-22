// =============================================================================
// AUTOMATION SWITCHES — the on/off buttons in Settings.
// -----------------------------------------------------------------------------
// GET  → every automation step, whether it is on, its daily cap, and how many
//        went out today. Any signed-in member may look.
// POST → {key, enabled?, dailyCap?} flips one step. ADMINS ONLY, checked here
//        on the server: the table's own row-level security lets any member
//        write, so the button being hidden in the UI is not enough.
//
// Only the five keys below can be touched from here. Meeting messages,
// campaigns and sequences were removed on 30 Sep 2026 and stay removed — this
// route cannot switch them back on.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SWITCH_KEYS = ['new_lead_first', 'no_reply_t1r', 'no_reply_t2', 'no_reply_t3', 'no_reply_t4'] as const;
type SwitchKey = (typeof SWITCH_KEYS)[number];
const MAX_CAP = 500;

async function whoIsCalling() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 }) };
  const { data: member } = await supabase
    .from('workspace_members').select('workspace_id, role, status')
    .eq('user_id', user.id).maybeSingle();
  if (!member || member.status !== 'active') {
    return { error: NextResponse.json({ ok: false, error: 'No active workspace membership.' }, { status: 403 }) };
  }
  return { user, workspaceId: member.workspace_id as string, isAdmin: member.role === 'admin' };
}

function istMidnightIso(): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return new Date(`${today}T00:00:00+05:30`).toISOString();
}

export async function GET() {
  const who = await whoIsCalling();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  const [rules, sent] = await Promise.all([
    admin.from('relay_automations')
      .select('key, enabled, template_name, daily_cap, updated_at')
      .eq('workspace_id', who.workspaceId).in('key', [...SWITCH_KEYS]),
    admin.from('relay_automation_sent')
      .select('automation_key')
      .eq('workspace_id', who.workspaceId).in('automation_key', [...SWITCH_KEYS])
      .eq('ok', true).gte('sent_at', istMidnightIso()).limit(5000),
  ]);
  if (rules.error) return NextResponse.json({ ok: false, error: rules.error.message }, { status: 500 });

  const today: Record<string, number> = {};
  for (const r of (sent.data || []) as { automation_key: string }[]) today[r.automation_key] = (today[r.automation_key] || 0) + 1;

  return NextResponse.json({
    ok: true,
    isAdmin: who.isAdmin,
    rules: (rules.data || []).map((r) => ({ ...r, sentToday: today[r.key as string] || 0 })),
  });
}

export async function POST(req: Request) {
  const who = await whoIsCalling();
  if ('error' in who) return who.error;
  if (!who.isAdmin) return NextResponse.json({ ok: false, error: 'Only an admin can switch automations on or off.' }, { status: 403 });

  let body: { key?: string; enabled?: unknown; dailyCap?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 }); }

  const key = body.key as SwitchKey;
  if (!SWITCH_KEYS.includes(key)) return NextResponse.json({ ok: false, error: 'Unknown automation.' }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (body.dailyCap !== undefined) {
    const cap = Number(body.dailyCap);
    if (!Number.isInteger(cap) || cap < 0 || cap > MAX_CAP) {
      return NextResponse.json({ ok: false, error: `Daily limit must be a whole number from 0 to ${MAX_CAP} (0 = no limit).` }, { status: 400 });
    }
    patch.daily_cap = cap;
  }
  if (Object.keys(patch).length === 1) return NextResponse.json({ ok: false, error: 'Nothing to change.' }, { status: 400 });

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });
  const { data, error } = await admin.from('relay_automations')
    .update(patch).eq('workspace_id', who.workspaceId).eq('key', key)
    .select('key, enabled, template_name, daily_cap, updated_at').maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: 'That automation is not set up for this workspace.' }, { status: 404 });

  console.info('[automation switch]', { by: who.user.email, key, ...patch });
  return NextResponse.json({ ok: true, rule: data });
}
