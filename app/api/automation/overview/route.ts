// =============================================================================
// AUTOMATION OVERVIEW — everything one tab of Settings → Automation shows.
// -----------------------------------------------------------------------------
// GET ?key=<step>  (any active member may look; nothing here writes)
//
//   rule      the switch, daily limit, template and its approved wording
//   stats     sent today / 7 days, delivered, refused by Meta, replied
//   sent      the latest people it went to, with the real WhatsApp outcome
//   next      (T1 retry, T2, T3, T4) who is next and when — from the SAME
//             loader and planner the sending engine uses, so the screen
//             cannot promise something the engine will not do
//   stopped   who is out of this step for good, and why
//   undelivered (T1 only) leads whose T1 never arrived, and whether a resend
//             can help
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { loadChaseRules, loadChaseFacts } from '@/lib/automation/chase-data';
import { planChase } from '@/lib/automation/follow-up';
import { findUndeliveredT1 } from '@/lib/automation/undelivered';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEYS = ['new_lead_first', 'no_reply_t1r', 'no_reply_t2', 'no_reply_t3', 'no_reply_t4'];
const SEND_START_HOUR = 10;
const SEND_END_HOUR = 19;
const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** IST date (YYYY-MM-DD) and hour of an instant. */
function ist(ms: number): { date: string; hour: number } {
  const d = new Date(ms);
  return {
    date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d),
    hour: Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(d)) % 24,
  };
}
/** The earliest moment at/after `ms` inside sending hours (10:00–19:00 IST). */
function nextSendSlot(ms: number): number {
  const { date, hour } = ist(ms);
  if (hour >= SEND_START_HOUR && hour < SEND_END_HOUR) return ms;
  const tenAm = new Date(`${date}T${String(SEND_START_HOUR).padStart(2, '0')}:00:00+05:30`).getTime();
  return hour < SEND_START_HOUR ? tenAm : tenAm + 86_400_000;
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 });
  const { data: member } = await supabase.from('workspace_members')
    .select('workspace_id, role, status').eq('user_id', user.id).maybeSingle();
  if (!member || member.status !== 'active') return NextResponse.json({ ok: false, error: 'No active workspace membership.' }, { status: 403 });
  const ws = member.workspace_id as string;

  const key = new URL(req.url).searchParams.get('key') || '';
  if (!KEYS.includes(key)) return NextResponse.json({ ok: false, error: 'Unknown automation.' }, { status: 400 });

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });
  const now = Date.now();

  try {
    // ---- the rule and its wording --------------------------------------------
    const { data: rule } = await admin.from('relay_automations')
      .select('key, enabled, template_name, daily_cap, activated_at')
      .eq('workspace_id', ws).eq('key', key).maybeSingle();
    if (!rule) return NextResponse.json({ ok: false, error: 'This automation is not set up.' }, { status: 404 });
    const { data: tpl } = rule.template_name
      ? await admin.from('relay_templates').select('body').eq('workspace_id', ws).eq('name', rule.template_name).maybeSingle()
      : { data: null };

    // ---- recent sends (30 days) and their real outcome ----------------------
    const since30 = new Date(now - 30 * 86_400_000).toISOString();
    const { data: sentRows, error: sentErr } = await admin.from('relay_automation_sent')
      .select('lead_id, phone_e164, sent_at').eq('workspace_id', ws).eq('automation_key', key)
      .eq('ok', true).gte('sent_at', since30).order('sent_at', { ascending: false }).limit(1000);
    if (sentErr) throw new Error(sentErr.message);
    const sent = (sentRows || []) as { lead_id: string | null; phone_e164: string; sent_at: string }[];

    const convs: { id: string; phone_e164: string; last_inbound_at: string | null }[] = [];
    for (const ps of chunk([...new Set(sent.map((s) => s.phone_e164))], 100)) {
      const { data } = await admin.from('relay_conversations')
        .select('id, phone_e164, last_inbound_at').eq('workspace_id', ws).in('phone_e164', ps);
      convs.push(...((data || []) as typeof convs));
    }
    const convByPhone = new Map(convs.map((c) => [c.phone_e164, c]));
    const msgsByConv = new Map<string, { created_at: string; status: string; error_code: string | null; error_detail: string | null }[]>();
    if (rule.template_name) {
      for (const ids of chunk(convs.map((c) => c.id), 100)) {
        const { data } = await admin.from('relay_messages')
          .select('conversation_id, created_at, status, error_code, error_detail')
          .in('conversation_id', ids).eq('direction', 'out').is('sent_by', null)
          .eq('template_name', rule.template_name).gte('created_at', since30).limit(5000);
        for (const m of (data || []) as { conversation_id: string; created_at: string; status: string; error_code: string | null; error_detail: string | null }[]) {
          if (!msgsByConv.has(m.conversation_id)) msgsByConv.set(m.conversation_id, []);
          msgsByConv.get(m.conversation_id)!.push(m);
        }
      }
    }

    const leadIds = new Set<string>(sent.map((s) => s.lead_id).filter(Boolean) as string[]);

    type SentItem = { leadId: string | null; phone: string; sentAt: string; status: string; error: string | null; replied: boolean };
    const sentItems: SentItem[] = sent.map((s) => {
      const conv = convByPhone.get(s.phone_e164);
      const at = new Date(s.sent_at).getTime();
      // The message this send produced: the first matching template at/after the record.
      const msg = (conv ? msgsByConv.get(conv.id) || [] : [])
        .filter((m) => new Date(m.created_at).getTime() >= at - 2 * 60_000)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      return {
        leadId: s.lead_id, phone: s.phone_e164, sentAt: s.sent_at,
        status: msg?.status || 'sent',
        error: msg?.status === 'failed' ? (msg.error_detail || msg.error_code || 'failed') : null,
        replied: !!(conv?.last_inbound_at && new Date(conv.last_inbound_at).getTime() > at),
      };
    });

    const todayIso = new Date(`${ist(now).date}T00:00:00+05:30`).toISOString();
    const in7 = sentItems.filter((s) => now - new Date(s.sentAt).getTime() <= 7 * 86_400_000);
    const stats = {
      today: sentItems.filter((s) => s.sentAt >= todayIso).length,
      week: in7.length,
      delivered: in7.filter((s) => s.status === 'delivered' || s.status === 'read').length,
      read: in7.filter((s) => s.status === 'read').length,
      refused: in7.filter((s) => s.status === 'failed').length,
      replied: in7.filter((s) => s.replied).length,
    };

    // ---- who is out of this step for good -------------------------------------
    const { data: stoppedRows } = await admin.from('relay_automation_sent')
      .select('lead_id, phone_e164, error, sent_at').eq('workspace_id', ws).eq('automation_key', key)
      .eq('ok', false).like('error', '%stopped%').order('sent_at', { ascending: false }).limit(200);
    const stopped = ((stoppedRows || []) as { lead_id: string | null; phone_e164: string; error: string | null; sent_at: string }[])
      .map((r) => ({ leadId: r.lead_id, phone: r.phone_e164, at: r.sent_at, reason: (r.error || '').replace(/^stopped — /, '') }));
    for (const r of stopped) if (r.leadId) leadIds.add(r.leadId);
    // T1's own "the team had already messaged this person" skips.
    if (key === 'new_lead_first') {
      const { data: sk } = await admin.from('relay_automation_sent')
        .select('lead_id, phone_e164, error, sent_at').eq('workspace_id', ws).eq('automation_key', key)
        .eq('method', 'skipped').order('sent_at', { ascending: false }).limit(200);
      for (const r of (sk || []) as { lead_id: string | null; phone_e164: string; error: string | null; sent_at: string }[]) {
        stopped.push({ leadId: r.lead_id, phone: r.phone_e164, at: r.sent_at, reason: (r.error || '').replace(/^not sent — /, '') });
        if (r.lead_id) leadIds.add(r.lead_id);
      }
    }

    // ---- who is next — the engine's own planner, read-only --------------------
    let next: { leadId: string | null; phone: string; name: string | null; at: string; state: string }[] = [];
    if (key !== 'new_lead_first') {
      const loaded = await loadChaseRules(admin, ws, now);
      if (loaded) {
        const { backfillPhones, t1Rows, history, facts } = await loadChaseFacts(admin, { ws, now, activatedAtMs: loaded.activatedAtMs });
        const plan = planChase({
          now, activatedAtMs: loaded.activatedAtMs, t1Done: [...t1Rows.values()], history, facts, backfillPhones,
          enabledKeys: loaded.enabledKeys,
        });
        const due = plan.jobs.filter((j) => j.key === key).map((j) => ({
          leadId: j.leadId, phone: j.phoneE164, name: j.name, at: new Date(nextSendSlot(now)).toISOString(), state: 'due',
        }));
        const later = plan.upcoming.filter((u) => u.key === key).map((u) => ({
          leadId: u.leadId, phone: u.phoneE164, name: u.name,
          at: new Date(u.wait === 'off' ? Math.max(u.dueMs, now) : nextSendSlot(Math.max(u.dueMs, now))).toISOString(),
          state: u.wait === 'off' ? 'switch_off' : u.wait === 'ecosystem' ? 'meta_pause' : 'scheduled',
        }));
        next = [...due, ...later].slice(0, 300);
      }
    }

    const undelivered = key === 'new_lead_first' ? await findUndeliveredT1(admin, ws, now) : [];

    // ---- names, in one go ---------------------------------------------------------
    const names = new Map<string, string | null>();
    for (const ids of chunk([...leadIds], 100)) {
      const { data } = await admin.from('leads').select('id, full_name').in('id', ids);
      for (const l of (data || []) as { id: string; full_name: string | null }[]) names.set(l.id, l.full_name);
    }
    const nameOf = (leadId: string | null) => (leadId ? names.get(leadId) ?? null : null);

    return NextResponse.json({
      ok: true,
      isAdmin: member.role === 'admin',
      rule: { ...rule, body: (tpl as { body?: string } | null)?.body ?? null },
      stats,
      sent: sentItems.slice(0, 100).map((s) => ({ ...s, name: nameOf(s.leadId) })),
      next,
      stopped: stopped.slice(0, 200).map((s) => ({ ...s, name: nameOf(s.leadId) })),
      undelivered,
    });
  } catch (e) {
    console.error('[automation overview]', e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
