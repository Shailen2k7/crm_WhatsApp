// =============================================================================
// INTERAKT — the only file that talks to the WhatsApp provider.
// -----------------------------------------------------------------------------
// Endpoint:  POST https://api.interakt.ai/v1/public/message/
// Auth:      Authorization: Basic <API key>   (the key is ALREADY base64 —
//            it ends in ':' when decoded, i.e. secret with an empty password.
//            Do NOT base64-encode it again.)
//
// TWO KINDS OF SEND, and the difference is a WhatsApp rule, not ours:
//
//   Template  — an approved template. The ONLY thing you may send to open a
//               conversation, or to reach someone who has not messaged you in
//               the last 24 hours.
//   Text      — free-form. Legal only INSIDE the 24-hour window that starts at
//               the customer's most recent inbound message.
//
// sendMessage() will not let you break that rule: it takes the window state and
// refuses a free-form send outside it, rather than letting Interakt reject it
// after we have already written an optimistic row.
// =============================================================================

const BASE = 'https://api.interakt.ai/v1/public';

export interface SendResult {
  ok: boolean;
  providerMsgId?: string;
  /** Machine-readable reason, for storing on the message row. */
  code?: string;
  /** Human-readable detail, shown to the agent. */
  detail?: string;
  /** Raw provider response, kept for debugging a failed send. */
  raw?: unknown;
}

/**
 * Interakt wants the country code and the subscriber number SEPARATELY, with
 * no leading zeros on the latter. We store E.164 ("+919810422187"), so this
 * splits it back apart.
 *
 * Only the country codes Migrizo actually deals with are special-cased; the
 * fallback assumes a 10-digit subscriber number, which is right for India and
 * a sane default elsewhere.
 */
export function splitE164(e164: string): { countryCode: string; phoneNumber: string } | null {
  const digits = String(e164 || '').replace(/\D/g, '');
  if (digits.length < 8) return null;

  const KNOWN = ['91', '44', '1', '971', '61', '65', '353', '49', '33'];
  const cc = KNOWN.find((c) => digits.startsWith(c) && digits.length - c.length >= 6);
  if (cc) return { countryCode: '+' + cc, phoneNumber: digits.slice(cc.length).replace(/^0+/, '') };

  const guess = digits.slice(0, digits.length - 10);
  if (!guess) return null;
  return { countryCode: '+' + guess, phoneNumber: digits.slice(-10) };
}

function apiKey(): string | null {
  return process.env.INTERAKT_API_KEY || null;
}

export function isConfigured(): boolean {
  return !!apiKey();
}

async function post(path: string, body: unknown): Promise<SendResult> {
  const key = apiKey();
  if (!key) return { ok: false, code: 'not_configured', detail: 'INTERAKT_API_KEY is not set.' };

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        // The key from Interakt's dashboard is already base64. Passed through as-is.
        Authorization: `Basic ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // A hung provider must not hang the agent's UI.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'TimeoutError';
    return {
      ok: false,
      code: aborted ? 'timeout' : 'network_error',
      detail: aborted ? 'Interakt did not respond within 20s.' : 'Could not reach Interakt.',
      raw: String(e),
    };
  }

  let json: unknown = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { nonJson: text.slice(0, 400) };
  }

  const j = (json || {}) as { result?: boolean; id?: string; message?: string; error?: unknown };

  if (!res.ok || j.result === false) {
    return {
      ok: false,
      code: `http_${res.status}`,
      detail: j.message || (typeof j.error === 'string' ? j.error : '') || `Interakt returned ${res.status}.`,
      raw: json,
    };
  }

  return { ok: true, providerMsgId: j.id, raw: json };
}

/** Approved template — the only legal way to open or reopen a conversation. */
export async function sendTemplate(opts: {
  phoneE164: string;
  templateName: string;
  languageCode?: string;
  bodyValues?: string[];
  headerValues?: string[];
  callbackData?: string;
}): Promise<SendResult> {
  const split = splitE164(opts.phoneE164);
  if (!split) return { ok: false, code: 'bad_phone', detail: `Not a usable number: ${opts.phoneE164}` };

  return post('/message/', {
    countryCode: split.countryCode,
    phoneNumber: split.phoneNumber,
    type: 'Template',
    callbackData: opts.callbackData,
    template: {
      name: opts.templateName,
      languageCode: opts.languageCode || 'en',
      headerValues: opts.headerValues,
      bodyValues: opts.bodyValues || [],
    },
  });
}

/**
 * Free-form session message. Legal only inside the 24-hour window.
 *
 * NOTE ON SHAPE: Interakt publicly documents the Template body in detail but
 * not this one. This is the shape their dashboard and the common integrations
 * use. If your account rejects it, the exact provider error is surfaced to the
 * agent AND stored on the message row (error_code / error_detail), so the fix
 * is a one-line change here rather than a debugging session.
 */
export async function sendText(opts: {
  phoneE164: string;
  message: string;
  callbackData?: string;
}): Promise<SendResult> {
  const split = splitE164(opts.phoneE164);
  if (!split) return { ok: false, code: 'bad_phone', detail: `Not a usable number: ${opts.phoneE164}` };

  return post('/message/', {
    countryCode: split.countryCode,
    phoneNumber: split.phoneNumber,
    type: 'Text',
    callbackData: opts.callbackData,
    data: { message: opts.message },
  });
}

// --- the 24-hour window ------------------------------------------------------

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WindowState {
  open: boolean;
  expiresAt: string | null;
  msLeft: number;
}

/** Derived from the last inbound message, never stored — it cannot go stale. */
export function windowState(lastInboundAt: string | null | undefined): WindowState {
  if (!lastInboundAt) return { open: false, expiresAt: null, msLeft: 0 };
  const started = new Date(lastInboundAt).getTime();
  if (Number.isNaN(started)) return { open: false, expiresAt: null, msLeft: 0 };
  const expires = started + WINDOW_MS;
  const msLeft = expires - Date.now();
  return {
    open: msLeft > 0,
    expiresAt: new Date(expires).toISOString(),
    msLeft: Math.max(0, msLeft),
  };
}

/** "6h 12m left" — the countdown shown in the composer. */
export function formatWindow(msLeft: number): string {
  if (msLeft <= 0) return 'closed';
  const mins = Math.floor(msLeft / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

// --- webhook payload ---------------------------------------------------------

/** Interakt's webhook envelope. Fields per their published examples. */
export interface InteraktWebhook {
  version?: string;
  timestamp?: string;
  type?: string;
  data?: {
    customer?: { id?: string; channel_phone_number?: string; traits?: Record<string, unknown> };
    message?: {
      id?: string;
      chat_message_type?: string;
      message_status?: string;
      received_at_utc?: string | null;
      delivered_at_utc?: string | null;
      seen_at_utc?: string | null;
      is_template_message?: boolean;
      message_content_type?: string;
      media_url?: string | null;
      message?: string | null;
      channel_error_code?: string | null;
      channel_failure_reason?: string | null;
      meta_data?: Record<string, unknown>;
    };
  };
}

/** Maps Interakt's status events onto our message.status values. */
export function statusFromEvent(eventType: string | undefined): 'sent' | 'delivered' | 'read' | 'failed' | null {
  if (!eventType) return null;
  if (eventType.endsWith('_sent')) return 'sent';
  if (eventType.endsWith('_delivered')) return 'delivered';
  if (eventType.endsWith('_read')) return 'read';
  if (eventType.endsWith('_failed')) return 'failed';
  return null;
}

/** Interakt's media content types → our media_type enum. */
export function mediaTypeFrom(contentType: string | undefined | null): 'image' | 'document' | 'audio' | 'video' | 'sticker' | null {
  const t = (contentType || '').toLowerCase();
  if (t === 'image') return 'image';
  if (t === 'document' || t === 'file') return 'document';
  if (t === 'audio' || t === 'voice') return 'audio';
  if (t === 'video') return 'video';
  if (t === 'sticker') return 'sticker';
  return null;
}
