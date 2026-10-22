// =============================================================================
// AUTOMATION OVERVIEW — the data behind one step on Settings → Automation.
// -----------------------------------------------------------------------------
//   rule      the switch, daily limit, template and its approved wording
//   stats     sent today / 7 days, delivered, refused by Meta, replied
//   sent      the latest people it went to, with the real WhatsApp outcome
//   next      (T1 retry, T2, T3, T4) who is next and when — from the SAME
//             loader and planner the sending engine uses, so the screen
//             cannot promise something the engine will not do
//   stopped   who is out of this step for good, and why
//   undelivered (T1 only) leads whose T1 never arrived, and whether a resend
//             can help
//
// Every independent read runs at the same time, and every chunked read runs
// its chunks side by side: one after another this took 5–8 s per click.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadChaseRules, loadChaseFacts } from './chase-data';
import { planChase, chaseCandidates } from './follow-up';
import { findUndeliveredT1, type UndeliveredT1 } from './undelivered';
import { chunk, inParallel } from './parallel';

export const OVERVIEW_KEYS = ['new_lead_first', 'no_reply_t1r', 'no_reply_t2', 'no_reply_t3', 'no_reply_t4'];
const SEND_START_HOUR = 10;
const SEND_END_HOUR = 19;

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

type NextItem = { leadId: string | null; phone: string; name: string | null; at: string; state: string };
type StoppedItem = { leadId: string | null; phone: string; at: string; reason: string };

/** Who is next for a chase step, from the engine's own planner. */
async function nextFor(admin: SupabaseClient, ws: string, key: string, now: number): Promise<NextItem[]> {
  const loaded = await loadChaseRules(admin, ws, now);
  if (!loaded) return [];
  // Only people whose chase is not over — the same narrowing the engine uses.
  // Someone whose chase is over can never be "next", so the list is identical.
  const { backfillPhones, t1Rows, history, facts } = await loadChaseFacts(admin, {
    ws, now, activatedAtMs: loaded.activatedAtMs,
    pick: (cheap) => chaseCandidates({ now, activatedAtMs: loaded.activatedAtMs, ...cheap, t1Done: [...cheap.t1Rows.values()] }),
  });
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
  return [...due, ...later].slice(0, 300);
}

async function stoppedFor(admin: SupabaseClient, ws: string, key: string): Promise<StoppedItem[]> {
  const [stoppedRes, skippedRes] = await Promise.all([
    admin.from('relay_automation_sent')
      .select('lead_id, phone_e164, error, sent_at').eq('workspace_id', ws).eq('automation_key', key)
      .eq('ok', false).like('error', '%stopped%').order('sent_at', { ascending: false }).limit(200),
    // T1's own "the team had already messaged this person" skips.
    key === 'new_lead_first'
      ? admin.from('relay_automation_sent')
        .select('lead_id, phone_e164, error, sent_at').eq('workspace_id', ws).eq('automation_key', key)
        .eq('method', 'skipped').order('sent_at', { ascending: false }).limit(200)
      : Promise.resolve({ data: [] }),
  ]);
  type R = { lead_id: string | null; phone_e164: string; error: string | null; sent_at: string };
  return [
    ...((stoppedRes.data || []) as R[]).map((r) => ({ leadId: r.lead_id, phone: r.phone_e164, at: r.sent_at, reason: (r.error || '').replace(/^stopped — /, '') })),
    ...((skippedRes.data || []) as R[]).map((r) => ({ leadId: r.lead_id, phone: r.phone_e164, at: r.sent_at, reason: (r.error || '').replace(/^not sent — /, '') })),
  ];
}

export async function buildOverview(admin: SupabaseClient, ws: string, key: string, now = Date.now()) {
  const since30 = new Date(now - 30 * 86_400_000).toISOString();

  // ---- everything that does not depend on anything else, at once ------------
  const [ruleRes, sentRes, stopped, next, undelivered] = await Promise.all([
    admin.from('relay_automations')
      .select('key, enabled, template_name, daily_cap, activated_at')
      .eq('workspace_id', ws).eq('key', key).maybeSingle(),
    admin.from('relay_automation_sent')
      .select('lead_id, phone_e164, sent_at').eq('workspace_id', ws).eq('automation_key', key)
      .eq('ok', true).gte('sent_at', since30).order('sent_at', { ascending: false }).limit(1000),
    stoppedFor(admin, ws, key),
    key === 'new_lead_first' ? Promise.resolve([] as NextItem[]) : nextFor(admin, ws, key, now),
    key === 'new_lead_first' ? findUndeliveredT1(admin, ws, now) : Promise.resolve([] as UndeliveredT1[]),
  ]);
  const rule = ruleRes.data as { key: string; enabled: boolean; template_name: string | null; daily_cap: number | null } | null;
  if (!rule) return null;
  if (sentRes.error) throw new Error(sentRes.error.message);
  const sent = (sentRes.data || []) as { lead_id: string | null; phone_e164: string; sent_at: string }[];

  // ---- the wording, the conversations behind the sends, and names -----------
  type Conv = { id: string; phone_e164: string; last_inbound_at: string | null };
  const leadIds = new Set<string>([
    ...sent.map((s) => s.lead_id), ...stopped.map((s) => s.leadId),
  ].filter(Boolean) as string[]);
  const names = new Map<string, string | null>();
  const [tplRes, convs] = await Promise.all([
    rule.template_name
      ? admin.from('relay_templates').select('body').eq('workspace_id', ws).eq('name', rule.template_name).maybeSingle()
      : Promise.resolve({ data: null }),
    inParallel(chunk([...new Set(sent.map((s) => s.phone_e164))], 100), async (ps) => {
      const { data } = await admin.from('relay_conversations')
        .select('id, phone_e164, last_inbound_at').eq('workspace_id', ws).in('phone_e164', ps);
      return (data || []) as Conv[];
    }).then((parts) => parts.flat()),
    inParallel(chunk([...leadIds], 100), async (ids) => {
      const { data } = await admin.from('leads').select('id, full_name').in('id', ids);
      for (const l of (data || []) as { id: string; full_name: string | null }[]) names.set(l.id, l.full_name);
    }),
  ]);
  const convByPhone = new Map(convs.map((c) => [c.phone_e164, c]));

  // ---- the real outcome of each send ------------------------------------------
  type Msg = { conversation_id: string; created_at: string; status: string; error_code: string | null; error_detail: string | null };
  const msgsByConv = new Map<string, Msg[]>();
  if (rule.template_name) {
    await inParallel(chunk(convs.map((c) => c.id), 100), async (ids) => {
      const { data } = await admin.from('relay_messages')
        .select('conversation_id, created_at, status, error_code, error_detail')
        .in('conversation_id', ids).eq('direction', 'out').is('sent_by', null)
        .eq('template_name', rule.template_name!).gte('created_at', since30).limit(5000);
      for (const m of (data || []) as Msg[]) {
        if (!msgsByConv.has(m.conversation_id)) msgsByConv.set(m.conversation_id, []);
        msgsByConv.get(m.conversation_id)!.push(m);
      }
    });
  }

  const sentItems = sent.map((s) => {
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
  const nameOf = (leadId: string | null) => (leadId ? names.get(leadId) ?? null : null);

  return {
    rule: { ...rule, body: (tplRes.data as { body?: string } | null)?.body ?? null },
    stats: {
      today: sentItems.filter((s) => s.sentAt >= todayIso).length,
      week: in7.length,
      delivered: in7.filter((s) => s.status === 'delivered' || s.status === 'read').length,
      read: in7.filter((s) => s.status === 'read').length,
      refused: in7.filter((s) => s.status === 'failed').length,
      replied: in7.filter((s) => s.replied).length,
    },
    sent: sentItems.slice(0, 100).map((s) => ({ ...s, name: nameOf(s.leadId) })),
    next,
    stopped: stopped.slice(0, 200).map((s) => ({ ...s, name: nameOf(s.leadId) })),
    undelivered,
  };
}
