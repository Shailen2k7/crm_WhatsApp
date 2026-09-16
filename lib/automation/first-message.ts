// =============================================================================
// FIRST MESSAGE PLANNER — who gets the CV + LinkedIn message on this run.
// -----------------------------------------------------------------------------
// Pure: data in, decisions out, no I/O. The tick fetches everything this needs
// in two parallel round trips and then asks this function what to do. That is
// what removed the ~92 per-conversation queries that made an idle run take
// 15–25 seconds, and it means every rule below can be tested without a
// database.
//
// The rules are the same ones the tick has enforced all along:
//
//   LEAD PASS — a lead created after the rule was switched on, older than the
//   delay, with a phone, not a sample, not opted out, and not already handled.
//
//   STRANGER PASS — someone who WhatsApps us from a number with no lead record.
//   Their FIRST inbound message decides: a form enquiry is always answered on
//   the number it came from; an ordinary text from a number that belongs to a
//   lead is left to the sequences.
//
//   "Already handled" = delivered, or three attempts made, or still inside the
//   back-off after a failed attempt (0, then 15 min, then 2 h).
//
// Every pass only looks back RECENT_WINDOW_HOURS. A first message is meant to
// go out within minutes; anything older than three days that was never
// attempted is a fault for the health check to report, not a queue to re-scan
// every five minutes forever.
// =============================================================================
import { toE164 } from '@/lib/phone';

export const RECENT_WINDOW_HOURS = 72;
export const MAX_ATTEMPTS = 3;
/** How long to wait after attempt N (1-based) before attempt N+1. */
export const RETRY_BACKOFF_MS = [0, 15 * 60_000, 2 * 3_600_000];

export interface LeadRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  visa_type: string | null;
  created_at: string;
  is_sample: boolean | null;
}

export interface ConvRow {
  id: string;
  phone_e164: string;
  last_inbound_at: string;
  lead_id: string | null;
  /** The conversation's first inbound message, if any. */
  first_inbound_body: string | null;
}

export interface HistoryRow {
  id: string;
  lead_id: string | null;
  phone_e164: string;
  ok: boolean;
  attempts: number | null;
  sent_at: string;
  error: string | null;
}

export interface Job {
  kind: 'lead' | 'stranger';
  phoneE164: string;
  leadId: string | null;
  conversationId: string | null;   // known for strangers; leads are resolved at send time
  name: string | null;
  visaType: string | null;
  /** The earlier failed attempt this job retries, if it is a retry. */
  prior: HistoryRow | null;
  /** For ordering: when this person arrived. */
  arrivedAt: string;
}

export interface PlanInput {
  now: number;
  rule: { activated_at: string; delay_seconds: number | null };
  leads: LeadRow[];
  convs: ConvRow[];
  history: HistoryRow[];
  suppressedPhones: Set<string>;
  /** Last 10 digits of every lead phone — used only for unlinked strangers. */
  knownLeadDigits: Set<string> | null;
}

export interface Plan {
  jobs: Job[];
  /** People we skipped and why, for the run report. */
  skipped: string[];
  /** Unlinked, non-enquiry strangers whose lead status could not be checked. */
  needsKnownLeadCheck: boolean;
}

const last10 = (p: string | null | undefined) => String(p || '').replace(/\D/g, '').slice(-10);

export function isEnquiry(body: string | null | undefined): boolean {
  const b = body || '';
  return /filled\s+(in|out)\s+your\s+form/i.test(b) || /full\s*name\s*:/i.test(b);
}

/** The Meta form spells the name out; that is how we greet an unknown number. */
export function nameFromEnquiry(body: string | null | undefined): string | null {
  const m = (body || '').match(/full\s*name\s*:\s*(.+)/i);
  const n = m?.[1]?.split('\n')[0]?.trim();
  return n || null;
}

export function retryDue(row: Pick<HistoryRow, 'attempts' | 'sent_at'>, now: number): boolean {
  const attempts = Math.max(1, row.attempts ?? 1);
  const wait = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1] ?? 0;
  return now - new Date(row.sent_at).getTime() >= wait;
}

export function planFirstMessages(input: PlanInput): Plan {
  const { now, rule, leads, convs, history, suppressedPhones, knownLeadDigits } = input;
  const activatedMs = new Date(rule.activated_at).getTime();
  const windowStartMs = Math.max(activatedMs, now - RECENT_WINDOW_HOURS * 3_600_000);
  const cutoffMs = now - (rule.delay_seconds ?? 60) * 1_000;
  const inWindow = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= windowStartMs && t <= cutoffMs;
  };

  // "Leave alone": delivered, out of attempts, or still cooling off.
  const settled = history.filter((h) => h.ok || (h.attempts ?? 1) >= MAX_ATTEMPTS || !retryDue(h, now));
  const settledLeads = new Set(settled.map((h) => h.lead_id).filter(Boolean) as string[]);
  const settledPhones = new Set(settled.map((h) => h.phone_e164));
  const retryable = history.filter((h) => !h.ok && (h.attempts ?? 1) < MAX_ATTEMPTS && retryDue(h, now));
  const retryByLead = new Map(retryable.filter((h) => h.lead_id).map((h) => [h.lead_id as string, h]));
  const retryByPhone = new Map(retryable.map((h) => [h.phone_e164, h]));

  const jobs: Job[] = [];
  const skipped: string[] = [];
  const plannedPhones = new Set<string>();

  // ---- LEAD PASS -----------------------------------------------------------
  for (const l of leads) {
    if (!inWindow(l.created_at)) continue;
    if (l.is_sample || !(l.phone || '').trim()) continue;
    if (settledLeads.has(l.id)) continue;
    const phone = toE164(l.phone);
    if (!phone) { skipped.push(`${l.full_name || l.id}: unusable phone`); continue; }
    if (settledPhones.has(phone) || plannedPhones.has(phone)) continue;
    if (suppressedPhones.has(phone)) { skipped.push(`${l.full_name || phone}: opted out (STOP)`); continue; }
    plannedPhones.add(phone);
    jobs.push({
      kind: 'lead', phoneE164: phone, leadId: l.id, conversationId: null,
      name: l.full_name, visaType: l.visa_type,
      prior: retryByLead.get(l.id) || retryByPhone.get(phone) || null,
      arrivedAt: l.created_at,
    });
  }

  // ---- STRANGER PASS -------------------------------------------------------
  let needsKnownLeadCheck = false;
  for (const c of convs) {
    if (!c.phone_e164 || !inWindow(c.last_inbound_at)) continue;
    const phone = c.phone_e164;
    if (settledPhones.has(phone) || plannedPhones.has(phone) || suppressedPhones.has(phone)) continue;

    // The MESSAGE decides, not the CRM: a form enquiry is always answered.
    // Only an ordinary text from a number that belongs to a lead is held back.
    if (!isEnquiry(c.first_inbound_body)) {
      if (c.lead_id) continue;                         // linked to a lead: not a stranger
      if (knownLeadDigits === null) { needsKnownLeadCheck = true; continue; }
      if (knownLeadDigits.has(last10(phone))) continue; // a lead typed in another format
    }

    plannedPhones.add(phone);
    jobs.push({
      kind: 'stranger', phoneE164: phone, leadId: null, conversationId: c.id,
      name: nameFromEnquiry(c.first_inbound_body), visaType: null,
      prior: retryByPhone.get(phone) || null,
      arrivedAt: c.last_inbound_at,
    });
  }

  // Newest first, so tonight's enquiry is never stuck behind a backlog when the
  // run's send budget is small. The executor takes from the front.
  jobs.sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt));
  return { jobs, skipped, needsKnownLeadCheck };
}
