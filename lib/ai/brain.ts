// =============================================================================
// THE DECISION — one chat in, one next step out.
// -----------------------------------------------------------------------------
// buildPrompt() turns a chat into what Claude reads. think() asks Claude.
// checkDecision() is the gate between what Claude said and what is allowed to
// happen: anything outside the rules becomes "hand to a human" instead of a
// message. The engine only ever acts on a checked decision.
// =============================================================================
import Anthropic from '@anthropic-ai/sdk';
import { ALLOWED_LINK_HOSTS, PLAYBOOK } from './playbook';
import type { MeetingLite, SlotList } from './booking';
import { describeSlot } from './booking';
import type { AiState } from './store';

export const AI_MODEL = 'claude-opus-5-5';

export interface ChatMessage {
  id: string;
  direction: 'in' | 'out';
  body: string | null;
  created_at: string;
  template_name: string | null;
  template_values: { ai?: boolean } | null;
  sent_by: string | null;
  is_internal: boolean | null;
  status: string | null;
  media_type: string | null;
  media_name: string | null;
  media_mime: string | null;
  media_path: string | null;
  media_size: number | null;
}

export interface LeadFacts {
  id: string; full_name: string | null; stage: string | null; visa_type: string | null;
  eligibility: string | null; email: string | null; source: string | null;
}

export interface ChatFile { name: string; text?: string; pdfBase64?: string; imageBase64?: string; mime?: string }

export interface ChatContext {
  now: number;
  phoneE164: string;
  lead: LeadFacts | null;
  state: AiState;
  /** Oldest first, internal notes already removed. */
  messages: ChatMessage[];
  files: ChatFile[];
  slots: SlotList;
  meetings: MeetingLite[];
}

export type DecisionAction = 'reply' | 'verdict' | 'book' | 'handoff' | 'wait';
export type DecisionVerdict = 'none' | 'gtv_eligible' | 'gtv_highly_eligible' | 'not_eligible_offer_ifv' | 'ifv_eligible';
export interface Decision {
  action: DecisionAction;
  messages: string[];
  verdict: DecisionVerdict;
  slot: string;
  email: string;
  handoff_reason: string;
  note: string;
}

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'messages', 'verdict', 'slot', 'email', 'handoff_reason', 'note'],
  properties: {
    action: { type: 'string', enum: ['reply', 'verdict', 'book', 'handoff', 'wait'] },
    messages: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['none', 'gtv_eligible', 'gtv_highly_eligible', 'not_eligible_offer_ifv', 'ifv_eligible'] },
    slot: { type: 'string' },
    email: { type: 'string' },
    handoff_reason: { type: 'string' },
    note: { type: 'string' },
  },
} as const;

const IST = 'Asia/Kolkata';
const stamp = (iso: string) => new Intl.DateTimeFormat('en-GB', {
  timeZone: IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
}).format(new Date(iso));

/** True for a message the assistant itself wrote (as opposed to a human teammate). */
export const isAiMessage = (m: Pick<ChatMessage, 'template_values'>) => m.template_values?.ai === true;

/** The verdict already visible in the thread, whoever gave it. */
export function verdictInThread(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction !== 'out' || !m.body) continue;
    const b = m.body.toLowerCase();
    if (/assessed as eligible for the uk global talent/.test(b)) return 'eligible for the Global Talent Visa';
    if (/not eligible for the uk global talent|profile is not eligible/.test(b)) return 'not eligible for the Global Talent Visa (Innovator Founder Visa offered)';
    if (/eligible to explore the uk innovator founder/.test(b)) return 'eligible to explore the Innovator Founder Visa';
  }
  return null;
}

function describeMedia(m: ChatMessage): string {
  if (!m.media_type) return '';
  const name = m.media_name ? ` "${m.media_name}"` : '';
  if (m.media_type === 'document') return `[sent a document${name}]`;
  if (m.media_type === 'image') return '[sent a photo]';
  if (m.media_type === 'audio') return '[sent a voice note, which cannot be played here]';
  if (m.media_type === 'video') return '[sent a video, which cannot be played here]';
  return `[sent a ${m.media_type}]`;
}

function transcript(messages: ChatMessage[]): string {
  // Everything after our last message is what has not been answered yet.
  let lastOut = -1;
  messages.forEach((m, i) => { if (m.direction === 'out' && m.status !== 'failed') lastOut = i; });
  const lines: string[] = [];
  messages.forEach((m, i) => {
    if (i === lastOut + 1 && m.direction === 'in') lines.push('--- NEW, NOT YET ANSWERED ---');
    const who = m.direction === 'in' ? 'CUSTOMER'
      : isAiMessage(m) ? 'YOU'
        : m.sent_by ? 'TEAMMATE' : 'AUTOMATED MESSAGE';
    const body = [(m.body || '').trim().slice(0, 1500), describeMedia(m)].filter(Boolean).join(' ');
    const failed = m.direction === 'out' && m.status === 'failed' ? ' (this message failed and never reached them)' : '';
    lines.push(`[${stamp(m.created_at)}] ${who}: ${body || '[empty message]'}${failed}`);
  });
  return lines.join('\n');
}

export function buildPrompt(ctx: ChatContext): Anthropic.Beta.BetaContentBlockParam[] {
  const { lead, state, meetings, slots } = ctx;
  const upcoming = meetings.filter((m) => m.status === 'upcoming' && new Date(m.starts_at).getTime() > ctx.now - 45 * 60_000);
  const held = meetings.filter((m) => m.status === 'completed');
  const missed = meetings.filter((m) => m.status === 'no_show');
  const emailInChat = ctx.messages.filter((m) => m.direction === 'in').map((m) => (m.body || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0]).filter(Boolean).pop();
  const already = verdictInThread(ctx.messages);

  const facts = [
    `Now: ${stamp(new Date(ctx.now).toISOString())} IST, ${new Intl.DateTimeFormat('en-GB', { timeZone: IST, weekday: 'long' }).format(new Date(ctx.now))}.`,
    `Customer: ${lead?.full_name?.trim() || 'name not known'} (WhatsApp ${ctx.phoneE164.slice(0, 4)}…).`,
    lead ? `In the CRM: stage "${lead.stage || 'none'}", interested in ${/ifv|innovator/i.test(lead.visa_type || '') ? 'the Innovator Founder Visa' : 'the Global Talent Visa'}, source ${lead.source || 'unknown'}.` : 'Not in the CRM yet.',
    `Email on file: ${lead?.email || emailInChat || ''}`,
    `Verdict already given in this chat: ${already || 'none yet'}.`,
    `Booking link already sent: ${ctx.messages.some((m) => m.direction === 'out' && /crm\.migrizo\.com\/book/.test(m.body || '')) ? 'yes' : 'no'}.`,
    `Call booked: ${upcoming.length ? upcoming.map((m) => describeSlot(m.starts_at, ctx.phoneE164)).join('; ') : 'none'}.`,
    `Calls already held: ${held.length ? held.map((m) => describeSlot(m.starts_at, ctx.phoneE164)).join('; ') : 'none'}.`,
    missed.length ? `Calls they missed: ${missed.map((m) => describeSlot(m.starts_at, ctx.phoneE164)).join('; ')}.` : '',
    state.slotTaken ? `The slot ${describeSlot(state.slotTaken, ctx.phoneE164)} was taken by someone else a moment ago; offer other times.` : '',
  ].filter(Boolean).join('\n');

  const slotText = slots.error
    ? 'The calendar could not be read just now. Do not offer or book specific times; share the booking link instead.'
    : slots.slots.length ? slots.text : 'No free slots in the next few days. Share the booking link instead.';

  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  const fileNotes: string[] = [];
  for (const f of ctx.files) {
    if (f.pdfBase64) {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.pdfBase64 }, title: f.name });
      fileNotes.push(`"${f.name}" is attached above as a PDF.`);
    } else if (f.imageBase64 && f.mime) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: f.imageBase64 } });
      fileNotes.push('A photo they sent is attached above.');
    } else if (f.text) {
      blocks.push({ type: 'text', text: `Text of the document "${f.name}":\n<document>\n${f.text}\n</document>` });
      fileNotes.push(`The text of "${f.name}" is above.`);
    } else {
      fileNotes.push(`The document "${f.name}" could not be read.`);
    }
  }

  // The CV and photos stay the same while a chat goes on, so they sit before
  // everything that changes and are cached: the next decision in this chat reads
  // them for a twentieth of the price instead of paying for them again.
  const lastFile = blocks[blocks.length - 1] as Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam | Anthropic.Beta.BetaRequestDocumentBlock | undefined;
  if (lastFile) lastFile.cache_control = { type: 'ephemeral' };

  blocks.push({
    type: 'text',
    text: [
      '# What we know', facts,
      '# Files they sent', fileNotes.length ? fileNotes.join('\n\n') : 'None.',
      '# Free call slots (slot id in square brackets)', slotText,
      '# The conversation (oldest first)', transcript(ctx.messages),
      'Decide the next step for this chat and return the JSON object.',
    ].join('\n\n'),
  });
  return blocks;
}

export type ThinkResult =
  | { ok: true; decision: Decision; usage: { input: number; output: number; cached: number; written?: number } }
  | { ok: false; error: string; retryable: boolean };

export type Thinker = (ctx: ChatContext, opts: { signal?: AbortSignal; timeoutMs: number }) => Promise<ThinkResult>;

/** Asks Claude what to do next. Never throws. */
export const think: Thinker = async (ctx, opts) => {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: 'ANTHROPIC_API_KEY is not set on the server.', retryable: false };
  const client = new Anthropic({ maxRetries: 0, timeout: opts.timeoutMs });
  try {
    const res = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 6000,
      // If a safety filter declines the request, the API re-runs it on its fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: DECISION_SCHEMA as unknown as Record<string, unknown> } },
      // The playbook is the same for every chat. Cached for an hour, because
      // chats come in with gaps longer than the default five minutes.
      system: [{ type: 'text', text: PLAYBOOK, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: buildPrompt(ctx) }],
    }, { signal: opts.signal });

    if (res.stop_reason === 'refusal') return { ok: false, error: 'The model declined to answer this chat.', retryable: false };
    if (res.stop_reason === 'max_tokens') return { ok: false, error: 'The answer was cut off.', retryable: true };
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { ok: false, error: 'The answer was not valid JSON.', retryable: true }; }
    const d = parsed as Partial<Decision>;
    if (!d || typeof d.action !== 'string' || !Array.isArray(d.messages)) return { ok: false, error: 'The answer was incomplete.', retryable: true };
    return {
      ok: true,
      decision: {
        action: d.action as DecisionAction,
        messages: d.messages.filter((m): m is string => typeof m === 'string'),
        verdict: (d.verdict || 'none') as DecisionVerdict,
        slot: typeof d.slot === 'string' ? d.slot : '',
        email: typeof d.email === 'string' ? d.email : '',
        handoff_reason: typeof d.handoff_reason === 'string' ? d.handoff_reason : '',
        note: typeof d.note === 'string' ? d.note : '',
      },
      usage: {
        input: res.usage.input_tokens, output: res.usage.output_tokens,
        cached: res.usage.cache_read_input_tokens ?? 0,
        written: res.usage.cache_creation_input_tokens ?? 0,
      },
    };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return { ok: false, error: 'The Anthropic key was rejected. Check ANTHROPIC_API_KEY in Netlify.', retryable: false };
    }
    if (e instanceof Anthropic.BadRequestError) {
      // An empty balance comes back as a plain bad request. It stops every chat, not this one.
      if (/credit balance|billing/i.test(e.message)) return { ok: false, error: 'The Anthropic account is out of credit. Add credit in the Anthropic console (Billing).', retryable: false };
      return { ok: false, error: `The request was rejected: ${e.message.slice(0, 200)}`, retryable: false };
    }
    if (e instanceof Anthropic.RateLimitError) return { ok: false, error: 'Anthropic is rate-limiting this key.', retryable: true };
    if (e instanceof Anthropic.APIConnectionTimeoutError) return { ok: false, error: 'The model took too long.', retryable: true };
    if (e instanceof Anthropic.APIError) return { ok: false, error: `Anthropic error ${e.status ?? ''}: ${e.message.slice(0, 200)}`, retryable: true };
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'Unknown error', retryable: true };
  }
};

// ---- the gate ---------------------------------------------------------------

const EMAIL_RE = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const GIVEAWAY = /\b(i am an ai|i'm an ai|i am a bot|i'm a bot|i am not (a )?human|as an ai (assistant|model|language)|ai assistant|language model|chat ?bot|automated (reply|response|system|assistant|message)|virtual assistant)\b/i;

/** WhatsApp text only: no markdown, no long dashes, no stray whitespace. */
export function tidy(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$2')
    .replace(/\s+—\s+/g, ', ').replace(/—/g, ', ')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

function badLink(text: string): string | null {
  for (const raw of text.match(/https?:\/\/[^\s)]+/gi) || []) {
    let host = '';
    try { host = new URL(raw).hostname.toLowerCase(); } catch { return raw; }
    if (!ALLOWED_LINK_HOSTS.includes(host)) return raw;
  }
  return null;
}

export type Checked =
  | { kind: 'reply'; messages: string[]; note: string }
  | { kind: 'verdict'; verdict: Exclude<DecisionVerdict, 'none'>; messages: string[]; note: string }
  | { kind: 'book'; slot: string; email: string; reschedule: boolean; messages: string[]; note: string }
  | { kind: 'wait'; note: string }
  | { kind: 'handoff'; reason: string };

/** Turns Claude's answer into something the engine may act on, or a hand-over. */
export function checkDecision(d: Decision, ctx: ChatContext): Checked {
  const handoff = (reason: string): Checked => ({ kind: 'handoff', reason });
  if (d.action === 'handoff') return handoff(d.handoff_reason.trim() || d.note.trim() || 'The assistant was not sure how to answer.');
  if (d.action === 'wait') return { kind: 'wait', note: d.note.trim() || 'No reply needed.' };

  const messages = d.messages.map(tidy).filter(Boolean);
  if (messages.length > 3) return handoff('The assistant wanted to send more than three messages at once.');
  for (const m of messages) {
    if (m.length > 1400) return handoff('The assistant drafted an unusually long message.');
    if (GIVEAWAY.test(m)) return handoff('The draft reply talked about being a bot or AI.');
    const link = badLink(m);
    if (link) return handoff(`The draft reply contained a link that is not on the approved list (${link.slice(0, 60)}).`);
    if (/\{\{(?!MEET_LINK\}\})/.test(m)) return handoff('The draft reply contained an unfilled blank.');
  }
  const note = d.note.trim().slice(0, 300);

  if (d.action === 'reply') {
    if (!messages.length) return { kind: 'wait', note: note || 'No reply needed.' };
    if (messages.some((m) => m.includes('{{MEET_LINK}}'))) return handoff('The draft reply referred to a meeting link without a booking.');
    return { kind: 'reply', messages, note };
  }

  if (d.action === 'verdict') {
    if (d.verdict === 'none') return handoff('The assistant chose to give a verdict but did not say which.');
    if (verdictInThread(ctx.messages) || ctx.state.verdict) return handoff('A verdict was already given in this chat and the customer is asking for another look.');
    const hasProfile = ctx.files.some((f) => f.pdfBase64 || f.imageBase64 || (f.text && f.text.length > 200))
      || ctx.messages.filter((m) => m.direction === 'in' && !/filled (in|out) your form/i.test(m.body || '')).map((m) => m.body || '').join(' ').length > 100;
    if (!hasProfile) return handoff('The assistant wanted to give a verdict without a CV or a written profile.');
    if (messages.length > 1) return handoff('The assistant wrote more than one extra line for a verdict.');
    if (messages.some((m) => m.includes('{{MEET_LINK}}'))) return handoff('The verdict line referred to a meeting link.');
    return { kind: 'verdict', verdict: d.verdict, messages, note };
  }

  if (d.action === 'book') {
    if (!ctx.slots.slots.includes(d.slot)) return handoff('The assistant tried to book a time that is not free on the calendar.');
    const email = (ctx.lead?.email || d.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return handoff('The assistant tried to book a call without an email address for the invite.');
    if (!messages.length) return handoff('The assistant booked a call but wrote no confirmation.');
    const upcoming = ctx.meetings.filter((m) => m.status === 'upcoming' && new Date(m.starts_at).getTime() > ctx.now);
    if (upcoming.length > 1) return handoff('This person has more than one upcoming call; a human should sort it out.');
    return { kind: 'book', slot: d.slot, email, reschedule: upcoming.length === 1, messages, note };
  }

  return handoff('The assistant returned an unknown action.');
}
