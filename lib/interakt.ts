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
// Every assigned ITU E.164 calling code. A hand-picked shortlist here cost
// real leads: +31 (Netherlands), +48 (Poland), +60 (Malaysia), +966 (Saudi)
// and +968 (Oman) all fell through to a guess that chopped the number in the
// wrong place, Interakt rejected the mangled result, and those people never
// got their first message.
const CALLING_CODES = new Set([
  '1', '7', '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41',
  '43', '44', '45', '46', '47', '48', '49', '51', '52', '53', '54', '55', '56',
  '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86',
  '90', '91', '92', '93', '94', '95', '98',
  '211', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225',
  '226', '227', '228', '229', '230', '231', '232', '233', '234', '235', '236',
  '237', '238', '239', '240', '241', '242', '243', '244', '245', '246', '247',
  '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258',
  '260', '261', '262', '263', '264', '265', '266', '267', '268', '269', '290',
  '291', '297', '298', '299',
  '350', '351', '352', '353', '354', '355', '356', '357', '358', '359', '370',
  '371', '372', '373', '374', '375', '376', '377', '378', '379', '380', '381',
  '382', '383', '385', '386', '387', '389',
  '420', '421', '423',
  '500', '501', '502', '503', '504', '505', '506', '507', '508', '509', '590',
  '591', '592', '593', '594', '595', '596', '597', '598', '599',
  '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681',
  '682', '683', '685', '686', '687', '688', '689', '690', '691', '692',
  '850', '852', '853', '855', '856', '880', '886',
  '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971',
  '972', '973', '974', '975', '976', '977', '992', '993', '994', '995', '996',
  '998',
]);

export function splitE164(e164: string): { countryCode: string; phoneNumber: string } | null {
  const digits = String(e164 || '').replace(/\D/g, '');
  if (digits.length < 8) return null;

  // Longest assigned code wins. The set is prefix-free, so trying 3 then 2
  // then 1 digits can never pick the wrong country.
  for (const len of [3, 2, 1]) {
    const cc = digits.slice(0, len);
    if (CALLING_CODES.has(cc) && digits.length - len >= 6) {
      return { countryCode: '+' + cc, phoneNumber: digits.slice(len).replace(/^0+/, '') };
    }
  }
  return null;   // not a real calling code — better to fail loudly than mangle
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

  const j = (json || {}) as {
    result?: boolean; id?: string; message?: string; error?: unknown;
    nonJson?: string; errors?: unknown; detail?: string;
  };

  if (!res.ok || j.result === false) {
    // Never swallow the reason. Interakt normally answers with {message}, but a
    // rate-limiter or WAF in front of it answers with HTML, and the old code
    // turned that into a bare "Interakt returned 400." — 31 people were never
    // messaged and the log could not say why. Whatever shape the body is, some
    // of it goes in the record.
    const fallback = j.nonJson
      ? `Non-JSON body: ${j.nonJson.slice(0, 200)}`
      : j.errors
        ? `errors: ${JSON.stringify(j.errors).slice(0, 200)}`
        : json
          ? `body: ${JSON.stringify(json).slice(0, 200)}`
          : `Interakt returned ${res.status} with an empty body.`;
    return {
      ok: false,
      code: `http_${res.status}`,
      detail: j.message || j.detail || (typeof j.error === 'string' ? j.error : '') || fallback,
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

/**
 * Media message — image, document, audio or video, inside the 24-hour window.
 * Interakt fetches the file itself from `mediaUrl`, so the URL must be
 * reachable from their servers: we hand them a time-limited SIGNED url to our
 * private bucket, never a permanent public one.
 */
export async function sendMedia(opts: {
  phoneE164: string;
  mediaUrl: string;
  mediaType: 'image' | 'document' | 'audio' | 'video';
  fileName?: string;
  caption?: string;
  callbackData?: string;
}): Promise<SendResult> {
  const split = splitE164(opts.phoneE164);
  if (!split) return { ok: false, code: 'bad_phone', detail: `Not a usable number: ${opts.phoneE164}` };

  const TYPE: Record<string, string> = { image: 'Image', document: 'Document', audio: 'Audio', video: 'Video' };

  return post('/message/', {
    countryCode: split.countryCode,
    phoneNumber: split.phoneNumber,
    type: TYPE[opts.mediaType] || 'Document',
    callbackData: opts.callbackData,
    data: {
      message: opts.caption || '',
      mediaUrl: opts.mediaUrl,
      // Documents keep the human's filename; other types ignore it harmlessly.
      fileName: opts.fileName,
    },
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
