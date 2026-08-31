// =============================================================================
// PHONE NUMBERS — the single hardest correctness problem in this app.
// -----------------------------------------------------------------------------
// An inbound WhatsApp message arrives carrying only a phone number. Resolving it
// to the right lead is the whole CRM link. The CRM's own Meta ingest route
// documents the trap from production: Meta has sent "+919812345678",
// "919812345678" and "p:+91 98123 45678" for the SAME person, and an exact
// string match treated those as three different people.
//
// So there are two different operations here and they must not be confused:
//
//   toE164()   — the canonical form we STORE and send to Interakt.
//   matchKey() — the last 10 digits, used only to FIND an existing lead whose
//                number was typed by a human in some other format.
//
// Matching on the last 10 digits is deliberately loose. It is correct for
// India (10-digit subscriber numbers) and good enough elsewhere for a lookup
// that a human then confirms. It is never used as a uniqueness constraint.
// =============================================================================

const DEFAULT_CC = '91'; // Migrizo is India-based; most leads are Indian numbers.

/** Strips Meta's "p:" / "f:" field prefixes. */
export function unprefix(v: string): string {
  return v.replace(/^[a-z]:/i, '').trim();
}

/**
 * Canonical E.164 — "+919812345678". Returns null when there aren't enough
 * digits to be a real number, because a half-number is worse than none.
 */
export function toE164(raw: string | null | undefined, defaultCc = DEFAULT_CC): string | null {
  if (!raw) return null;
  const cleaned = unprefix(String(raw));
  const hadPlus = cleaned.trim().startsWith('+');
  let digits = cleaned.replace(/\D/g, '');
  if (!digits) return null;

  // "00" is the international prefix in much of the world — same meaning as "+".
  if (!hadPlus && digits.startsWith('00')) digits = digits.slice(2);

  // A bare national number (10 digits in India) needs its country code.
  if (!hadPlus && digits.length <= 10) digits = defaultCc + digits;

  // E.164 allows at most 15 digits; fewer than 8 is not a dialable number.
  if (digits.length < 8 || digits.length > 15) return null;
  return '+' + digits;
}

/**
 * The lookup key: last 10 digits, or null if there aren't 10.
 * Use for FINDING a lead, never for storing or sending.
 */
export function matchKey(raw: string | null | undefined): string | null {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** True when two numbers are the same person, whatever format each is in. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = matchKey(a);
  const kb = matchKey(b);
  return ka !== null && ka === kb;
}

/**
 * Readable form for the UI — "+91 98104 22187".
 * Falls back to the input unchanged rather than hiding a number we can't parse.
 */
export function formatPhone(raw: string | null | undefined): string {
  const e164 = toE164(raw);
  if (!e164) return String(raw || '').trim();
  const digits = e164.slice(1);
  if (digits.startsWith('91') && digits.length === 12) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (digits.startsWith('44')) return `+44 ${digits.slice(2)}`;
  if (digits.startsWith('1') && digits.length === 11) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return e164;
}

/** Initials for the avatar circle — "Aarav Mehta" -> "AM". */
export function initialsOf(name: string | null | undefined): string {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Deterministic avatar tint. Same person, same colour, every session and every
 * device — so the team learns faces by colour. Hash, not random.
 */
const AVATAR_TINTS = [
  '#0d8c7c', '#2f6f9f', '#8a5cc4', '#b3841c',
  '#c4573f', '#3f8f5e', '#a04a7c', '#4a6fa8',
];
export function avatarTint(seed: string | null | undefined): string {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length];
}
