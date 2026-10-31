// =============================================================================
// THE COLD LEAD CHASE — CC1 → CC8, one message a week, until they speak.
// -----------------------------------------------------------------------------
// Pure: data in, decisions out, no I/O — the same discipline as the T2→T4
// planner and the HS nurture, for the same reason: every rule below is tested
// without a database, and the engine can never drift from what the tests prove.
//
// THE SHAPE (Shailen, 31 Oct 2026):
//
//   WHO      the leads he tagged cold-p1 / cold-p2 / cold-p3 (336 + 319 + 9),
//            plus — automatically — anyone whose T4 went out and who stayed
//            silent: the T chase hands its non-repliers over, nobody is ever
//            re-tagged by hand. Never anyone not eligible, never anyone who
//            said no to paying, never a sample lead.
//   ORDER    p1 first (strong fit, said YES to paying), then p2 (maybe), then
//            p3 (unknown); within a tier the newest lead first.
//   START    only once they are properly quiet: no reply from them in 14 days
//            and nothing from us in 7 (which also keeps the promised 7-day gap
//            after T4). At most COLD_START_CAP people begin CC1 per day.
//   CADENCE  CC1, then CC2 … CC8, 7 days apart, 10am–7pm IST, paced evenly
//            through the day instead of one burst.
//   STOPS    for good — a reply, a team message, STOP, a human-decided stage
//            (won/lost/junk/retired/invoice_sent), or three Meta refusals.
//            Hot or Spotlight → the HS nurture owns them; the cold chase
//            steps out. CC8 is the last word either way.
//   META     a "healthy ecosystem" refusal resends the SAME CC after the
//            4-day pause, then the 10-day pause; the third refusal ends it.
//            A number that cannot receive WhatsApp at all ends it immediately.
//
// There is NO stored queue. Every run recomputes who is due from live data, so
// a stale plan cannot exist: the moment someone replies, the next run simply no
// longer sees them. History rows live in relay_automation_sent under keys
// cold_cc1…cold_cc8 (one row per person per step, enforced by the unique
// indexes), plus one cold_cc_flag row per person for the happy ending.
// =============================================================================

export const COLD_STEPS = 8;
export const COLD_KEYS = Array.from({ length: COLD_STEPS }, (_, i) => `cold_cc${i + 1}`);
/** The rule row that holds the engine's switch, cap and activation. */
export const COLD_RULE_KEY = 'cold_cc';
/** The per-person "series complete" record's key (the step keys stay clean). */
export const COLD_FLAG_KEY = 'cold_cc_flag';
/** Which template each step sends. */
export const templateOfColdStep = (key: string): string => key.replace('cold_', '');

const DAY = 86_400_000;
/** Between consecutive CC messages: one a week, exactly as agreed. */
export const COLD_STEP_GAP_MS = 7 * DAY;
/** CC1 waits until they have been quiet this long (their side). */
export const COLD_INBOUND_QUIET_MS = 14 * DAY;
/** …and until WE have been quiet this long (any message from us, any engine). */
export const COLD_OUTBOUND_QUIET_MS = 7 * DAY;
/** How many people may BEGIN the series (CC1) per day. */
export const COLD_START_CAP = 50;
export const COLD_MAX_ATTEMPTS = 3;   // per step: first try plus two retries
export const COLD_RETRY_BACKOFF_MS = [0, 30 * 60_000, 4 * 3_600_000];

/** A failure this close to a step's record is that step's own message failing. */
export const COLD_FAIL_MATCH_MS = 30 * 60_000;
/** Codes that mean the number can never receive WhatsApp: no point retrying. */
const UNREACHABLE_CODES = new Set(['131026', 'bad_phone']);

export const COLD_SETTLE = {
  replied: 'stopped — they replied: the team owns this conversation now',
  team: 'stopped — the team messaged them by hand',
  stage: (s: string) => `stopped — a human set their stage to ${s}`,
  hotOrSpotlight: 'stopped — now Hot/Spotlight: the Hot & Spotlight nurture looks after them',
  optedOut: 'stopped — opted out (STOP)',
  unreachable: (code: string) => `stopped — their number cannot receive WhatsApp (Meta error ${code})`,
  ecosystem: 'stopped — refused by Meta 3 times, after a 4-day and a 10-day pause',
  finished: 'series complete — all 8 messages sent',
} as const;

/** Stages that end the series for good (a human closed the file). */
const OVER_STAGES = new Set(['won', 'lost', 'junk', 'retired', 'invoice_sent']);
/** Stages the cold chase is FOR. Anything else (bar the two rules above) holds. */
const AUDIENCE_STAGES = new Set(['cold', 'not_responding']);

export interface ColdHistRow {
  id: string;
  automation_key: string;
  lead_id: string | null;
  phone_e164: string;
  ok: boolean;
  attempts: number | null;
  sent_at: string;
  error: string | null;
}

/** One cold lead, with everything the decision needs. */
export interface ColdPerson {
  leadId: string;
  phoneE164: string;
  name: string | null;
  visaType: string | null;
  stage: string | null;
  spotlight: boolean;
  /** 1 = cold-p1 / eligible+paying · 2 = cold-p2 / maybe · 3 = the rest. */
  priority: 1 | 2 | 3;
  createdAtMs: number;
  conversationId: string | null;
  /** Latest message FROM them on ANY of their conversations. */
  lastInboundMs: number | null;
  /** Latest message from US (human or any engine) on ANY of their conversations. */
  lastOutboundMs: number | null;
  /** Latest team-sent (human) outbound at/after the cold chase activation. */
  lastTeamOutMs: number | null;
  suppressed: boolean;
  ecosystem: { stopped: boolean; pausedUntil: string | null } | null;
  /** Automated messages WhatsApp refused AFTER Interakt accepted them. */
  failTimes?: { atMs: number; code: string | null }[];
}

export interface ColdJob {
  key: string;
  phoneE164: string;
  leadId: string;
  conversationId: string | null;
  name: string | null;
  visaType: string | null;
  priority: 1 | 2 | 3;
  /** True when this send BEGINS the series (CC1) — the start cap counts these. */
  start: boolean;
  prior: ColdHistRow | null;
  dueMs: number;
  createdAtMs: number;
}

export interface ColdSettle { key: string; phoneE164: string; leadId: string; reason: string }

export interface ColdUpcoming {
  key: string;
  phoneE164: string;
  leadId: string;
  name: string | null;
  priority: 1 | 2 | 3;
  dueMs: number;
  wait: 'time' | 'quiet' | 'ecosystem' | 'off';
}

export interface ColdPlan {
  jobs: ColdJob[];
  settles: ColdSettle[];
  skipped: string[];
  /** DISPLAY ONLY — who waits for what; never read by the sender. */
  upcoming: ColdUpcoming[];
}

export function coldRetryDue(row: Pick<ColdHistRow, 'attempts' | 'sent_at'>, now: number): boolean {
  const attempts = Math.max(1, row.attempts ?? 1);
  const wait = COLD_RETRY_BACKOFF_MS[Math.min(attempts, COLD_RETRY_BACKOFF_MS.length) - 1] ?? 0;
  return now - new Date(row.sent_at).getTime() >= wait;
}

/**
 * WHO NEEDS LOOKING AT ON THIS RUN — decided from the engine's own records
 * alone, before any per-person facts are fetched. The audience is ~1,600 people
 * and growing; fetching conversations and messages for all of them every five
 * minutes is exactly how the old chase starved. This filter keeps:
 *
 *   * everyone mid-series whose NEXT act could be near: a failed/in-flight row
 *     (retry back-off is minutes–hours), or a last delivered step ≥ 4 days old
 *     (a Meta-refused step re-arms at +4 days; a normal next step at +7) —
 *     people loaded a little early are simply reported as waiting;
 *   * nobody whose series is already over by its own records.
 *
 * People with NO history (potential starters) are ranked by the caller — the
 * loader takes the top slice by priority, since at most COLD_START_CAP can
 * begin per day anyway.
 */
export function coldSeriesCandidates(input: { now: number; history: ColdHistRow[] }): {
  /** lead ids worth fetching facts for on a tick run */
  active: Set<string>;
  /** lead ids whose series is over (stopped, exhausted, or finished) */
  over: Set<string>;
} {
  const { now, history } = input;
  const byLead = new Map<string, Map<string, ColdHistRow>>();
  for (const h of history) {
    if (!h.lead_id) continue;
    if (!byLead.has(h.lead_id)) byLead.set(h.lead_id, new Map());
    const cur = byLead.get(h.lead_id)!;
    // One row per step in the DB; keep the newest defensively if duplicates appear.
    const prev = cur.get(h.automation_key);
    if (!prev || h.sent_at > prev.sent_at) cur.set(h.automation_key, h);
  }
  const active = new Set<string>();
  const over = new Set<string>();
  for (const [leadId, rows] of byLead) {
    if (rows.has(COLD_FLAG_KEY)) { over.add(leadId); continue; }
    let verdict: 'active' | 'over' | 'done' = 'done';
    let lastDoneMs = 0;
    for (const key of COLD_KEYS) {
      const row = rows.get(key) || null;
      if (row?.ok) { lastDoneMs = Math.max(lastDoneMs, new Date(row.sent_at).getTime()); continue; }
      if (row && (row.error || '').startsWith('skipped')) { lastDoneMs = Math.max(lastDoneMs, new Date(row.sent_at).getTime()); continue; }
      if (row && ((row.error || '').startsWith('stopped') || (row.attempts ?? 1) >= COLD_MAX_ATTEMPTS)) { verdict = 'over'; break; }
      verdict = 'active'; break;
    }
    if (verdict === 'over') { over.add(leadId); continue; }
    if (verdict === 'done') { over.add(leadId); continue; }   // finished: flag write pending, facts not needed to send
    // Mid-series. Near enough to matter?
    const open = COLD_KEYS.map((k) => rows.get(k)).find((r) => r && !r.ok && !(r.error || '').startsWith('skipped'));
    if (open) { active.add(leadId); continue; }               // failed / in flight: back-off is short
    if (now - lastDoneMs >= 4 * DAY) active.add(leadId);      // refusal re-arm (+4d) or next step (+7d)
  }
  return { active, over };
}

export function planCold(input: {
  now: number;
  enabled: boolean;
  activatedAtMs: number;
  people: ColdPerson[];
  /** Every cold_cc* row for these people (flag rows included). */
  history: ColdHistRow[];
}): ColdPlan {
  const { now, enabled, activatedAtMs, people, history } = input;
  const jobs: ColdJob[] = [];
  const settles: ColdSettle[] = [];
  const skipped: string[] = [];
  const upcoming: ColdUpcoming[] = [];

  // History is matched by LEAD, not phone: a person can change which number
  // they chat from mid-series, and their record must follow them.
  const hist = new Map<string, ColdHistRow>();
  for (const h of history) {
    if (!h.lead_id) continue;
    const k = `${h.automation_key}:${h.lead_id}`;
    const prev = hist.get(k);
    if (!prev || h.sent_at > prev.sent_at) hist.set(k, h);
  }

  const seenLead = new Set<string>();
  const seenPhone = new Set<string>();
  for (const p of people) {
    if (!p.leadId || !p.phoneE164) continue;
    if (seenLead.has(p.leadId) || seenPhone.has(p.phoneE164)) continue;
    seenLead.add(p.leadId);
    seenPhone.add(p.phoneE164);
    const who = p.name || p.phoneE164;
    const settle = (key: string, reason: string) => settles.push({ key, phoneE164: p.phoneE164, leadId: p.leadId, reason });
    const wait = (key: string, dueMs: number, why: ColdUpcoming['wait']) =>
      upcoming.push({ key, phoneE164: p.phoneE164, leadId: p.leadId, name: p.name, priority: p.priority, dueMs, wait: why });

    // ---- where in the series are they? -------------------------------------
    // A step counts as DONE when it was sent (ok); a 'stopped' row anywhere, or
    // a step out of attempts, ends everything. ACCEPTED IS NOT DELIVERED: if
    // WhatsApp refused a step's message after Interakt took it, that step is
    // NOT done — the SAME CC is sent again after the Meta pause, and the series
    // never skips past a message the person never saw. A number that cannot
    // receive WhatsApp at all ends the series instead.
    if (hist.get(`${COLD_FLAG_KEY}:${p.leadId}`)) continue;       // recorded as finished
    let key: string | null = null;
    let prior: ColdHistRow | null = null;
    let prevDoneMs: number | null = null;       // when the previous step actually went
    let startedMs: number | null = null;        // when CC1 first went (the series began)
    let over = false;
    let unreachable: string | null = null;
    for (const k of COLD_KEYS) {
      const row = hist.get(`${k}:${p.leadId}`) || null;
      if (row?.ok) {
        const at = new Date(row.sent_at).getTime();
        const refused = (p.failTimes || []).filter((f) => Math.abs(f.atMs - at) <= COLD_FAIL_MATCH_MS)
          .sort((a, b) => b.atMs - a.atMs)[0];
        if (refused) {
          if (UNREACHABLE_CODES.has(refused.code || '')) { unreachable = refused.code || 'unknown'; key = k; break; }
          key = k; prior = row;
          if (startedMs === null) startedMs = at;
          break;
        }
        if (startedMs === null) startedMs = at;
        prevDoneMs = at;
        continue;
      }
      if (row && (row.error || '').startsWith('skipped')) { prevDoneMs = new Date(row.sent_at).getTime(); continue; }
      if (row && (row.error || '').startsWith('stopped')) { over = true; break; }
      if (row && (row.attempts ?? 1) >= COLD_MAX_ATTEMPTS) { over = true; break; }
      key = k; prior = row; break;
    }
    if (over) continue;                                           // ended earlier; recorded then
    if (!key) {
      // All eight went. Write the happy ending once, on its own key.
      settles.push({ key: COLD_FLAG_KEY, phoneE164: p.phoneE164, leadId: p.leadId, reason: COLD_SETTLE.finished });
      continue;
    }
    const started = startedMs !== null;

    // ---- the gates, in the order a human would ask them --------------------
    if (unreachable) { settle(key, COLD_SETTLE.unreachable(unreachable)); continue; }
    if (OVER_STAGES.has(p.stage || '')) { settle(key, COLD_SETTLE.stage(p.stage || '')); continue; }
    // ONE ENGINE PER PERSON. Hot or Spotlight → the HS nurture owns them now.
    if (p.stage === 'hot' || p.spotlight) { settle(key, COLD_SETTLE.hotOrSpotlight); continue; }
    if (p.suppressed) { settle(key, COLD_SETTLE.optedOut); continue; }
    if (started) {
      // Mid-series, a single word from either side ends it for good.
      if (p.lastInboundMs !== null && p.lastInboundMs > (startedMs as number)) { settle(key, COLD_SETTLE.replied); continue; }
      if (p.lastTeamOutMs !== null && p.lastTeamOutMs > (startedMs as number)) { settle(key, COLD_SETTLE.team); continue; }
    }
    // Drifted out of the audience (some other stage, no stop rule): hold silently —
    // a human may move them back to Cold, and the series then continues.
    if (!AUDIENCE_STAGES.has(p.stage || '')) continue;
    if (p.ecosystem?.stopped) { settle(key, COLD_SETTLE.ecosystem); continue; }

    // ---- when is this step due? ---------------------------------------------
    let dueMs: number;
    let quietGated = false;
    if (!started) {
      // CC1: only once they are properly quiet, and never before the switch
      // was first turned on.
      const inboundQuietMs = p.lastInboundMs === null ? 0 : p.lastInboundMs + COLD_INBOUND_QUIET_MS;
      const outboundQuietMs = p.lastOutboundMs === null ? 0 : p.lastOutboundMs + COLD_OUTBOUND_QUIET_MS;
      dueMs = Math.max(inboundQuietMs, outboundQuietMs, activatedAtMs);
      quietGated = dueMs > now && dueMs === Math.max(inboundQuietMs, outboundQuietMs);
    } else {
      dueMs = (prevDoneMs ?? startedMs ?? now) + COLD_STEP_GAP_MS;
    }

    if (p.ecosystem?.pausedUntil && new Date(p.ecosystem.pausedUntil).getTime() > now) {
      skipped.push(`${who}: ${key} waits — ecosystem pause until ${p.ecosystem.pausedUntil.slice(0, 10)}`);
      wait(key, Math.max(dueMs, new Date(p.ecosystem.pausedUntil).getTime()), 'ecosystem');
      continue;
    }
    if (now < dueMs) { wait(key, dueMs, quietGated ? 'quiet' : 'time'); continue; }
    if (!enabled) { wait(key, dueMs, 'off'); continue; }
    if (prior && !prior.ok && !coldRetryDue(prior, now)) continue;   // in-flight back-off

    jobs.push({
      key, phoneE164: p.phoneE164, leadId: p.leadId, conversationId: p.conversationId,
      name: p.name, visaType: p.visaType, priority: p.priority,
      start: !started, prior, dueMs, createdAtMs: p.createdAtMs,
    });
  }

  // People already mid-series are owed their next message before anyone new
  // begins; longest-waiting first. New starts then go p1 → p2 → p3, newest
  // lead first — exactly the order Shailen set.
  jobs.sort((a, b) =>
    Number(a.start) - Number(b.start)
    || (a.start
      ? (a.priority - b.priority || b.createdAtMs - a.createdAtMs)
      : a.dueMs - b.dueMs));
  upcoming.sort((a, b) => a.dueMs - b.dueMs);
  return { jobs, settles, skipped, upcoming };
}

/**
 * EVEN PACING THROUGH THE DAY. How many messages the engine may have sent by
 * `now`, spreading `dailyCap` evenly across the 10:00–19:00 IST window instead
 * of one morning burst (bursts both look robotic and run into Meta's per-user
 * marketing limits harder). Cap 0 = no limit, so no pacing either.
 */
export function coldPaceAllowance(dailyCap: number, istMinutesSince10am: number): number {
  if (dailyCap <= 0) return Number.MAX_SAFE_INTEGER;
  const windowMin = 9 * 60;
  const frac = Math.min(1, Math.max(0, istMinutesSince10am) / windowMin);
  return Math.min(dailyCap, Math.ceil(dailyCap * frac));
}
