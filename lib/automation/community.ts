// =============================================================================
// THE COMMUNITY INVITE — one free message after a real conversation ends,
// inviting the person to Migrizo's WhatsApp Channel.
// -----------------------------------------------------------------------------
// Pure: data in, decisions out, no I/O — the same discipline as every other
// engine, so every rule below is tested without a database.
//
// THE SHAPE (Shailen, 1 Nov 2026):
//
//   WHO      anyone we ACTUALLY talked to: they wrote to us AND a human on the
//            team replied in this conversation (automation messages alone never
//            qualify anyone). Past talkers are in too — they qualify the next
//            time they chat, when their window opens again.
//   WHEN     3 quiet hours after the conversation ends, while their last
//            message is still under 20 hours old — so the message rides the
//            FREE 24-hour window (no template, no Meta marketing limits),
//            with a 4-hour safety margin. If the window closes first, they
//            simply wait for their next conversation.
//   WHAT     the channel-invite quick reply, personalised with their name —
//            ONCE per person EVER (the unique indexes make twice impossible).
//   NEVER    anyone who said STOP, anyone Junk or Lost, anyone who got any
//            automated message in the last 20 hours (the cross-engine rule,
//            applied in the route before sending).
//
// History rows live in relay_automation_sent under the key community_invite.
// =============================================================================

export const COMMUNITY_KEY = 'community_invite';
/** The rule row that holds the switch, cap and the quick reply to send. */
export const COMMUNITY_RULE_KEY = COMMUNITY_KEY;

const HOUR = 3_600_000;
/** The conversation must be over: nothing in either direction for this long. */
export const COMMUNITY_QUIET_MS = 3 * HOUR;
/** Send only while their last message is younger than this (24h window − margin). */
export const COMMUNITY_WINDOW_SAFE_MS = 20 * HOUR;
/** A human reply this recent means the team really talked in THIS conversation. */
export const COMMUNITY_EPISODE_MS = 24 * HOUR;
export const COMMUNITY_MAX_ATTEMPTS = 3;
export const COMMUNITY_RETRY_BACKOFF_MS = [0, 30 * 60_000, 4 * HOUR];

export const COMMUNITY_SETTLE = {
  optedOut: 'stopped — opted out (STOP)',
  stage: (s: string) => `stopped — stage ${s}: not someone to invite`,
} as const;

/** Stages whose people should never get a community invite. */
const NEVER_STAGES = new Set(['junk', 'lost']);

export interface CommunityHistRow {
  id: string;
  automation_key: string;
  lead_id: string | null;
  phone_e164: string;
  ok: boolean;
  attempts: number | null;
  sent_at: string;
  error: string | null;
}

/** One recent talker, with everything the decision needs. */
export interface CommunityPerson {
  conversationId: string;
  phoneE164: string;
  leadId: string | null;
  name: string | null;
  visaType: string | null;
  stage: string | null;
  /** Their latest message to us. */
  lastInboundMs: number;
  /** The latest message in either direction (the quiet clock). */
  lastMessageMs: number;
  /** The latest HUMAN team reply in this conversation, if any. */
  lastTeamOutMs: number | null;
  suppressed: boolean;
  prior: CommunityHistRow | null;
}

export interface CommunityJob {
  key: string;
  phoneE164: string;
  leadId: string | null;
  conversationId: string;
  name: string | null;
  visaType: string | null;
  lastInboundMs: number;
  prior: CommunityHistRow | null;
  dueMs: number;
}

export interface CommunitySettle { key: string; phoneE164: string; leadId: string | null; reason: string }

export interface CommunityUpcoming {
  key: string;
  phoneE164: string;
  leadId: string | null;
  name: string | null;
  dueMs: number;
  wait: 'time' | 'off';
}

export interface CommunityPlan {
  jobs: CommunityJob[];
  settles: CommunitySettle[];
  skipped: string[];
  /** DISPLAY ONLY — never read by the sender. */
  upcoming: CommunityUpcoming[];
}

export function communityRetryDue(row: Pick<CommunityHistRow, 'attempts' | 'sent_at'>, now: number): boolean {
  const attempts = Math.max(1, row.attempts ?? 1);
  const wait = COMMUNITY_RETRY_BACKOFF_MS[Math.min(attempts, COMMUNITY_RETRY_BACKOFF_MS.length) - 1] ?? 0;
  return now - new Date(row.sent_at).getTime() >= wait;
}

export function planCommunity(input: {
  now: number;
  enabled: boolean;
  people: CommunityPerson[];
}): CommunityPlan {
  const { now, enabled, people } = input;
  const jobs: CommunityJob[] = [];
  const settles: CommunitySettle[] = [];
  const skipped: string[] = [];
  const upcoming: CommunityUpcoming[] = [];

  const seenLead = new Set<string>();
  const seenPhone = new Set<string>();
  for (const p of people) {
    if (!p.phoneE164 || seenPhone.has(p.phoneE164)) continue;
    if (p.leadId && seenLead.has(p.leadId)) continue;
    seenPhone.add(p.phoneE164);
    if (p.leadId) seenLead.add(p.leadId);
    const who = p.name || p.phoneE164;

    // ---- once per person, ever ---------------------------------------------
    if (p.prior?.ok) continue;                                     // already invited
    if (p.prior && (p.prior.error || '').startsWith('stopped')) continue;
    if (p.prior && !(p.prior.error || '').startsWith('skipped')
      && (p.prior.attempts ?? 1) >= COMMUNITY_MAX_ATTEMPTS) continue; // out of tries

    // ---- the gates, in the order a human would ask them --------------------
    if (p.suppressed) { settles.push({ key: COMMUNITY_KEY, phoneE164: p.phoneE164, leadId: p.leadId, reason: COMMUNITY_SETTLE.optedOut }); continue; }
    if (NEVER_STAGES.has(p.stage || '')) { settles.push({ key: COMMUNITY_KEY, phoneE164: p.phoneE164, leadId: p.leadId, reason: COMMUNITY_SETTLE.stage(p.stage || '') }); continue; }
    // A real conversation means a HUMAN replied in this episode. Quietly wait
    // otherwise — the next conversation may qualify them.
    if (p.lastTeamOutMs === null || now - p.lastTeamOutMs > COMMUNITY_EPISODE_MS) continue;

    const dueMs = p.lastMessageMs + COMMUNITY_QUIET_MS;            // talk must be over
    const windowShutsMs = p.lastInboundMs + COMMUNITY_WINDOW_SAFE_MS;
    if (dueMs > windowShutsMs) {
      // They kept chatting right up to the window's edge; catch them next time.
      skipped.push(`${who}: window closes before the quiet time — waits for their next conversation`);
      continue;
    }
    if (now < dueMs) { upcoming.push({ key: COMMUNITY_KEY, phoneE164: p.phoneE164, leadId: p.leadId, name: p.name, dueMs, wait: 'time' }); continue; }
    if (now > windowShutsMs) {
      skipped.push(`${who}: free window closed — waits for their next conversation`);
      continue;
    }
    if (!enabled) { upcoming.push({ key: COMMUNITY_KEY, phoneE164: p.phoneE164, leadId: p.leadId, name: p.name, dueMs, wait: 'off' }); continue; }
    if (p.prior && !p.prior.ok && !communityRetryDue(p.prior, now)) continue;   // in-flight back-off

    jobs.push({
      key: COMMUNITY_KEY, phoneE164: p.phoneE164, leadId: p.leadId, conversationId: p.conversationId,
      name: p.name, visaType: p.visaType, lastInboundMs: p.lastInboundMs, prior: p.prior, dueMs,
    });
  }

  // The window that closes soonest goes first — nobody misses theirs to a cap.
  jobs.sort((a, b) => a.lastInboundMs - b.lastInboundMs);
  upcoming.sort((a, b) => a.dueMs - b.dueMs);
  return { jobs, settles, skipped, upcoming };
}
