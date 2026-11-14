// =============================================================================
// BROADCAST — the shapes shared by the page and the server.
// -----------------------------------------------------------------------------
// A broadcast is a ONE-OFF message a person on the team sends by hand to a
// group they picked: "everyone Hot", "all Spotlight", "Cold leads from Meta
// ads who never replied". It is not an automation — nothing here starts on its
// own, repeats, or follows up.
//
// WHERE IT LIVES (no new tables — these have existed, empty, since migration 115):
//   relay_campaigns            one row per broadcast: name, template, status, counters
//   relay_campaign_recipients  one row per person: queued → sent / failed / skipped
//   relay_settings             key 'broadcast:<id>' — everything else as JSON
//                              (the selection, the {{n}} values, speed, quiet hours)
//
// No server imports: the Broadcast page (a client component) uses these.
// =============================================================================
import type { AudienceSpec } from './audience';

export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'done' | 'cancelled';

/** What fills one {{n}} of the approved wording. */
export interface VarSpec {
  kind: 'first_name' | 'full_name' | 'visa' | 'text';
  /** The words, when kind is 'text' — the same for everyone. */
  text?: string;
}

export type Rate = 'fast' | 'normal' | 'gentle';
/** Messages per minute. A run sends at most this much, however often it is called. */
export const RATE_PER_MIN: Record<Rate, number> = { fast: 20, normal: 8, gentle: 2 };
export const RATE_LABEL: Record<Rate, string> = {
  fast: 'Fast — about 1,200 an hour',
  normal: 'Steady — about 500 an hour',
  gentle: 'Gentle — about 120 an hour',
};

/** Quiet hours, IST: nothing goes out from 9 pm to 9 am unless switched off. */
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 9;

export interface TemplateHeader {
  /** DOCUMENT | IMAGE | VIDEO | TEXT */
  format: string;
  /** The file Interakt holds for this template — the fallback when none is stored in Files. */
  url: string | null;
  fileName: string | null;
}

export interface BroadcastMeta {
  spec: AudienceSpec;
  variables: VarSpec[];
  rate: Rate;
  quietHours: boolean;
  header: TemplateHeader | null;
  /** The approved wording when the broadcast was written. */
  body: string;
  /** Pacing restarts from here whenever sending starts or resumes. */
  paceAnchorAt: string | null;
  /** Why the system paused it on its own, in a sentence. Null when a person paused it. */
  pausedReason: string | null;
  /** The safety check only looks at messages sent after this. */
  healthFrom: string | null;
  createdByName: string | null;
  /** In-words summary of who was picked, written at launch. */
  audienceLabel: string | null;
}

export const metaKey = (campaignId: string) => `broadcast:${campaignId}`;

export function firstNameOf(fullName: string | null | undefined): string {
  const n = (fullName || '').trim().split(/\s+/)[0];
  // A pasted number with no name, or a name that is really a phone number.
  return n && !/^\+?\d[\d\s-]*$/.test(n) ? n : 'there';
}

export function visaLabelOf(visa: string | null | undefined): string {
  const v = (visa || '').toLowerCase();
  return v.includes('ifv') || v.includes('innovator') || v.includes('founder') ? 'Innovator Founder Visa' : 'Global Talent Visa';
}

/** Highest {{n}} in the wording — how many values a send must supply. */
export function countVars(body: string): number {
  let max = 0;
  for (const m of (body || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/**
 * WhatsApp refuses a value that is empty, or holds a new line, a tab, or more
 * than four spaces in a row. Cleaned here so one odd name cannot fail a send.
 */
function clean(v: string): string {
  return v.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
}

/** The values for one person, in {{1}}, {{2}}… order. */
export function resolveValues(
  variables: VarSpec[], count: number, person: { full_name?: string | null; visa_type?: string | null },
): string[] {
  return Array.from({ length: count }, (_, i) => {
    const v = variables[i] || { kind: i === 0 ? 'first_name' : 'text', text: '' };
    const out =
      v.kind === 'first_name' ? firstNameOf(person.full_name)
      : v.kind === 'full_name' ? ((person.full_name || '').trim() || 'there')
      : v.kind === 'visa' ? visaLabelOf(person.visa_type)
      : (v.text || '');
    return clean(out) || (v.kind === 'text' ? '-' : 'there');
  });
}

/** The wording with the values in place — what the customer reads. */
export function renderBody(body: string, values: string[]): string {
  return (body || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_m: string, n: string) => values[Number(n) - 1] ?? '');
}

/** Default choice for each {{n}}: the first is nearly always the name. */
export function defaultVariables(count: number, prev: VarSpec[] = []): VarSpec[] {
  return Array.from({ length: count }, (_, i) => prev[i] || (i === 0 ? { kind: 'first_name' } : { kind: 'text', text: '' }));
}

/** A {{n}} set to "same words for everyone" with nothing typed. */
export function missingVariables(variables: VarSpec[], count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = variables[i];
    if (v && v.kind === 'text' && !(v.text || '').trim()) out.push(i + 1);
  }
  return out;
}

/** True between 9 pm and 9 am IST. */
export function inQuietHours(now: number = Date.now()): boolean {
  const h = new Date(now + 330 * 60_000).getUTCHours();
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/** The next 9:00 am IST after `now`, as an instant. */
export function quietHoursEnd(now: number = Date.now()): string {
  const ist = new Date(now + 330 * 60_000);
  const next = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), QUIET_END_HOUR, 0, 0));
  if (ist.getUTCHours() >= QUIET_END_HOUR) next.setUTCDate(next.getUTCDate() + 1);
  return new Date(next.getTime() - 330 * 60_000).toISOString();
}

// ---- what the page receives ---------------------------------------------------

export interface BroadcastSummary {
  id: string;
  name: string;
  templateName: string;
  templateLanguage: string;
  status: BroadcastStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  /** total − sent − failed − skipped */
  waiting: number;
  audienceLabel: string | null;
  createdByName: string | null;
  pausedReason: string | null;
  quietHours: boolean;
  rate: Rate;
}

/** One person's line in the results. */
export interface RecipientLine {
  id: string;
  leadId: string | null;
  name: string;
  phone: string;
  /** waiting | sent | delivered | read | failed | skipped */
  state: 'waiting' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';
  replied: boolean;
  note: string | null;
  sentAt: string | null;
}

export interface BroadcastDetail extends BroadcastSummary {
  body: string;
  variables: VarSpec[];
  spec: AudienceSpec;
  header: TemplateHeader | null;
  counts: { waiting: number; sent: number; delivered: number; read: number; replied: number; failed: number; skipped: number };
  people: RecipientLine[];
  /** True while quiet hours are holding it; `resumesAt` says when it carries on. */
  holding: boolean;
  resumesAt: string | null;
}

export interface LiveTemplate {
  name: string;
  language: string;
  category: string | null;
  body: string;
  footer: string | null;
  variableCount: number;
  header: TemplateHeader | null;
  /** Button captions, for the preview. */
  buttons: string[];
  createdAt: string | null;
  /** Set when this template cannot be broadcast, with the reason. */
  blocked: string | null;
}
