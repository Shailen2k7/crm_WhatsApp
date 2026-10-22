// =============================================================================
// THE NO-REPLY CHASE (T2 → T3 → T4) — who gets which follow-up on this run.
// -----------------------------------------------------------------------------
// Pure: data in, decisions out, no I/O — exactly like the T1 planner, and for
// the same reason: every rule here can be tested without a database, and the
// tick stays down to a handful of batched reads.
//
// THE SHAPE OF THE CHASE (Shailen, 17 Oct 2026):
//
//   T1 + 1 day  → T2        only if T1 went out and they never answered
//   T1 + 3 days → T3        only after T2, still no answer
//   T1 + 7 days → T4        only after T3, still no answer
//
// There is NO stored queue. Every run recomputes who is due from live data, so
// a stale plan cannot exist: the moment someone replies, or the team writes to
// them, or a human changes their stage, the next run simply no longer sees
// them. The final word is always the data as it stands minutes before sending.
//
// WHO IS IN: a lead whose T1 the AUTOMATION sent successfully
//   * on/after the chase was switched on (activated_at), or
//   * before it, only if Shailen put the phone on the explicit backfill list
//     (the "eligible + willing to pay" non-repliers he picked by hand).
//   Nobody else from the past is ever swept in.
//
// WHO IS OUT, permanently (a settle row records the reason, so the run report
// says it once and the person is never re-examined):
//   * they replied after T1 — the chase's entire premise is gone
//   * the team messaged them by hand after the chase started — a human owns
//     that conversation now
//   * their stage says a human decided: hot / won / junk / lost / retired
//   * they opted out (STOP)
//   * their T1 never actually reached WhatsApp (the message row failed) — a
//     "gentle reminder" about a message they never received reads as a robot
//   * Meta refused them three times under the healthy-ecosystem rule
//
// WHO WAITS (no settle row; re-examined next run):
//   * not due yet, or inside a healthy-ecosystem pause (4 then 10 days)
//   * outside sending hours — the route holds the whole pass, 10:00–19:00 IST
//
// A follow-up also never tailgates the previous step: however late the
// previous step went out (caps, pauses, downtime), the next one waits at least
// MIN_GAP_MS after it. A backlog must stretch, never bunch.
// =============================================================================

export const CHASE_KEYS = ['no_reply_t2', 'no_reply_t3', 'no_reply_t4'] as const;
export type ChaseKey = (typeof CHASE_KEYS)[number];
/**
 * T1 REDELIVERY. When Meta refuses the T1 itself under the healthy-ecosystem
 * cap (131049 — "this message was not delivered to maintain healthy ecosystem
 * engagement"), the person never saw ANY message, so a "gentle reminder" (T2)
 * would be nonsense. Instead T1 itself is sent again, on Shailen's own
 * three-strike clock: after the 4-day pause, then after the 10-day pause, and
 * after a third refusal never again. Only once a T1 is actually delivered does
 * the T2→T4 chain start counting — anchored on the DELIVERED attempt.
 */
export const T1R_KEY = 'no_reply_t1r' as const;
export type AnyChaseKey = ChaseKey | typeof T1R_KEY;
/** How close a failed message must be to an attempt to count as that attempt failing. */
export const FAIL_MATCH_MS = 30 * 60_000;

const DAY = 86_400_000;
/** Due this long after T1 (shifted later by sending hours and pauses, never earlier). */
export const CHASE_OFFSET_MS: Record<ChaseKey, number> = {
  no_reply_t2: 1 * DAY,
  no_reply_t3: 3 * DAY,
  no_reply_t4: 7 * DAY,
};
/** The step before each step; T2's is the T1 rule itself. */
export const CHASE_PREREQ: Record<ChaseKey, string> = {
  no_reply_t2: 'new_lead_first',
  no_reply_t3: 'no_reply_t2',
  no_reply_t4: 'no_reply_t3',
};
/** A follow-up never goes out closer than this to the step before it. */
export const MIN_GAP_MS = 20 * 3_600_000;
/** T1s older than this are no longer scanned (the chase is long over for them). */
export const CHASE_HORIZON_DAYS = 30;
/** Attempts per step: the first try plus two retries, then the chain ends. */
export const CHASE_MAX_ATTEMPTS = 3;
/** Wait after attempt N (1-based) before attempt N+1. */
export const CHASE_RETRY_BACKOFF_MS = [0, 30 * 60_000, 4 * 3_600_000];

// Settle reasons — written once to relay_automation_sent, shown in reports.
export const SETTLE = {
  replied: 'stopped — they replied after T1',
  team: 'stopped — the team messaged them by hand',
  stage: (s: string) => `stopped — a human set their stage to ${s}`,
  spotlight: 'stopped — starred Spotlight: the Hot & Spotlight nurture looks after them now',
  optedOut: 'stopped — opted out (STOP)',
  t1Failed: (code: string) => `stopped — T1 was never delivered (Meta error ${code}), nothing to follow up`,
  ecosystem: 'stopped — refused by Meta 3 times, after a 4-day and a 10-day pause',
} as const;

/** Lead stages that mean a human has decided — the chase stays out. */
const HUMAN_STAGES = new Set(['hot', 'won', 'junk', 'lost', 'retired']);

export interface T1Done {
  leadId: string | null;
  phoneE164: string;
  sentAtMs: number;
}

export interface ChaseHistRow {
  id: string;
  automation_key: string;
  lead_id: string | null;
  phone_e164: string;
  ok: boolean;
  attempts: number | null;
  sent_at: string;
  error: string | null;
}

/** Everything the planner needs to know about one person, keyed by phone. */
export interface PersonFacts {
  conversationId: string | null;
  lastInboundMs: number | null;
  /** Latest team-sent (human) outbound at/after the chase activation. */
  lastTeamOutMs: number | null;
  /** Every FAILED automated outbound in this conversation, with Meta's code. */
  failTimes: { atMs: number; code: string | null }[];
  stage: string | null;
  /** Starred Spotlight (lead flag or chat star): the HS nurture owns them. */
  spotlight?: boolean;
  name: string | null;
  visaType: string | null;
  suppressed: boolean;
  ecosystem: { stopped: boolean; pausedUntil: string | null } | null;
}

export interface ChaseJob {
  key: AnyChaseKey;
  phoneE164: string;
  leadId: string | null;
  conversationId: string | null;
  name: string | null;
  visaType: string | null;
  /** The earlier failed attempt this job retries, if it is a retry. */
  prior: ChaseHistRow | null;
  dueMs: number;
}

export interface ChaseSettle {
  key: AnyChaseKey;
  phoneE164: string;
  leadId: string | null;
  reason: string;
}

export interface ChasePlanInput {
  now: number;
  /** When the chase was switched on. Nothing anchors earlier than this. */
  activatedAtMs: number;
  /** Successful T1s, the chase's entry ticket. */
  t1Done: T1Done[];
  /** Every chase row ever written (all three keys). */
  history: ChaseHistRow[];
  facts: Map<string, PersonFacts>;
  /** Pre-activation T1 phones Shailen explicitly chose to chase. */
  backfillPhones: Set<string>;
  /** Which steps are switched on; a step off = the chain pauses there. */
  enabledKeys: Set<string>;
}

export interface ChaseUpcoming {
  key: AnyChaseKey;
  phoneE164: string;
  leadId: string | null;
  name: string | null;
  /** When this step becomes due (before sending hours are applied). */
  dueMs: number;
  /** Why it is waiting: not due yet, an ecosystem pause, or the step is off. */
  wait: 'time' | 'ecosystem' | 'off';
}

export interface ChasePlan {
  jobs: ChaseJob[];
  settles: ChaseSettle[];
  skipped: string[];
  /**
   * DISPLAY ONLY — who is next for each step and when. Never read by the
   * sender: jobs and settles are decided exactly as before, this list is just
   * the planner saying out loud what it is waiting for.
   */
  upcoming: ChaseUpcoming[];
}

export function chaseRetryDue(row: Pick<ChaseHistRow, 'attempts' | 'sent_at'>, now: number): boolean {
  const attempts = Math.max(1, row.attempts ?? 1);
  const wait = CHASE_RETRY_BACKOFF_MS[Math.min(attempts, CHASE_RETRY_BACKOFF_MS.length) - 1] ?? 0;
  return now - new Date(row.sent_at).getTime() >= wait;
}

/**
 * WHO NEEDS LOOKING AT ON THIS RUN — decided from the chase's own records
 * alone, before any per-person facts are fetched.
 *
 * On 22 Oct 2026 the chase was switched on and sent NOTHING: fetching facts for
 * all ~900 people in the window, one query after another, took 7–9 s — longer
 * than a run may spend before it stops starting sends. The loader now runs its
 * queries in parallel (≈2 s for everyone), and this filter drops the people
 * whose chase is already OVER by its own records: a step marked stopped, a step
 * out of attempts, or T4 delivered. The planner can never produce a send for
 * them, so leaving them out cannot change who gets a message — a property the
 * tests check across thousands of random cases.
 *
 * Deliberately NOT a "due by the clock" filter: a T1 retry can fall due on a
 * Meta pause that started before the latest attempt, which timestamps alone
 * cannot see. When in doubt, include.
 */
export function chaseCandidates(input: {
  now: number; activatedAtMs: number; t1Done: T1Done[]; history: ChaseHistRow[]; backfillPhones: Set<string>;
}): Set<string> {
  const { now, activatedAtMs, t1Done, history, backfillPhones } = input;
  const hist = new Map<string, ChaseHistRow>();
  for (const h of history) hist.set(`${h.automation_key}:${h.phone_e164}`, h);
  const horizonMs = now - CHASE_HORIZON_DAYS * DAY;
  const over = (r: ChaseHistRow | null) =>
    !!r && !r.ok && ((r.error || '').startsWith('stopped') || (r.attempts ?? 1) >= CHASE_MAX_ATTEMPTS);
  const out = new Set<string>();

  for (const t1 of t1Done) {
    if (!t1.phoneE164 || out.has(t1.phoneE164)) continue;
    const isBackfill = t1.sentAtMs < activatedAtMs;
    if (isBackfill && !backfillPhones.has(t1.phoneE164)) continue;
    if (t1.sentAtMs < horizonMs && !isBackfill) continue;

    if (over(hist.get(`${T1R_KEY}:${t1.phoneE164}`) || null)) continue;     // T1 can never arrive
    let finished = false;
    for (const key of CHASE_KEYS) {
      const row = hist.get(`${key}:${t1.phoneE164}`) || null;
      if (row?.ok) { if (key === 'no_reply_t4') finished = true; continue; } // done → next step
      if (over(row)) finished = true;                                        // chase ended here
      break;
    }
    if (!finished) out.add(t1.phoneE164);
  }
  return out;
}

export function planChase(input: ChasePlanInput): ChasePlan {
  const { now, activatedAtMs, t1Done, history, facts, backfillPhones, enabledKeys } = input;
  const jobs: ChaseJob[] = [];
  const settles: ChaseSettle[] = [];
  const skipped: string[] = [];
  const upcoming: ChaseUpcoming[] = [];

  // One row per person per step (the unique indexes guarantee it in the DB).
  const hist = new Map<string, ChaseHistRow>();
  for (const h of history) hist.set(`${h.automation_key}:${h.phone_e164}`, h);

  const horizonMs = now - CHASE_HORIZON_DAYS * DAY;
  const seen = new Set<string>();

  for (const t1 of t1Done) {
    if (!t1.phoneE164 || seen.has(t1.phoneE164)) continue;
    seen.add(t1.phoneE164);

    // In: T1 after activation, or hand-picked backfill. Everyone else: not ours.
    const isBackfill = t1.sentAtMs < activatedAtMs;
    if (isBackfill && !backfillPhones.has(t1.phoneE164)) continue;
    if (t1.sentAtMs < horizonMs && !isBackfill) continue;

    const f = facts.get(t1.phoneE164);
    if (!f) continue; // facts not loaded for this person on this run — next run

    // ---- the universal stop checks — they apply BEFORE any send, including a
    // T1 redelivery: a person who replied, or whom a human took over, gets
    // nothing automated, full stop.
    const settle = (key: AnyChaseKey, reason: string) =>
      settles.push({ key, phoneE164: t1.phoneE164, leadId: t1.leadId, reason });
    const failNear = (atMs: number) => f.failTimes.find((x) => Math.abs(x.atMs - atMs) <= FAIL_MATCH_MS) || null;

    // ---- DID T1 ACTUALLY ARRIVE? ------------------------------------------
    // Interakt accepting the send is not delivery: Meta can refuse minutes
    // later (the webhook stamps the message row failed). The chase must never
    // "remind" someone about a message they never received.
    const t1r = hist.get(`${T1R_KEY}:${t1.phoneE164}`) || null;
    const lastAttemptMs = t1r?.ok ? new Date(t1r.sent_at).getTime() : t1.sentAtMs;
    const lastAttemptFail = failNear(lastAttemptMs);
    let deliveredMs: number | null = null;
    if (!lastAttemptFail) {
      deliveredMs = lastAttemptMs;              // accepted and never refused → it arrived
    } else {
      // The latest T1 attempt was refused. Redeliver — or stop — by the rules.
      const key = T1R_KEY;
      if (f.lastInboundMs !== null && f.lastInboundMs > t1.sentAtMs) { settle(key, SETTLE.replied); continue; }
      if (f.lastTeamOutMs !== null && f.lastTeamOutMs > Math.max(t1.sentAtMs, activatedAtMs)) { settle(key, SETTLE.team); continue; }
      if (f.stage && HUMAN_STAGES.has(f.stage)) { settle(key, SETTLE.stage(f.stage)); continue; }
      if (f.spotlight) { settle(key, SETTLE.spotlight); continue; }
      if (f.suppressed) { settle(key, SETTLE.optedOut); continue; }
      if (lastAttemptFail.code !== '131049') {
        // Undeliverable number, experiment group, etc. — trying again cannot
        // help; the chat shows the red failure for the team to act on.
        settle(key, SETTLE.t1Failed(lastAttemptFail.code || 'unknown')); continue;
      }
      if (f.ecosystem?.stopped) { settle(key, SETTLE.ecosystem); continue; }
      if (f.ecosystem?.pausedUntil && new Date(f.ecosystem.pausedUntil).getTime() > now) {
        skipped.push(`${f.name || t1.phoneE164}: T1 redelivery waits — ecosystem pause until ${f.ecosystem.pausedUntil.slice(0, 10)}`);
        upcoming.push({ key, phoneE164: t1.phoneE164, leadId: t1.leadId, name: f.name, dueMs: new Date(f.ecosystem.pausedUntil).getTime(), wait: 'ecosystem' });
        continue;
      }
      if (!enabledKeys.has(key)) {                                  // step off — wait
        upcoming.push({ key, phoneE164: t1.phoneE164, leadId: t1.leadId, name: f.name, dueMs: now, wait: 'off' });
        continue;
      }
      if (t1r && !t1r.ok && (t1r.attempts ?? 1) >= CHASE_MAX_ATTEMPTS) continue;
      if (t1r && !t1r.ok && !chaseRetryDue(t1r, now)) continue;     // in-flight/timeout back-off
      jobs.push({
        key, phoneE164: t1.phoneE164, leadId: t1.leadId, conversationId: f.conversationId,
        name: f.name, visaType: f.visaType, prior: t1r, dueMs: now,
      });
      continue;                                                     // nothing else until T1 lands
    }

    // The clock starts at the DELIVERED T1 — but for the backfill at
    // activation: those people are being picked up late on purpose, not owed
    // three messages at once.
    const anchorMs = Math.max(deliveredMs, activatedAtMs);

    // Walk the chain to the first step that still needs doing.
    let prevSentMs = deliveredMs;
    let chainOk = true;
    for (const key of CHASE_KEYS) {
      const row = hist.get(`${key}:${t1.phoneE164}`) || null;

      if (row?.ok) { prevSentMs = new Date(row.sent_at).getTime(); continue; }  // done → next step

      // A settle or an exhausted retry ends the chain for good.
      if (row && (row.error || '').startsWith('stopped')) { chainOk = false; break; }
      if (row && (row.attempts ?? 1) >= CHASE_MAX_ATTEMPTS) { chainOk = false; break; }

      // This is the step to do. Is it due?
      const dueMs = Math.max(anchorMs + CHASE_OFFSET_MS[key], prevSentMs + MIN_GAP_MS);
      if (now < dueMs) {                                                        // not yet — wait
        upcoming.push({ key, phoneE164: t1.phoneE164, leadId: t1.leadId, name: f.name, dueMs, wait: 'time' });
        chainOk = false; break;
      }

      if (!enabledKeys.has(key)) {                                              // step off — chain waits here
        // Only people the stop checks would still let through are "waiting".
        const stopped = (f.lastInboundMs !== null && f.lastInboundMs > t1.sentAtMs)
          || (f.lastTeamOutMs !== null && f.lastTeamOutMs > Math.max(t1.sentAtMs, activatedAtMs))
          || (!!f.stage && HUMAN_STAGES.has(f.stage)) || !!f.spotlight || f.suppressed || !!f.ecosystem?.stopped;
        if (!stopped) upcoming.push({ key, phoneE164: t1.phoneE164, leadId: t1.leadId, name: f.name, dueMs, wait: 'off' });
        chainOk = false; break;
      }

      // ---- the stop checks, in the order a human would ask them ------------
      if (f.lastInboundMs !== null && f.lastInboundMs > t1.sentAtMs) {
        settles.push({ key, phoneE164: t1.phoneE164, leadId: t1.leadId, reason: SETTLE.replied });
        chainOk = false; break;
      }
      if (f.lastTeamOutMs !== null && f.lastTeamOutMs > Math.max(t1.sentAtMs, activatedAtMs)) {
        settles.push({ key, phoneE164: t1.phoneE164, leadId: t1.leadId, reason: SETTLE.team });
        chainOk = false; break;
      }
      if (f.stage && HUMAN_STAGES.has(f.stage)) {
        settles.push({ key, phoneE164: t1.phoneE164, leadId: t1.leadId, reason: SETTLE.stage(f.stage) });
        chainOk = false; break;
      }
      // ONE ENGINE PER PERSON. Hot leads already leave the chase via the stage
      // check above; a Spotlight star on a lead still marked Cold must too —
      // otherwise the same person could be in the T-chase AND the HS nurture.
      if (f.spotlight) {
        settles.push({ key, phoneE164: t1.phoneE164, leadId: t1.leadId, reason: SETTLE.spotlight });
        chainOk = false; break;
      }
      if (f.suppressed) {
        settles.push({ key, phoneE164: t1.phoneE164, leadId: t1.leadId, reason: SETTLE.optedOut });
        chainOk = false; break;
      }
      if (f.ecosystem?.stopped) {
        settles.push({ key, phoneE164: t1.phoneE164, leadId: t1.leadId, reason: SETTLE.ecosystem });
        chainOk = false; break;
      }
      if (f.ecosystem?.pausedUntil && new Date(f.ecosystem.pausedUntil).getTime() > now) {
        skipped.push(`${f.name || t1.phoneE164}: ${key} waits — ecosystem pause until ${f.ecosystem.pausedUntil.slice(0, 10)}`);
        upcoming.push({ key, phoneE164: t1.phoneE164, leadId: t1.leadId, name: f.name, dueMs: new Date(f.ecosystem.pausedUntil).getTime(), wait: 'ecosystem' });
        chainOk = false; break;
      }

      // A retry must respect its back-off.
      if (row && !chaseRetryDue(row, now)) { chainOk = false; break; }

      jobs.push({
        key, phoneE164: t1.phoneE164, leadId: t1.leadId, conversationId: f.conversationId,
        name: f.name, visaType: f.visaType, prior: row, dueMs,
      });
      chainOk = false; break;                                                   // one step per person per run
    }
    void chainOk;
  }

  // Longest-waiting first, so a backlog clears oldest-first under the caps.
  jobs.sort((a, b) => a.dueMs - b.dueMs);
  upcoming.sort((a, b) => a.dueMs - b.dueMs);
  return { jobs, settles, skipped, upcoming };
}
