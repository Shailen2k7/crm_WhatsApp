// =============================================================================
// CHASE DATA — everything the T2→T4 planner needs, read in a few batched trips.
// -----------------------------------------------------------------------------
// One loader, two readers: the tick (which sends) and the Automation screen in
// Settings (which only shows). Because both read the SAME facts through the
// SAME code, what the screen says will happen is what the tick will do.
//
// Phones never go into a URL as raw text here: every lookup is a PostgREST
// `in` filter built by the client library, which encodes the '+' properly.
// (A raw '+91…' in a hand-built query string decodes as a space and silently
// matches nothing — that is how an old backfill re-chased 113 people.)
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CHASE_KEYS, T1R_KEY, CHASE_HORIZON_DAYS,
  type AnyChaseKey, type ChaseHistRow, type PersonFacts, type T1Done,
} from './follow-up';
import { ecosystemStatesByConv } from './ecosystem';
import { chunk, inParallel } from './parallel';

export interface ChaseRules {
  ws: string;
  rules: Record<string, any>[];                       // eslint-disable-line @typescript-eslint/no-explicit-any
  ruleByKey: Map<AnyChaseKey, Record<string, any>>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Steps actually switched on right now. */
  enabledKeys: Set<string>;
  /** The chase anchors at the EARLIEST activation among its steps. */
  activatedAtMs: number;
}

export async function loadChaseRules(admin: SupabaseClient, workspaceId: string | null, now: number): Promise<ChaseRules | null> {
  let q = admin.from('relay_automations').select('*').in('key', [...CHASE_KEYS, T1R_KEY]);
  if (workspaceId) q = q.eq('workspace_id', workspaceId);
  const { data, error } = await q;
  if (error) throw new Error(`chase rules: ${error.message}`);
  const rules = (data || []) as Record<string, any>[];  // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!rules.length) return null;
  return {
    ws: rules[0].workspace_id as string,
    rules,
    ruleByKey: new Map(rules.map((r) => [r.key as AnyChaseKey, r])),
    enabledKeys: new Set<string>(rules.filter((r) => r.enabled).map((r) => r.key as string)),
    activatedAtMs: Math.min(...rules.map((r) => (r.activated_at ? new Date(r.activated_at).getTime() : now))),
  };
}

export interface ChaseFacts {
  backfillPhones: Set<string>;
  t1Rows: Map<string, T1Done>;
  history: ChaseHistRow[];
  facts: Map<string, PersonFacts>;
}

export async function loadChaseFacts(
  admin: SupabaseClient,
  opts: {
    ws: string; now: number; activatedAtMs: number;
    suppressed?: { workspace_id: string; phone_e164: string }[];
    /**
     * Narrows whose facts are fetched, given the cheap data. The tick passes
     * chaseCandidates (only people who could be due); the screen passes
     * nothing (it shows everyone).
     */
    pick?: (cheap: { t1Rows: Map<string, T1Done>; history: ChaseHistRow[]; backfillPhones: Set<string> }) => Set<string>;
  },
): Promise<ChaseFacts> {
  const { ws, now, activatedAtMs } = opts;

  // ---- entry tickets: successful T1s, plus the hand-picked backfill ---------
  const sinceIso = new Date(now - CHASE_HORIZON_DAYS * 86_400_000).toISOString();
  const { data: bfRow } = await admin.from('relay_settings')
    .select('value').eq('workspace_id', ws).eq('key', 'no_reply_chase_backfill').maybeSingle();
  // relay_settings.value is a TEXT column: the list arrives as a JSON string.
  let backfillPhones = new Set<string>();
  try {
    const parsed = typeof bfRow?.value === 'string' ? JSON.parse(bfRow.value) : bfRow?.value;
    if (Array.isArray(parsed)) backfillPhones = new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch { /* unreadable list = empty list; the chase then covers new leads only */ }

  const t1Cols = 'lead_id, phone_e164, sent_at, ok';
  const [recentT1, ...bfParts] = await Promise.all([
    admin.from('relay_automation_sent').select(t1Cols)
      .eq('workspace_id', ws).eq('automation_key', 'new_lead_first').eq('ok', true)
      .gte('sent_at', sinceIso).limit(2000),
    ...chunk([...backfillPhones], 100).map((ps) => admin.from('relay_automation_sent').select(t1Cols)
      .eq('workspace_id', ws).eq('automation_key', 'new_lead_first').eq('ok', true).in('phone_e164', ps)),
  ]);
  if (recentT1.error) throw new Error(`chase t1: ${recentT1.error.message}`);
  const t1Rows = new Map<string, T1Done>();
  for (const part of [recentT1, ...bfParts]) {
    for (const r of (part.data || []) as { lead_id: string | null; phone_e164: string; sent_at: string }[]) {
      if (!t1Rows.has(r.phone_e164)) t1Rows.set(r.phone_e164, { leadId: r.lead_id, phoneE164: r.phone_e164, sentAtMs: new Date(r.sent_at).getTime() });
    }
  }

  // ---- every chase row ever written (small; one person is at most 4 rows) ---
  const { data: histData, error: histErr } = await admin.from('relay_automation_sent')
    .select('id, automation_key, lead_id, phone_e164, ok, attempts, sent_at, error')
    .eq('workspace_id', ws).in('automation_key', [...CHASE_KEYS, T1R_KEY]).limit(5000);
  if (histErr) throw new Error(`chase history: ${histErr.message}`);
  const history = (histData || []) as ChaseHistRow[];

  const facts = new Map<string, PersonFacts>();
  if (!t1Rows.size) return { backfillPhones, t1Rows, history, facts };

  // ---- the facts, batched — only for the people that matter -------------------
  const wanted = opts.pick ? opts.pick({ t1Rows, history, backfillPhones }) : null;
  const phones = [...t1Rows.keys()].filter((p) => !wanted || wanted.has(p));
  if (!phones.length) return { backfillPhones, t1Rows, history, facts };
  type Conv = { id: string; phone_e164: string; last_inbound_at: string | null; lead_id: string | null; spotlight?: boolean | null };
  const phoneSet = new Set(phones);
  const wantedLeadIds = [...t1Rows.values()].filter((t) => phoneSet.has(t.phoneE164)).map((t) => t.leadId).filter(Boolean) as string[];
  const [byPhoneParts, byLeadParts] = await Promise.all([
    inParallel(chunk(phones, 100), async (ps) => {
      const { data, error } = await admin.from('relay_conversations')
        .select('id, phone_e164, last_inbound_at, lead_id, spotlight').eq('workspace_id', ws).in('phone_e164', ps);
      if (error) throw new Error(`chase convs: ${error.message}`);
      return (data || []) as Conv[];
    }),
    // ONE PERSON, TWO NUMBERS. A lead can chat from a number other than the
    // one the CRM holds (the ad form's). The webhook links that chat to the
    // lead, and here BOTH conversations count as the same person: a reply, a
    // team message or a STOP on either number stops the chase for them.
    inParallel(chunk(wantedLeadIds, 100), async (ids) => {
      const { data, error } = await admin.from('relay_conversations')
        .select('id, phone_e164, last_inbound_at, lead_id, spotlight').eq('workspace_id', ws).in('lead_id', ids);
      if (error) throw new Error(`chase linked convs: ${error.message}`);
      return (data || []) as Conv[];
    }),
  ]);
  const convs: Conv[] = byPhoneParts.flat();
  const seenConv = new Set(convs.map((c) => c.id));
  const convsByLead = new Map<string, Conv[]>();
  for (const c of byLeadParts.flat()) {
    if (!c.lead_id) continue;
    if (!convsByLead.has(c.lead_id)) convsByLead.set(c.lead_id, []);
    convsByLead.get(c.lead_id)!.push(c);
    if (!seenConv.has(c.id)) { seenConv.add(c.id); convs.push(c); }
  }
  const convByPhone = new Map(convs.map((c) => [c.phone_e164, c]));
  const convIds = convs.map((c) => c.id);
  const phoneByConv = new Map(convs.map((c) => [c.id, c.phone_e164]));

  // Team (human) outbound since activation, and failed automated sends — both
  // in the same chunked sweep over the conversations.
  const lastTeamOut = new Map<string, number>();
  const autoFails = new Map<string, { atMs: number; code: string | null }[]>();
  const activatedIso = new Date(activatedAtMs).toISOString();
  await inParallel(chunk(convIds, 100), async (ids) => {
    const [team, fails] = await Promise.all([
      admin.from('relay_messages').select('conversation_id, created_at')
        .in('conversation_id', ids).eq('direction', 'out').eq('is_internal', false)
        .not('sent_by', 'is', null).neq('status', 'failed').gte('created_at', activatedIso).limit(2000),
      admin.from('relay_messages').select('conversation_id, created_at, error_code')
        .in('conversation_id', ids).eq('direction', 'out').is('sent_by', null)
        .eq('status', 'failed').limit(2000),
    ]);
    if (team.error) throw new Error(`chase team: ${team.error.message}`);
    if (fails.error) throw new Error(`chase fails: ${fails.error.message}`);
    for (const m of (team.data || []) as { conversation_id: string; created_at: string }[]) {
      const p = phoneByConv.get(m.conversation_id); if (!p) continue;
      lastTeamOut.set(p, Math.max(lastTeamOut.get(p) ?? 0, new Date(m.created_at).getTime()));
    }
    for (const m of (fails.data || []) as { conversation_id: string; created_at: string; error_code: string | null }[]) {
      const p = phoneByConv.get(m.conversation_id); if (!p) continue;
      if (!autoFails.has(p)) autoFails.set(p, []);
      autoFails.get(p)!.push({ atMs: new Date(m.created_at).getTime(), code: m.error_code });
    }
  });

  const leadIds = wantedLeadIds;
  const leadInfo = new Map<string, { full_name: string | null; visa_type: string | null; stage: string | null; is_spotlight: boolean | null }>();
  type LeadRow = { id: string; full_name: string | null; visa_type: string | null; stage: string | null; is_spotlight: boolean | null };
  const [eco] = await Promise.all([
    ecosystemStatesByConv(admin, convIds, now),
    inParallel(chunk(leadIds, 100), async (ids) => {
      const { data, error } = await admin.from('leads').select('id, full_name, visa_type, stage, is_spotlight').in('id', ids);
      if (error) throw new Error(`chase leads: ${error.message}`);
      for (const l of (data || []) as LeadRow[]) leadInfo.set(l.id, l);
    }),
  ]);

  let suppressed = opts.suppressed;
  if (!suppressed) {
    const { data } = await admin.from('relay_suppressions').select('workspace_id, phone_e164').eq('workspace_id', ws);
    suppressed = (data || []) as { workspace_id: string; phone_e164: string }[];
  }
  const suppressedSet = new Set(suppressed.filter((x) => x.workspace_id === ws).map((x) => x.phone_e164));

  for (const t1 of t1Rows.values()) {
    if (!phoneSet.has(t1.phoneE164)) continue;
    const conv = convByPhone.get(t1.phoneE164) ?? null;
    const lead = t1.leadId ? leadInfo.get(t1.leadId) ?? null : null;
    // Every conversation that is this person: the T1 number's, plus any chat
    // the webhook linked to their lead from another number.
    const mine: Conv[] = [...new Map([
      ...(conv ? [[conv.id, conv] as const] : []),
      ...((t1.leadId ? convsByLead.get(t1.leadId) : undefined) ?? []).map((c) => [c.id, c] as const),
    ]).values()];
    const maxMs = (xs: (number | null)[]) => xs.reduce<number | null>((a, b) => (b === null ? a : a === null ? b : Math.max(a, b)), null);
    const ecoStates = mine.map((c) => eco.get(c.id)).filter(Boolean) as { stopped: boolean; pausedUntil: string | null }[];
    facts.set(t1.phoneE164, {
      conversationId: conv?.id ?? null,
      lastInboundMs: maxMs(mine.map((c) => (c.last_inbound_at ? new Date(c.last_inbound_at).getTime() : null))),
      lastTeamOutMs: maxMs(mine.map((c) => lastTeamOut.get(c.phone_e164) ?? null)),
      failTimes: autoFails.get(t1.phoneE164) || [],
      stage: lead?.stage ?? null,
      spotlight: !!lead?.is_spotlight || mine.some((c) => !!c.spotlight),
      name: lead?.full_name ?? null,
      visaType: lead?.visa_type ?? null,
      suppressed: mine.some((c) => suppressedSet.has(c.phone_e164)) || suppressedSet.has(t1.phoneE164),
      ecosystem: ecoStates.length ? {
        stopped: ecoStates.some((e) => e.stopped),
        pausedUntil: maxMs(ecoStates.map((e) => (e.pausedUntil ? new Date(e.pausedUntil).getTime() : null))) !== null
          ? new Date(maxMs(ecoStates.map((e) => (e.pausedUntil ? new Date(e.pausedUntil).getTime() : null)))!).toISOString()
          : null,
      } : null,
    });
  }
  return { backfillPhones, t1Rows, history, facts };
}
