// =============================================================================
// THE HOT & SPOTLIGHT NURTURE — HS1 → HS8, one value message every few days.
// -----------------------------------------------------------------------------
// Pure: data in, decisions out, no I/O — the same discipline as the T2→T4
// planner, for the same reason: every rule below is tested without a database,
// and the engine can never drift from what the tests prove.
//
// THE SHAPE (Shailen, 22 Oct 2026):
//
//   WHO      every lead marked Hot or Spotlight. Never Won/Lost/Junk/retired,
//            never anyone who said STOP.
//   START    after 3 full days of silence — no message in EITHER direction on
//            ANY of their conversations.
//   CADENCE  HS1, then HS2 … HS8, at least 4 days apart. After HS8 it ends.
//   REPLY    pauses the series by itself: a reply resets the silence clock, so
//            nothing sends while the team talks to them. Once quiet for 3 days
//            again, it continues FROM THE NEXT message — the same HS is never
//            sent twice (the database's unique indexes also guarantee it).
//   PAUSE    a human can pause one person (chat side panel or the Automation
//            tab) and resume them later. Paused = nothing sends, nothing lost.
//   SKIP     a human can skip one step for one person; the series moves on.
//   META     a "healthy ecosystem" refusal retries the SAME message after the
//            4-day pause, then the 10-day pause; a third refusal stops the
//            series for that person for good. It never skips ahead.
//   LEAVES   stage moves off Hot (and not Spotlight) → the series HOLDS
//            silently (no settle — a human may flip them back); Won/Lost/Junk →
//            over for good, recorded.
//
// History rows live in relay_automation_sent under keys nurture_hs1…nurture_hs8
// (one row per person per step, enforced by the unique indexes) plus one
// optional nurture_hs_pause row per person that a human toggles.
// =============================================================================

export const NURTURE_STEPS = 8;
export const NURTURE_KEYS = Array.from({ length: NURTURE_STEPS }, (_, i) => `nurture_hs${i + 1}`);
/** The rule row that holds the engine's switch, cap and activation. */
export const NURTURE_RULE_KEY = 'nurture_hs';
/** The per-person pause flag's key in relay_automation_sent. */
export const NURTURE_PAUSE_KEY = 'nurture_hs_pause';
/** Which template each step sends. */
export const templateOfStep = (key: string): string => key.replace('nurture_', '');

const DAY = 86_400_000;
export const SILENCE_MS = 3 * DAY;       // quiet this long before anything sends
export const CADENCE_MS = 4 * DAY;       // between consecutive HS messages
export const NURTURE_MAX_ATTEMPTS = 3;   // per step: first try plus two retries
export const NURTURE_RETRY_BACKOFF_MS = [0, 30 * 60_000, 4 * 3_600_000];

/** A failure this close to a step's record is that step's own message failing. */
export const NURTURE_FAIL_MATCH_MS = 30 * 60_000;
/** Codes that mean the number can never receive WhatsApp: no point retrying. */
const UNREACHABLE_CODES = new Set(['131026', 'bad_phone']);

export const NURTURE_SETTLE = {
  unreachable: (code: string) => `stopped — their number cannot receive WhatsApp (Meta error ${code})`,
  stage: (s: string) => `stopped — a human set their stage to ${s}`,
  optedOut: 'stopped — opted out (STOP)',
  ecosystem: 'stopped — refused by Meta 3 times, after a 4-day and a 10-day pause',
  finished: 'series complete — all 8 messages sent',
} as const;

/** Stages that end the series for good (a human closed the file). */
const OVER_STAGES = new Set(['won', 'lost', 'junk', 'retired']);

export interface NurtureHistRow {
  id: string;
  automation_key: string;
  lead_id: string | null;
  phone_e164: string;
  ok: boolean;
  attempts: number | null;
  sent_at: string;
  error: string | null;
}

/** One Hot/Spotlight lead, with everything the decision needs. */
export interface NurturePerson {
  leadId: string;
  phoneE164: string;
  name: string | null;
  visaType: string | null;
  stage: string | null;
  spotlight: boolean;
  conversationId: string | null;
  /** Latest message in EITHER direction on ANY of their conversations. */
  lastActivityMs: number | null;
  suppressed: boolean;
  ecosystem: { stopped: boolean; pausedUntil: string | null } | null;
  paused: boolean;
  /**
   * Automated messages to this person that WhatsApp refused AFTER Interakt
   * accepted them. Interakt saying "ok" is not delivery: a step whose own
   * message was refused is not done.
   */
  failTimes?: { atMs: number; code: string | null }[];
}

export interface NurtureJob {
  key: string;
  phoneE164: string;
  leadId: string;
  conversationId: string | null;
  name: string | null;
  visaType: string | null;
  spotlight: boolean;
  prior: NurtureHistRow | null;
  /** When this became (or becomes) due — for ordering and the Next up list. */
  dueMs: number;
}

export interface NurtureSettle { key: string; phoneE164: string; leadId: string; reason: string }

export interface NurtureUpcoming {
  key: string;
  phoneE164: string;
  leadId: string;
  name: string | null;
  spotlight: boolean;
  dueMs: number;
  wait: 'time' | 'silence' | 'ecosystem' | 'paused' | 'off';
}

export interface NurturePlan {
  jobs: NurtureJob[];
  settles: NurtureSettle[];
  skipped: string[];
  /** DISPLAY ONLY — who waits for what; never read by the sender. */
  upcoming: NurtureUpcoming[];
}

export function nurtureRetryDue(row: Pick<NurtureHistRow, 'attempts' | 'sent_at'>, now: number): boolean {
  const attempts = Math.max(1, row.attempts ?? 1);
  const wait = NURTURE_RETRY_BACKOFF_MS[Math.min(attempts, NURTURE_RETRY_BACKOFF_MS.length) - 1] ?? 0;
  return now - new Date(row.sent_at).getTime() >= wait;
}

export function planNurture(input: {
  now: number;
  enabled: boolean;
  people: NurturePerson[];
  /** Every nurture_hs* row ever written (pause rows included). */
  history: NurtureHistRow[];
}): NurturePlan {
  const { now, enabled, people, history } = input;
  const jobs: NurtureJob[] = [];
  const settles: NurtureSettle[] = [];
  const skipped: string[] = [];
  const upcoming: NurtureUpcoming[] = [];

  const hist = new Map<string, NurtureHistRow>();
  for (const h of history) hist.set(`${h.automation_key}:${h.phone_e164}`, h);

  const seen = new Set<string>();
  for (const p of people) {
    if (!p.phoneE164 || seen.has(p.phoneE164)) continue;
    seen.add(p.phoneE164);
    const who = p.name || p.phoneE164;
    const settle = (key: string, reason: string) => settles.push({ key, phoneE164: p.phoneE164, leadId: p.leadId, reason });
    const wait = (key: string, dueMs: number, why: NurtureUpcoming['wait']) =>
      upcoming.push({ key, phoneE164: p.phoneE164, leadId: p.leadId, name: p.name, spotlight: p.spotlight, dueMs, wait: why });

    // ---- where in the series are they? -------------------------------------
    // A step counts as DONE when it was sent (ok) or a human skipped it; either
    // way the series moves on. A 'stopped' row anywhere ends everything.
    let key: string | null = null;
    let prior: NurtureHistRow | null = null;
    let prevDoneMs: number | null = null;      // when the previous step went out
    let over = false;
    let unreachable: string | null = null;
    for (const k of NURTURE_KEYS) {
      const row = hist.get(`${k}:${p.phoneE164}`) || null;
      // ACCEPTED IS NOT DELIVERED. If WhatsApp refused this step's message
      // after Interakt took it, the step is NOT done: the SAME HS is sent
      // again — after the Meta pause for a "healthy ecosystem" refusal, after
      // the normal back-off for a passing error — and the series never skips
      // ahead past a message the person never saw. A number that cannot
      // receive WhatsApp at all ends the series instead.
      if (row?.ok) {
        const at = new Date(row.sent_at).getTime();
        const refused = (p.failTimes || []).filter((f) => Math.abs(f.atMs - at) <= NURTURE_FAIL_MATCH_MS)
          .sort((a, b) => b.atMs - a.atMs)[0];
        if (refused) {
          if (UNREACHABLE_CODES.has(refused.code || '')) { unreachable = refused.code || 'unknown'; key = k; break; }
          key = k; prior = row; break;
        }
      }
      if (row?.ok || (row && (row.error || '').startsWith('skipped'))) { prevDoneMs = new Date(row.sent_at).getTime(); continue; }
      if (row && (row.error || '').startsWith('stopped')) { over = true; break; }
      if (row && (row.attempts ?? 1) >= NURTURE_MAX_ATTEMPTS) { over = true; break; }
      key = k; prior = row; break;
    }
    if (over) continue;                                           // ended earlier; recorded then
    if (!key) {
      // All eight went. Write the happy ending once (on the last step's key the
      // unique index would clash, so it rides on the pause key's namespace).
      if (!hist.get(`${NURTURE_PAUSE_KEY}:${p.phoneE164}`)) {
        settles.push({ key: NURTURE_PAUSE_KEY, phoneE164: p.phoneE164, leadId: p.leadId, reason: NURTURE_SETTLE.finished });
      }
      continue;
    }

    // ---- the gates, in the order a human would ask them --------------------
    if (unreachable) { settle(key, NURTURE_SETTLE.unreachable(unreachable)); continue; }
    if (OVER_STAGES.has(p.stage || '')) { settle(key, NURTURE_SETTLE.stage(p.stage || '')); continue; }
    if (p.stage !== 'hot' && !p.spotlight) continue;              // drifted out of the audience: hold silently
    if (p.suppressed) { settle(key, NURTURE_SETTLE.optedOut); continue; }
    if (p.ecosystem?.stopped) { settle(key, NURTURE_SETTLE.ecosystem); continue; }

    const silenceReadyMs = p.lastActivityMs === null ? now : p.lastActivityMs + SILENCE_MS;
    const cadenceReadyMs = prevDoneMs === null ? now : prevDoneMs + CADENCE_MS;
    const dueMs = Math.max(silenceReadyMs, cadenceReadyMs);

    if (p.paused) { wait(key, Math.max(dueMs, now), 'paused'); continue; }
    if (p.ecosystem?.pausedUntil && new Date(p.ecosystem.pausedUntil).getTime() > now) {
      skipped.push(`${who}: ${key} waits — ecosystem pause until ${p.ecosystem.pausedUntil.slice(0, 10)}`);
      wait(key, new Date(p.ecosystem.pausedUntil).getTime(), 'ecosystem');
      continue;
    }
    if (now < dueMs) { wait(key, dueMs, dueMs === silenceReadyMs && silenceReadyMs > cadenceReadyMs ? 'silence' : 'time'); continue; }
    if (!enabled) { wait(key, dueMs, 'off'); continue; }
    if (prior && !prior.ok && !nurtureRetryDue(prior, now)) continue;   // in-flight back-off

    jobs.push({
      key, phoneE164: p.phoneE164, leadId: p.leadId, conversationId: p.conversationId,
      name: p.name, visaType: p.visaType, spotlight: p.spotlight, prior, dueMs,
    });
  }

  // Spotlight first — the VIPs are never the ones a tight cap postpones. Then
  // whoever has waited longest.
  jobs.sort((a, b) => Number(b.spotlight) - Number(a.spotlight) || a.dueMs - b.dueMs);
  upcoming.sort((a, b) => a.dueMs - b.dueMs);
  return { jobs, settles, skipped, upcoming };
}
