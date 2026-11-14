// =============================================================================
// BROADCAST AUDIENCE — who a manual broadcast goes to.
// -----------------------------------------------------------------------------
// One pure function, used twice on purpose:
//
//   * in the browser, so the count and the list change the instant a chip is
//     tapped — no round trip per click;
//   * on the server at launch, over a FRESH read of the same people, so the
//     list that is actually messaged is decided by the server, never by what
//     a browser tab happened to hold.
//
// HOW A SELECTION READS
//   groups    stages and/or Spotlight — a person in ANY chosen group is in.
//   narrowing visa, eligibility, tags, source, date added, reply history —
//             every one that is set must also be true.
//   always    out: anyone who said STOP, retired leads, and (optionally)
//             anyone we messaged in the last N days.
//   by hand   people unticked in the list are left out; pasted numbers are
//             added on top.
//
// No imports from the server: the Broadcast page (a client component) uses it.
// =============================================================================
import { toE164 } from '@/lib/phone';

export interface BroadcastPerson {
  /** Lead id; 'c:<conversation id>' for a chat with no CRM lead; 'x:<phone>' for a pasted number. */
  id: string;
  leadId: string | null;
  name: string;
  /** E.164 — the number the message goes to. */
  phone: string;
  /** Lead stage, or 'no_lead' for a WhatsApp chat that is not in the CRM. */
  stage: string;
  visa: 'gtv' | 'ifv' | 'unknown';
  eligibility: string;
  tags: string[];
  source: string;
  spotlight: boolean;
  createdAt: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  /** They said STOP. Never messaged, whatever is selected. */
  stop: boolean;
  retired: boolean;
}

export type RepliedFilter = 'any' | 'ever' | 'never' | 'last7' | 'last30' | 'last90';

export interface AudienceSpec {
  /** Stage keys, 'no_lead', and/or 'spotlight'. Someone in ANY of them is in. */
  groups: string[];
  visa: string[];
  eligibility: string[];
  tags: string[];
  sources: string[];
  /** YYYY-MM-DD (IST), inclusive. */
  addedFrom: string | null;
  addedTo: string | null;
  replied: RepliedFilter;
  /** Leave out anyone we sent any WhatsApp message to in the last N days. 0 = off. */
  quietDays: number;
  /** Person ids unticked by hand. */
  removed: string[];
  /** Numbers pasted in by hand. */
  extra: { phone: string; name: string }[];
}

export const EMPTY_SPEC: AudienceSpec = {
  groups: [], visa: [], eligibility: [], tags: [], sources: [],
  addedFrom: null, addedTo: null, replied: 'any', quietDays: 0, removed: [], extra: [],
};

/** A saved spec may predate a field; this fills the gaps so nothing reads undefined. */
export function normaliseSpec(raw: Partial<AudienceSpec> | null | undefined): AudienceSpec {
  const s = raw || {};
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') as string[] : []);
  const replied: RepliedFilter = (['any', 'ever', 'never', 'last7', 'last30', 'last90'] as const)
    .includes(s.replied as RepliedFilter) ? (s.replied as RepliedFilter) : 'any';
  return {
    groups: arr(s.groups), visa: arr(s.visa), eligibility: arr(s.eligibility),
    tags: arr(s.tags), sources: arr(s.sources),
    addedFrom: typeof s.addedFrom === 'string' && s.addedFrom ? s.addedFrom : null,
    addedTo: typeof s.addedTo === 'string' && s.addedTo ? s.addedTo : null,
    replied,
    quietDays: Math.max(0, Math.min(365, Number(s.quietDays) || 0)),
    removed: arr(s.removed),
    extra: Array.isArray(s.extra)
      ? s.extra.filter((e) => e && typeof e.phone === 'string').map((e) => ({ phone: e.phone, name: String(e.name || '') })).slice(0, 5000)
      : [],
  };
}

/** Starred leads join through the Spotlight chip — but never a Junk or Lost one. */
const SPOTLIGHT_NEVER = new Set(['junk', 'lost']);

export interface AudienceResult {
  /** Who gets it, Spotlight first, then by name. */
  included: BroadcastPerson[];
  /** Matched the selection before the automatic exclusions. */
  matched: number;
  excluded: { stop: number; retired: number; quiet: number; removed: number; badNumbers: number };
}

const DAY = 86_400_000;
/** The IST calendar day of an instant, as YYYY-MM-DD. */
export function istDay(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  return new Date(t + 330 * 60_000).toISOString().slice(0, 10);
}

function inGroups(p: BroadcastPerson, groups: Set<string>): boolean {
  if (groups.has(p.stage)) return true;
  return groups.has('spotlight') && p.spotlight && !SPOTLIGHT_NEVER.has(p.stage);
}

function passesNarrowing(p: BroadcastPerson, s: AudienceSpec, now: number): boolean {
  if (s.visa.length && !s.visa.includes(p.visa)) return false;
  if (s.eligibility.length && !s.eligibility.includes(p.eligibility)) return false;
  if (s.tags.length && !p.tags.some((t) => s.tags.includes(t))) return false;
  if (s.sources.length && !s.sources.includes(p.source)) return false;
  if (s.addedFrom || s.addedTo) {
    const d = istDay(p.createdAt);
    if (!d) return false;
    if (s.addedFrom && d < s.addedFrom) return false;
    if (s.addedTo && d > s.addedTo) return false;
  }
  if (s.replied !== 'any') {
    const at = p.lastInboundAt ? new Date(p.lastInboundAt).getTime() : null;
    if (s.replied === 'ever' && at === null) return false;
    if (s.replied === 'never' && at !== null) return false;
    const days = s.replied === 'last7' ? 7 : s.replied === 'last30' ? 30 : s.replied === 'last90' ? 90 : 0;
    if (days && (at === null || now - at > days * DAY)) return false;
  }
  return true;
}

export function selectAudience(
  people: BroadcastPerson[], rawSpec: AudienceSpec, now: number, stopPhones: string[] = [],
): AudienceResult {
  const s = normaliseSpec(rawSpec);
  const groups = new Set(s.groups);
  const removed = new Set(s.removed);
  const stops = new Set(stopPhones);
  const excluded = { stop: 0, retired: 0, quiet: 0, removed: 0, badNumbers: 0 };
  const included: BroadcastPerson[] = [];
  const phones = new Set<string>();
  let matched = 0;

  const admit = (p: BroadcastPerson) => {
    matched++;
    if (p.stop || stops.has(p.phone)) { excluded.stop++; return; }
    if (p.retired) { excluded.retired++; return; }
    if (s.quietDays > 0 && p.lastOutboundAt && now - new Date(p.lastOutboundAt).getTime() < s.quietDays * DAY) {
      excluded.quiet++; return;
    }
    if (removed.has(p.id)) { excluded.removed++; return; }
    if (phones.has(p.phone)) return;            // one message per number, whoever shares it
    phones.add(p.phone);
    included.push(p);
  };

  for (const p of people) {
    if (!inGroups(p, groups)) continue;
    if (!passesNarrowing(p, s, now)) continue;
    admit(p);
  }

  // Pasted numbers ride on top of the selection. A number we already know is
  // that person (so STOP and the rest still apply); a new one is just a number.
  if (s.extra.length) {
    const byPhone = new Map(people.map((p) => [p.phone, p]));
    for (const e of s.extra) {
      const phone = toE164(e.phone);
      if (!phone) { excluded.badNumbers++; continue; }
      if (phones.has(phone)) continue;
      const known = byPhone.get(phone);
      if (known) { admit(e.name && !known.name ? { ...known, name: e.name } : known); continue; }
      admit({
        id: `x:${phone}`, leadId: null, name: e.name.trim(), phone, stage: 'no_lead', visa: 'unknown',
        eligibility: 'unknown', tags: [], source: '', spotlight: false, createdAt: new Date(now).toISOString(),
        lastInboundAt: null, lastOutboundAt: null, stop: stops.has(phone), retired: false,
      });
    }
  }

  included.sort((a, b) => Number(b.spotlight) - Number(a.spotlight) || a.name.localeCompare(b.name));
  return { included, matched, excluded };
}

/** "98765 43210, Asha" lines → numbers with optional names. Commas, tabs or new lines. */
export function parsePastedNumbers(text: string): { ok: { phone: string; name: string }[]; bad: string[] } {
  const ok: { phone: string; name: string }[] = [];
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    // The first run that looks like a phone number; the rest of the line is the name.
    const m = /\+?\d[\d\s().-]{6,}\d/.exec(raw);
    const phone = m ? toE164(m[0]) : null;
    if (!m || !phone) { bad.push(raw.slice(0, 40)); continue; }
    if (seen.has(phone)) continue;
    seen.add(phone);
    const name = (raw.slice(0, m.index) + ' ' + raw.slice(m.index + m[0].length)).replace(/[,;\t|]+/g, ' ').replace(/\s+/g, ' ').trim();
    ok.push({ phone, name });
  }
  return { ok, bad };
}

/** Plain-words summary of a selection, for the history list and the confirm box. */
export function describeSpec(rawSpec: AudienceSpec, label: (group: string) => string): string {
  const s = normaliseSpec(rawSpec);
  const parts: string[] = [];
  if (s.groups.length) parts.push(s.groups.map(label).join(' + '));
  if (s.visa.length) parts.push(s.visa.map((v) => (v === 'unknown' ? 'visa not set' : v.toUpperCase())).join('/'));
  if (s.eligibility.length) parts.push(s.eligibility.map((e) => e.replace(/_/g, ' ')).join('/'));
  if (s.tags.length) parts.push(`tag ${s.tags.join('/')}`);
  if (s.sources.length) parts.push(`from ${s.sources.join('/')}`);
  if (s.addedFrom || s.addedTo) parts.push(`added ${s.addedFrom || '…'} to ${s.addedTo || 'today'}`);
  if (s.replied !== 'any') {
    parts.push({ ever: 'has replied', never: 'never replied', last7: 'replied in 7 days', last30: 'replied in 30 days', last90: 'replied in 90 days' }[s.replied]);
  }
  if (s.quietDays) parts.push(`not messaged in ${s.quietDays}d`);
  if (s.extra.length) parts.push(`${s.extra.length} pasted number${s.extra.length === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'Nobody selected';
}
