// =============================================================================
// CV EXTRACTION — Relay's copy. Word-for-word the CRM's lib/cv/extract.ts.
// -----------------------------------------------------------------------------
// Two deploys, one behaviour: a CV that arrives on WhatsApp must produce the
// same text as the same CV dropped on the CRM page. Keep these files identical.
// See the CRM file for the full rationale on each step.
// =============================================================================

import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

export const PROFILE_CAP_BYTES = 10 * 1024;

export type CvKind = 'pdf' | 'docx' | 'text' | 'unsupported';

export interface Extracted {
  kind: CvKind;
  text: string;
  rawBytes: number;
  condensed: boolean;
  cvScore: number;
  contacts: { emails: string[]; phones: string[]; nameGuess: string | null };
}

export function kindOf(filename: string, mime?: string | null): CvKind {
  const f = filename.toLowerCase();
  const m = (mime || '').toLowerCase();
  if (f.endsWith('.pdf') || m === 'application/pdf') return 'pdf';
  if (f.endsWith('.docx') || m.includes('wordprocessingml')) return 'docx';
  if (f.endsWith('.txt') || m.startsWith('text/plain')) return 'text';
  return 'unsupported';
}

async function textOf(kind: CvKind, buf: Buffer): Promise<string> {
  if (kind === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  if (kind === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }
  if (kind === 'text') return buf.toString('utf8');
  throw new Error('Unsupported file type. PDF, DOCX or TXT only.');
}

function clean(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/^\s*(page\s+)?\d+(\s*(of|\/)\s*\d+)?\s*$/gim, '')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/^[\s]*[•·▪◦●■\-–—*]\s*/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

const CV_SIGNALS: RegExp[] = [
  /\b(work|professional|employment)\s+(experience|history)\b/i,
  /\beducation(al)?\b/i,
  /\b(skills|competencies|expertise)\b/i,
  /\b(summary|profile|objective)\b/i,
  /\b(achievements?|accomplishments?|awards?|honou?rs?)\b/i,
  /\b(publications?|papers?|patents?|conferences?)\b/i,
  /\b(certifications?|courses?|training)\b/i,
  /\b(bachelor|master|b\.?tech|m\.?tech|b\.?e\.?|m\.?sc|b\.?sc|ph\.?d|mba)\b/i,
  /\b(20\d\d|19\d\d)\s*[-–—to]+\s*(20\d\d|present|current|till date)\b/i,
  /\b(curriculum vitae|resume|résumé)\b/i,
];
const NOT_CV_SIGNALS: RegExp[] = [
  /\b(invoice|tax invoice|receipt|amount due|gst(in)?)\b/i,
  // A PASSPORT DOCUMENT, NOT A CV THAT MENTIONS ONE.
  // This used to be a bare /passport/ and it was quietly costing us real CVs:
  // Indian CVs list "Passport No." under personal details as a matter of
  // course, and that single word deducted enough to push a genuine resume
  // below the bar. It was measured, not guessed — Ramadoss's CV on 22 Sep 2026
  // matched three CV signals (0.60) and was thrown out at 0.35 for exactly
  // this reason. A real passport scan carries the issue fields with it, so the
  // penalty now needs the word AND the paperwork around it.
  /\bpassport\b(?=[\s\S]{0,400}\b(date of issue|place of issue|date of expiry|nationality code|republic of india|type\s*:?\s*p\b)\b)/i,
  /\b(place of issue|nationality code)\b/i,
  /\b(offer letter|appointment letter|salary structure|ctc)\b/i,
  /\b(bank statement|account number|ifsc)\b/i,
  /\b(aadhaar|pan card|permanent account number)\b/i,
];

/**
 * OUR OWN MARKETING, WHICH IS THE DANGEROUS CASE.
 *
 * A visa brochure and a CV share almost all of their vocabulary: both talk
 * about education, skills, achievements, awards and experience, because that
 * is what the visa is assessed on. The generic CV signals cannot separate
 * them — our Australian NIV brochure scored 0.60 and would have been written
 * over a client's actual CV.
 *
 * What DOES separate them is authorship. Our brochures carry our branding and
 * our contact details; a client's CV carries theirs. A lead's CV does not say
 * "info@migrizo.com", and it does not sell a visa to the reader.
 *
 * Weighted harder than the signals above, because being wrong here destroys
 * data rather than merely failing to capture it.
 */
const OUR_MATERIAL_SIGNALS: RegExp[] = [
  /@migrizo\.com/i,
  /\bmigrizo\b/i,
  /\bsubclass\s*\d/i,
  /\bpermanent residency for\b/i,
  /\bno employer sponsorship\b/i,
  /\bfamily members included\b/i,
  /\bfreedom to work\b/i,
  /\b(book a call|get in touch|contact us today|why choose)\b/i,
  /\b(our (team|services|process|clients)|we help you)\b/i,
  /\ball rights reserved\b/i,
  /\bbrochure\b/i,
];

export function cvScoreOf(text: string): number {
  if (text.length < 300) return 0;
  const hits = CV_SIGNALS.filter((r) => r.test(text)).length;
  const antis = NOT_CV_SIGNALS.filter((r) => r.test(text)).length;
  const ours = OUR_MATERIAL_SIGNALS.filter((r) => r.test(text)).length;

  // TWO of our own markers disqualifies outright. One does not: a client's CV
  // may legitimately mention us once, and a brochure never scores just one.
  if (ours >= 2) return 0;

  // The anti-signals are weighted lightly on purpose. They were costing real
  // CVs: an Indian CV routinely says "CTC", and a commercial or project
  // manager's CV says "GST" — neither makes the document a payslip. A single
  // incidental word must not outvote five structural CV signals, so a full
  // house still clears both thresholds with one anti-hit against it.
  const base = Math.min(1, hits / 5);            // five signals = certain

  // THE ANTI-SIGNALS ONLY GET A VOTE WHEN THE CV EVIDENCE IS THIN.
  //
  // Scoping the passport pattern was not enough, because plenty of real Indian
  // CVs carry a full "PASSPORT DETAILS" section — number and expiry — for
  // overseas applications. Ramadoss's CV on 22 Sep 2026 was one: three CV
  // sections, and it was binned at 0.35 because of that section.
  //
  // No keyword rule can separate "a CV containing passport details" from "a
  // passport" — but structure can. Three distinct CV sections is something a
  // passport scan, an invoice or a bank statement simply does not have; those
  // score zero on the positive signals regardless. So above that line the
  // anti-signals have nothing left to protect against and are ignored.
  //
  // The trade is deliberate and asymmetric. A false positive here puts the
  // wrong text on a lead's profile, which is visible and easy to undo. A false
  // negative is what we have been living with: a real CV silently binned, and
  // the client told they are not eligible without anyone reading it.
  const penalty = hits >= 3 ? 0 : antis * 0.25;
  return Math.max(0, base - penalty - ours * 0.35);
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{8,}\d)/g;

export function contactsOf(text: string): Extracted['contacts'] {
  const emails = [...new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))].slice(0, 5);
  const phones = [...new Set(
    (text.match(PHONE_RE) || [])
      .map((p) => p.replace(/\D/g, ''))
      .filter((d) => d.length >= 10 && d.length <= 13),
  )].slice(0, 5);
  let nameGuess: string | null = null;
  for (const line of text.split('\n').slice(0, 8)) {
    const l = line.replace(/^•\s*/, '').trim();
    if (!l || l.length > 48 || /@|\d{5,}|curriculum|resume|résumé/i.test(l)) continue;
    const words = l.split(/\s+/);
    if (words.length >= 2 && words.length <= 5 && /^[A-Za-z .'-]+$/.test(l)) { nameGuess = l; break; }
  }
  return { emails, phones, nameGuess };
}

const KEEP_HEADINGS = [
  /^(professional\s+)?(summary|profile|objective|about)/i,
  /^(work|professional|employment)?\s*(experience|history)/i,
  /^education/i,
  /^(key\s+)?(achievements?|accomplishments?|awards?|honou?rs?|recognition)/i,
  /^(publications?|research|papers?|patents?|conferences?|talks?)/i,
  /^(skills|technical skills|core competencies|expertise)/i,
  /^(certifications?|licen[cs]es?)/i,
];
const DROP_HEADINGS = [
  /^(hobbies|interests|personal (details|information)|declaration|references?|languages?)/i,
];

function bytes(s: string) { return Buffer.byteLength(s, 'utf8'); }

function sections(text: string): { heading: string; body: string[] }[] {
  const out: { heading: string; body: string[] }[] = [{ heading: '', body: [] }];
  for (const line of text.split('\n')) {
    const isHeading =
      line.length > 0 && line.length <= 40 && !/[.:,;]$/.test(line) &&
      (line === line.toUpperCase() || KEEP_HEADINGS.some((r) => r.test(line)) || DROP_HEADINGS.some((r) => r.test(line)));
    if (isHeading) out.push({ heading: line, body: [] });
    else out[out.length - 1].body.push(line);
  }
  return out;
}

export function condense(text: string, cap = PROFILE_CAP_BYTES): { text: string; condensed: boolean } {
  if (bytes(text) <= cap) return { text, condensed: false };
  let secs = sections(text).filter((s) => !DROP_HEADINGS.some((r) => r.test(s.heading)));
  let joined = secs.map((s) => [s.heading, ...s.body].filter(Boolean).join('\n')).join('\n\n');
  if (bytes(joined) <= cap) return { text: joined, condensed: true };
  const ranked = secs
    .map((s) => ({ s, rank: KEEP_HEADINGS.findIndex((r) => r.test(s.heading)) }))
    .filter((x) => x.rank >= 0 || x.s.heading === '')
    .sort((a, b) => (a.rank === -1 ? -1 : a.rank) - (b.rank === -1 ? -1 : b.rank));
  secs = ranked.map((x) => x.s);
  joined = secs.map((s) => [s.heading, ...s.body].filter(Boolean).join('\n')).join('\n\n');
  if (bytes(joined) <= cap) return { text: joined, condensed: true };
  const note = '\n\n[condensed to fit the 10KB profile cap]';
  const room = cap - bytes(note);
  let cut = '';
  for (const line of joined.split('\n')) {
    if (bytes(cut + line + '\n') > room) break;
    cut += line + '\n';
  }
  return { text: cut.trimEnd() + note, condensed: true };
}

/**
 * THE BYTES NEVER LIE, AND EVERYTHING ELSE MIGHT.
 *
 * A WhatsApp filename is whatever the sender's phone called it, and Relay's own
 * safeFilename() falls back to ".pdf" when it cannot work an extension out. So
 * a DOCX can reach us named ".pdf" by two separate routes, and trusting the
 * name would hand it to the PDF parser and lose a real CV.
 *
 * PDFs start with "%PDF"; a DOCX is a zip, so it starts with "PK\x03\x04".
 * Those settle it before the filename or declared MIME get a vote.
 */
function sniffKind(buf: Buffer): CvKind | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'docx';
  return null;
}

export async function extractCv(buf: Buffer, filename: string, mime?: string | null): Promise<Extracted> {
  const kind = sniffKind(buf) ?? kindOf(filename, mime);
  const raw = clean(await textOf(kind, buf));
  const { text, condensed } = condense(raw);
  return { kind, text, condensed, rawBytes: bytes(raw), cvScore: cvScoreOf(raw), contacts: contactsOf(raw) };
}
