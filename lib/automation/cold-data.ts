// =============================================================================
// COLD DATA — everything the CC1→CC8 planner needs, read in batched trips.
// -----------------------------------------------------------------------------
// One loader, two readers (the tick that sends and the Automation tab that
// shows), so the screen can never promise something the engine will not do.
//
// The audience is LEADS:
//   * the ones Shailen tagged cold-p1 / cold-p2 / cold-p3 (tags are READ here,
//     never written), plus
//   * automatically, anyone whose T4 was delivered — the T chase's
//     non-repliers hand over with no re-tagging —
// minus samples, the retired, the not-eligible and the said-no-to-paying.
//
// EVERY expensive read is bounded by a candidate set, never by the whole
// audience: ~1,600 cold leads (and growing) × conversations × messages every
// five minutes is exactly the shape that starved the old engine. The tick
// passes a picker that keeps only the people whose next act could be near
// (see coldSeriesCandidates) plus the top slice of potential starters; the
// Automation screen passes a wider one.
//
// Phones never go into a URL as raw text here: every lookup is a PostgREST
// `in` filter built by the client library, which encodes the '+' properly.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { toE164 } from '@/lib/phone';
import { ecosystemStatesByConv } from './ecosystem';
import { chunk, inParallel } from './parallel';
import {
  COLD_KEYS, COLD_FLAG_KEY, COLD_RULE_KEY, coldSeriesCandidates,
  type ColdHistRow, type ColdPerson,
} from './cold';

export interface ColdRule {
  ws: string;
  enabled: boolean;
  dailyCap: number;
  activatedAtMs: number;
}

export async function loadColdRule(admin: SupabaseClient, workspaceId: string | null, now: number): Promise<ColdRule | null> {
  let q = admin.from('relay_automations').select('workspace_id, enabled, daily_cap, activated_at').eq('key', COLD_RULE_KEY);
  if (workspaceId) q = q.eq('workspace_id', workspaceId);
  const { data, error } = await q.limit(1);
  if (error) throw new Error(`cold rule: ${error.message}`);
  const r = (data || [])[0] as { workspace_id: string; enabled: boolean; daily_cap: number | null; activated_at: string | null } | undefined;
  if (!r) return null;
  return {
    ws: r.workspace_id,
    enabled: !!r.enabled,
    dailyCap: Number(r.daily_cap) || 0,
    activatedAtMs: r.activated_at ? new Date(r.activated_at).getTime() : now,
  };
}

export interface ColdFacts {
  people: ColdPerson[];
  history: ColdHistRow[];
  /** The whole audience's size by tier, for the screen (before any picking). */
  audience: { total: number; p1: number; p2: number; p3: number; inSeries: number; finishedOrStopped: number };
}

type LeadRow = {
  id: string; full_name: string | null; phone: string | null; visa_type: string | null;
  stage: string | null; is_spotlight: boolean | null; tags: string[] | null;
  eligibility: string | null; investment_readiness: string | null;
  created_at: string; retired_at: string | null;
};
const LEAD_COLS = 'id, full_name, phone, visa_type, stage, is_spotlight, tags, eligibility, investment_readiness, created_at, retired_at';

function priorityOf(l: LeadRow): 1 | 2 | 3 {
  const tags = l.tags || [];
  if (tags.includes('cold-p1')) return 1;
  if (tags.includes('cold-p2')) return 2;
  if (tags.includes('cold-p3')) return 3;
  // Auto-joined (T4 hand-over): the same ladder, derived from the CRM fields.
  if ((l.eligibility === 'eligible' || l.eligibility === 'highly_eligible') && l.investment_readiness === 'yes') return 1;
  if (l.investment_readiness === 'maybe') return 2;
  return 3;
}

/** Reads a whole table slice in pages, so a growing history can never be cut off. */
async function pagedRows<T>(makeQuery: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery(from, from + PAGE - 1);
    if (error) throw new Error(`${what}: ${error.message}`);
    const rows = (data || []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function loadColdFacts(
  admin: SupabaseClient,
  opts: {
    ws: string; now: number;
    suppressed?: { workspace_id: string; phone_e164: string }[];
    /** How many potential starters (no history yet) get full facts. */
    starterSlice: number;
    /** 'tick' keeps only near-due series people; 'screen' keeps them all. */
    mode: 'tick' | 'screen';
  },
): Promise<ColdFacts> {
  const { ws, now } = opts;

  // ---- round 1, cheap and parallel: the tagged, the T4 hand-overs, the
  // engine's own history, and the opt-outs ------------------------------------
  const [tagged, t4Rows, history, suppRows] = await Promise.all([
    pagedRows<LeadRow>((a, b) => admin.from('leads').select(LEAD_COLS)
      .eq('workspace_id', ws).eq('is_sample', false)
      .or('tags.cs.{cold-p1},tags.cs.{cold-p2},tags.cs.{cold-p3}')
      .order('id').range(a, b), 'cold tagged leads'),
    pagedRows<{ lead_id: string | null }>((a, b) => admin.from('relay_automation_sent').select('lead_id')
      .eq('workspace_id', ws).eq('automation_key', 'no_reply_t4').eq('ok', true)
      .order('id').range(a, b), 'cold t4 hand-overs'),
    pagedRows<ColdHistRow>((a, b) => admin.from('relay_automation_sent')
      .select('id, automation_key, lead_id, phone_e164, ok, attempts, sent_at, error')
      .eq('workspace_id', ws).in('automation_key', [...COLD_KEYS, COLD_FLAG_KEY])
      .order('id').range(a, b), 'cold history'),
    opts.suppressed
      ? Promise.resolve(opts.suppressed)
      : admin.from('relay_suppressions').select('workspace_id, phone_e164').eq('workspace_id', ws)
        .then(({ data }) => (data || []) as { workspace_id: string; phone_e164: string }[]),
  ]);
  const suppressed = new Set(suppRows.filter((s) => s.workspace_id === ws).map((s) => s.phone_e164));

  // ---- the audience: tagged ∪ T4 hand-overs, minus the never-ins -------------
  const leadById = new Map<string, LeadRow>();
  for (const l of tagged) leadById.set(l.id, l);
  const t4Ids = [...new Set(t4Rows.map((r) => r.lead_id).filter(Boolean) as string[])].filter((id) => !leadById.has(id));
  if (t4Ids.length) {
    await inParallel(chunk(t4Ids, 100), async (ids) => {
      const { data, error } = await admin.from('leads').select(LEAD_COLS)
        .eq('workspace_id', ws).eq('is_sample', false).in('id', ids);
      if (error) throw new Error(`cold t4 leads: ${error.message}`);
      for (const l of (data || []) as LeadRow[]) {
        // Hand-overs join only while they still look cold and worth chasing;
        // the tagged list is Shailen's own and stays in regardless of fields.
        if (l.retired_at) continue;
        if (l.eligibility === 'not_eligible' || l.investment_readiness === 'no') continue;
        if (!['cold', 'not_responding'].includes(l.stage || '')) continue;
        leadById.set(l.id, l);
      }
    });
  }
  const leads = [...leadById.values()].filter((l) => toE164(l.phone));

  // ---- who gets full facts on THIS run? ---------------------------------------
  const { active, over } = coldSeriesCandidates({ now, history });
  const inSeriesIds = new Set(history.filter((h) => h.lead_id).map((h) => h.lead_id as string));
  const starters = leads
    .filter((l) => !inSeriesIds.has(l.id))
    .sort((a, b) => priorityOf(a) - priorityOf(b) || b.created_at.localeCompare(a.created_at))
    .slice(0, Math.max(0, opts.starterSlice));
  const wanted = new Set<string>(starters.map((l) => l.id));
  for (const l of leads) {
    if (!inSeriesIds.has(l.id) || over.has(l.id)) continue;
    if (opts.mode === 'screen' || active.has(l.id)) wanted.add(l.id);
  }
  const picked = leads.filter((l) => wanted.has(l.id));

  const audience = {
    total: leads.length,
    p1: leads.filter((l) => priorityOf(l) === 1).length,
    p2: leads.filter((l) => priorityOf(l) === 2).length,
    p3: leads.filter((l) => priorityOf(l) === 3).length,
    inSeries: leads.filter((l) => inSeriesIds.has(l.id) && !over.has(l.id)).length,
    finishedOrStopped: leads.filter((l) => over.has(l.id)).length,
  };
  if (!picked.length) return { people: [], history, audience };

  // ---- round 2: only the picked people's conversations ------------------------
  type ConvRow = {
    id: string; phone_e164: string; lead_id: string | null;
    last_inbound_at: string | null; last_outbound_at: string | null;
    last_message_at: string | null; spotlight: boolean | null;
  };
  const CONV_COLS = 'id, phone_e164, lead_id, last_inbound_at, last_outbound_at, last_message_at, spotlight';
  const pickedIds = picked.map((l) => l.id);
  const pickedPhones = [...new Set(picked.map((l) => toE164(l.phone)).filter(Boolean) as string[])];
  const convById = new Map<string, ConvRow>();
  await Promise.all([
    inParallel(chunk(pickedIds, 100), async (ids) => {
      const { data, error } = await admin.from('relay_conversations').select(CONV_COLS)
        .eq('workspace_id', ws).in('lead_id', ids);
      if (error) throw new Error(`cold convs by lead: ${error.message}`);
      for (const c of (data || []) as ConvRow[]) convById.set(c.id, c);
    }),
    inParallel(chunk(pickedPhones, 100), async (ps) => {
      const { data, error } = await admin.from('relay_conversations').select(CONV_COLS)
        .eq('workspace_id', ws).in('phone_e164', ps);
      if (error) throw new Error(`cold convs by phone: ${error.message}`);
      for (const c of (data || []) as ConvRow[]) convById.set(c.id, c);
    }),
  ]);
  const convs = [...convById.values()];
  const last10 = (p: string | null | undefined) => {
    const d = String(p || '').replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : null;
  };
  const convsByLead = new Map<string, ConvRow[]>();
  const convsBy10 = new Map<string, ConvRow[]>();
  for (const c of convs) {
    if (c.lead_id) { if (!convsByLead.has(c.lead_id)) convsByLead.set(c.lead_id, []); convsByLead.get(c.lead_id)!.push(c); }
    const k = last10(c.phone_e164);
    if (k) { if (!convsBy10.has(k)) convsBy10.set(k, []); convsBy10.get(k)!.push(c); }
  }

  // ---- round 3: ecosystem state, team messages, refused sends — side by side --
  const allConvIds = convs.map((c) => c.id);
  const phoneByConv = new Map(convs.map((c) => [c.id, c.phone_e164]));
  const lastTeamOut = new Map<string, number>();                 // by conv phone
  const failsByConv = new Map<string, { atMs: number; code: string | null }[]>();
  // Team messages matter only once a series has started, and the first start is
  // the activation at the earliest — reading further back buys nothing.
  const sinceIso = new Date(Math.min(now, opts.now) - 120 * 86_400_000).toISOString();
  const [eco] = await Promise.all([
    ecosystemStatesByConv(admin, allConvIds, now),
    inParallel(chunk(allConvIds, 100), async (ids) => {
      const [team, fails] = await Promise.all([
        admin.from('relay_messages').select('conversation_id, created_at')
          .in('conversation_id', ids).eq('direction', 'out').eq('is_internal', false)
          .not('sent_by', 'is', null).neq('status', 'failed').gte('created_at', sinceIso).limit(2000),
        admin.from('relay_messages').select('conversation_id, created_at, error_code')
          .in('conversation_id', ids).eq('direction', 'out').is('sent_by', null)
          .eq('status', 'failed').limit(2000),
      ]);
      if (team.error) throw new Error(`cold team: ${team.error.message}`);
      if (fails.error) throw new Error(`cold fails: ${fails.error.message}`);
      for (const m of (team.data || []) as { conversation_id: string; created_at: string }[]) {
        const p = phoneByConv.get(m.conversation_id); if (!p) continue;
        lastTeamOut.set(p, Math.max(lastTeamOut.get(p) ?? 0, new Date(m.created_at).getTime()));
      }
      for (const m of (fails.data || []) as { conversation_id: string; created_at: string; error_code: string | null }[]) {
        if (!failsByConv.has(m.conversation_id)) failsByConv.set(m.conversation_id, []);
        failsByConv.get(m.conversation_id)!.push({ atMs: new Date(m.created_at).getTime(), code: m.error_code });
      }
    }),
  ]);

  // ---- one person = lead + every conversation that is theirs ------------------
  const people: ColdPerson[] = [];
  for (const l of picked) {
    const mine = [...new Map([
      ...(convsByLead.get(l.id) || []).map((c) => [c.id, c] as const),
      ...(convsBy10.get(last10(l.phone) || '') || []).map((c) => [c.id, c] as const),
    ]).values()];
    // Send where they actually talk: the busiest linked chat wins; the CRM
    // phone is the fallback for someone who has never messaged.
    const best = mine.filter((c) => c.lead_id === l.id).sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')))[0]
      ?? mine.sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')))[0]
      ?? null;
    const phone = best?.phone_e164 ?? toE164(l.phone);
    if (!phone) continue;
    const maxMs = (xs: (number | null)[]) => xs.reduce<number | null>((a, b) => (b === null ? a : a === null ? b : Math.max(a, b)), null);
    const ecoStates = mine.map((c) => eco.get(c.id)).filter(Boolean) as { stopped: boolean; pausedUntil: string | null }[];
    const pausedUntilMs = maxMs(ecoStates.map((e) => (e.pausedUntil ? new Date(e.pausedUntil).getTime() : null)));
    people.push({
      leadId: l.id,
      phoneE164: phone,
      name: l.full_name,
      visaType: l.visa_type,
      stage: l.retired_at ? 'retired' : l.stage,
      spotlight: !!l.is_spotlight || mine.some((c) => !!c.spotlight),
      priority: priorityOf(l),
      createdAtMs: new Date(l.created_at).getTime(),
      conversationId: best?.id ?? null,
      lastInboundMs: maxMs(mine.map((c) => (c.last_inbound_at ? new Date(c.last_inbound_at).getTime() : null))),
      lastOutboundMs: maxMs(mine.map((c) => (c.last_outbound_at ? new Date(c.last_outbound_at).getTime() : null))),
      lastTeamOutMs: maxMs(mine.map((c) => lastTeamOut.get(c.phone_e164) ?? null)),
      suppressed: suppressed.has(phone) || mine.some((c) => suppressed.has(c.phone_e164)),
      ecosystem: ecoStates.length ? {
        stopped: ecoStates.some((e) => e.stopped),
        pausedUntil: pausedUntilMs !== null ? new Date(pausedUntilMs).toISOString() : null,
      } : null,
      failTimes: mine.flatMap((c) => failsByConv.get(c.id) || []),
    });
  }

  return { people, history, audience };
}
