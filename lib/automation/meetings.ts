// =============================================================================
// CALL MESSAGES — PC1 when a call is booked, PC2 when it is marked completed.
// -----------------------------------------------------------------------------
// Pure: data in, decisions out, no I/O, so every rule is tested without a
// database. The tick (?pass=meetings) loads the data and sends.
//
// THE SHAPE (Shailen, 28 Nov 2026):
//
//   PC1   a call is booked in the CRM (by the person on the booking page, by
//         the WhatsApp assistant, or by the team): the pc1 template goes
//         shortly after, while the call is still ahead.
//   PC2   the call is marked "completed" in the CRM: the pc2 template goes.
//
//   ONCE  per meeting per message — a rescheduled call keeps its meeting, so
//         it never gets a second PC1. A new booking later is a new meeting.
//   ONLY  meetings booked (PC1) or completed (PC2) after the rule was switched
//         on, and at most 48 hours ago — switching on never reaches back into
//         the old calls.
//   NEVER anyone who said STOP; a PC1 for a call that was cancelled or has
//         already started; anything inside the rule's quiet hours (it waits).
//
// History rows live in relay_automation_sent under the key
// "meeting_booked:<meeting id>" / "meeting_completed:<meeting id>" with
// meeting_id set. One key per meeting means the per-person unique index can
// never block a person's second call, and (automation_key, meeting_id) is
// unique as well, so a meeting can never be messaged twice.
// =============================================================================

export const MEETING_BOOKED_KEY = 'meeting_booked';
export const MEETING_COMPLETED_KEY = 'meeting_completed';
export type MeetingRuleKey = typeof MEETING_BOOKED_KEY | typeof MEETING_COMPLETED_KEY;
export const MEETING_RULE_KEYS: MeetingRuleKey[] = [MEETING_BOOKED_KEY, MEETING_COMPLETED_KEY];

/** The history key for one message about one meeting. */
export const meetingSentKey = (rule: MeetingRuleKey, meetingId: string) => `${rule}:${meetingId}`;

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Nothing older than this is ever messaged, however the switch was flipped. */
export const MEETING_LOOKBACK_MS = 48 * HOUR;
/** A PC1 for a call this close to starting would arrive too late to matter. */
export const PC1_MIN_LEAD_MS = 5 * MIN;
export const MEETING_MAX_ATTEMPTS = 3;
export const MEETING_RETRY_BACKOFF_MS = [10 * MIN, 30 * MIN];

export interface MeetingRule {
  key: MeetingRuleKey;
  enabled: boolean;
  activatedAt: string | null;
  templateName: string | null;
  templateLanguage: string;
  delaySeconds: number;
  quietStartHour: number | null;
  quietEndHour: number | null;
}

export interface MeetingHistRow {
  id: string;
  automation_key: string;
  meeting_id: string | null;
  ok: boolean;
  attempts: number | null;
  sent_at: string;
  error: string | null;
}

export interface MeetingRow {
  id: string;
  lead_id: string | null;
  client_name: string | null;
  status: string;
  starts_at: string;
  created_at: string;
  completed_at: string | null;
  /** Where to send: the chat they actually use, else the phone on the booking or lead. */
  phoneE164: string | null;
  conversationId: string | null;
  name: string | null;
  visaType: string | null;
  suppressed: boolean;
  /** When each call template (pc1 / pc2) last went to this chat, by anyone — the team sends them by hand too. */
  templateSentMs: Record<string, number>;
}

export interface MeetingJob {
  rule: MeetingRuleKey;
  sentKey: string;
  meetingId: string;
  leadId: string | null;
  phoneE164: string;
  conversationId: string | null;
  name: string | null;
  visaType: string | null;
  templateName: string;
  templateLanguage: string;
  prior: MeetingHistRow | null;
}

export interface MeetingSettle { rule: MeetingRuleKey; sentKey: string; meetingId: string; leadId: string | null; phoneE164: string; reason: string }

export interface MeetingPlan {
  jobs: MeetingJob[];
  settles: MeetingSettle[];
  skipped: string[];
  /** DISPLAY ONLY: who is waiting and why. */
  waiting: { rule: MeetingRuleKey; name: string | null; why: string }[];
}

export const MEETING_SETTLE = {
  optedOut: 'stopped — opted out (STOP)',
  noPhone: 'stopped — no usable phone number',
  cancelled: 'stopped — the call was cancelled before PC1 went',
  started: 'stopped — the call had already started before PC1 could go',
  already: 'stopped — this message already went to them (by the team or for another call)',
} as const;

/** The same template to the same person within this long counts as already sent. */
export const MEETING_SAME_MESSAGE_GAP_MS = 24 * HOUR;

/** The IST hour, 0–23. */
export function istHourOf(ms: number): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date(ms))) % 24;
}

/** Inside the quiet hours? Handles a window that crosses midnight (21 → 9). */
export function inQuietHours(rule: Pick<MeetingRule, 'quietStartHour' | 'quietEndHour'>, ms: number): boolean {
  const s = rule.quietStartHour, e = rule.quietEndHour;
  if (s === null || e === null || s === e) return false;
  const h = istHourOf(ms);
  return s < e ? h >= s && h < e : h >= s || h < e;
}

export function meetingRetryDue(row: Pick<MeetingHistRow, 'attempts' | 'sent_at'>, now: number): boolean {
  const attempts = Math.max(1, row.attempts ?? 1);
  const wait = MEETING_RETRY_BACKOFF_MS[Math.min(attempts, MEETING_RETRY_BACKOFF_MS.length) - 1] ?? 0;
  return now - new Date(row.sent_at).getTime() >= wait;
}

export function planMeetingMessages(input: {
  now: number;
  rules: MeetingRule[];
  meetings: MeetingRow[];
  /** Keyed by the history key ("meeting_booked:<id>"). */
  history: Map<string, MeetingHistRow>;
  /** Show the real queue even for a rule that is off (the tab uses this). */
  ignoreSwitch?: boolean;
}): MeetingPlan {
  const { now, rules, meetings, history } = input;
  const jobs: MeetingJob[] = [];
  const settles: MeetingSettle[] = [];
  const skipped: string[] = [];
  const waiting: MeetingPlan['waiting'] = [];

  for (const rule of rules) {
    const plannedPhones = new Set<string>();      // one per person per run, even with two meetings
    if (!rule.enabled && !input.ignoreSwitch) continue;
    if (!rule.activatedAt || !rule.templateName) continue;
    const activatedMs = new Date(rule.activatedAt).getTime();
    const quiet = inQuietHours(rule, now);

    for (const m of meetings) {
      const who = m.name || m.client_name || m.phoneE164 || m.id;
      const sentKey = meetingSentKey(rule.key, m.id);
      const prior = history.get(sentKey) ?? null;

      // ---- once per meeting, and only for new events ------------------------
      if (prior?.ok) continue;
      if (prior && (prior.error || '').startsWith('stopped')) continue;
      if (prior && (prior.attempts ?? 1) >= MEETING_MAX_ATTEMPTS) continue;

      let eventMs: number;
      if (rule.key === MEETING_BOOKED_KEY) {
        eventMs = new Date(m.created_at).getTime();
      } else {
        if (m.status !== 'completed' || !m.completed_at) continue;
        eventMs = new Date(m.completed_at).getTime();
      }
      if (eventMs < activatedMs || now - eventMs > MEETING_LOOKBACK_MS) continue;

      // ---- the gates -----------------------------------------------------
      const settle = (reason: string) => {
        if (m.phoneE164) settles.push({ rule: rule.key, sentKey, meetingId: m.id, leadId: m.lead_id, phoneE164: m.phoneE164, reason });
        skipped.push(`${who}: ${reason}`);
      };
      if (!m.phoneE164) { skipped.push(`${who}: ${MEETING_SETTLE.noPhone}`); continue; }
      if (m.suppressed) { settle(MEETING_SETTLE.optedOut); continue; }
      if (rule.key === MEETING_BOOKED_KEY) {
        if (m.status === 'cancelled') { settle(MEETING_SETTLE.cancelled); continue; }
        if (m.status !== 'upcoming') continue;   // completed / no-show: PC2 territory, not PC1
        if (new Date(m.starts_at).getTime() - now < PC1_MIN_LEAD_MS) { settle(MEETING_SETTLE.started); continue; }
      }
      // Already went to them: by hand from the team, or for another of their calls.
      const lastSame = m.templateSentMs[rule.templateName] ?? 0;
      if (plannedPhones.has(m.phoneE164) || lastSame >= eventMs - HOUR || now - lastSame < MEETING_SAME_MESSAGE_GAP_MS) {
        settle(MEETING_SETTLE.already); continue;
      }
      if (now < eventMs + rule.delaySeconds * 1000) { waiting.push({ rule: rule.key, name: who, why: 'a few seconds after the event' }); continue; }
      if (quiet) { waiting.push({ rule: rule.key, name: who, why: 'quiet hours — goes in the morning' }); continue; }
      if (!rule.enabled) { waiting.push({ rule: rule.key, name: who, why: 'switched off' }); continue; }
      if (prior && !meetingRetryDue(prior, now)) continue;

      plannedPhones.add(m.phoneE164);
      jobs.push({
        rule: rule.key, sentKey, meetingId: m.id, leadId: m.lead_id, phoneE164: m.phoneE164,
        conversationId: m.conversationId, name: m.name || m.client_name, visaType: m.visaType,
        templateName: rule.templateName, templateLanguage: rule.templateLanguage || 'en', prior,
      });
    }
  }
  return { jobs, settles, skipped, waiting };
}
