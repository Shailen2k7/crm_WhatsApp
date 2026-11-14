// =============================================================================
// BROADCAST SEND — one approved template to one person.
// -----------------------------------------------------------------------------
// Same discipline as every other send in the app: a relay_messages row is
// written FIRST (so the message shows in the chat thread with ticks, and the
// webhook can stamp delivered / read / failed on it), then Interakt is called,
// then the outcome is recorded.
//
// TWO THINGS ARE DELIBERATE, and both protect the automations:
//
//   * A broadcast message is saved with sent_by = null, like an automated one.
//     The chases stop for good when "a person on the team" writes to someone;
//     a broadcast to 2,000 cold leads must not end 2,000 cold chases. Saved
//     this way it only makes the engines wait their usual 20 hours.
//
//   * A send Interakt REFUSES ON THE SPOT (bad number, empty wallet) is saved
//     against the person who launched it. The engines read "an automated
//     message failed near my step" as "my step was refused" and would re-send
//     that step; a broadcast failure is none of their business.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTemplate, type CallLimits, type SendResult } from '@/lib/interakt';
import { RELAY_BUCKET } from '@/lib/files';
import { templateHeaderDoc } from '@/lib/template-header';
import { renderBody, type TemplateHeader } from './model';

export interface ResolvedHeader {
  url: string;
  fileName: string | null;
  mediaType: 'document' | 'image' | 'video';
  /** Set when the file is one of ours (Files → template headers). */
  path?: string; mime?: string; size?: number;
}

const MEDIA_FORMATS = new Set(['DOCUMENT', 'IMAGE', 'VIDEO']);

/**
 * The file that rides on top of a template approved with a document / image /
 * video header. Ours first (Files → template headers, the customer sees that
 * file's name); otherwise the one Interakt holds from when the template was
 * created. `missing` means the template needs a file and there is none.
 */
export async function resolveHeader(
  admin: SupabaseClient, templateName: string, header: TemplateHeader | null,
): Promise<{ header: ResolvedHeader | null; missing: boolean }> {
  const format = (header?.format || '').toUpperCase();
  const doc = await templateHeaderDoc(admin, RELAY_BUCKET, templateName);
  if (doc) {
    const { data: signed } = await admin.storage.from(RELAY_BUCKET).createSignedUrl(doc.path, 3600);
    if (signed?.signedUrl) {
      const mime = (doc.mime || '').toLowerCase();
      const mediaType = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'document';
      return { header: { url: signed.signedUrl, fileName: doc.name, mediaType, path: doc.path, mime: doc.mime, size: doc.size }, missing: false };
    }
  }
  if (!MEDIA_FORMATS.has(format)) return { header: null, missing: false };
  if (header?.url) {
    return {
      header: {
        url: header.url, fileName: header.fileName,
        mediaType: format === 'IMAGE' ? 'image' : format === 'VIDEO' ? 'video' : 'document',
      },
      missing: false,
    };
  }
  return { header: null, missing: true };
}

/** WhatsApp's *bold* and _italic_ marks, dropped for the thread (it shows text as typed). */
function plain(body: string): string {
  return body
    .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '$1')
    .replace(/(^|[\s(])_(\S(?:[^_\n]*\S)?)_(?=$|[\s).,!?])/g, '$1$2');
}

/** What a failure means, in a sentence a person can act on. */
export function friendlyFailure(code: string | null | undefined, detail: string | null | undefined): string {
  const c = String(code || '');
  const d = String(detail || '');
  if (c === '131049') return 'WhatsApp held it back — this person is getting too many marketing messages right now.';
  if (c === '131026') return 'This number cannot receive WhatsApp messages.';
  if (c === '130472') return 'WhatsApp held it back — their number is in a Meta trial that blocks marketing messages.';
  if (c === '131048') return 'WhatsApp is limiting how many messages this business number can send right now.';
  if (/wallet/i.test(d) && /balance/i.test(d)) return 'Interakt balance ran out.';
  if (/phone number & country code provided is invalid/i.test(d) || c === 'bad_phone') return 'Not a valid phone number.';
  if (/customer is not available/i.test(d)) return 'Interakt does not recognise this number.';
  if (/media url is missing for header/i.test(d)) return 'This template needs its file (PDF or image) and none is set up.';
  if (/no approved template found/i.test(d)) return 'Interakt has no approved template with this name.';
  if (/expected number of values/i.test(d)) return 'The template has a different number of blanks than expected — press Refresh on the template list and try again.';
  if (c === 'timeout') return 'Interakt did not answer in time — delivery unknown.';
  return d.replace(/^Please correct the following error - /i, '').slice(0, 200) || 'Could not be sent.';
}

export const isWalletError = (detail: string | null | undefined) =>
  /wallet/i.test(detail || '') && /balance/i.test(detail || '');

export interface BroadcastSendResult {
  ok: boolean;
  messageId: string | null;
  /** Interakt accepted nothing and said nothing in time: it may still arrive. */
  timedOut: boolean;
  code: string | null;
  detail: string | null;
}

export async function sendBroadcastMessage(
  admin: SupabaseClient,
  args: {
    workspaceId: string;
    conversationId: string;
    phoneE164: string;
    templateName: string;
    language: string;
    /** The approved wording, {{n}} still in it. */
    body: string;
    values: string[];
    header: ResolvedHeader | null;
    /** null for a broadcast; the user for a test send (it IS a person writing). */
    sentBy: string | null;
    /** Who an on-the-spot failure is filed under (see the header comment). */
    failOwner: string | null;
    limits?: CallLimits;
  },
): Promise<BroadcastSendResult> {
  const { workspaceId: ws, conversationId, phoneE164, language, body, values, header } = args;
  let templateName = args.templateName;

  const media = !header ? {}
    : header.path
      ? { media_path: header.path, media_name: header.fileName, media_mime: header.mime || null, media_size: header.size || null, media_type: header.mediaType }
      : { media_url: header.url, media_name: header.fileName, media_type: header.mediaType };

  const { data: msg, error: insErr } = await admin
    .from('relay_messages')
    .insert({
      workspace_id: ws, conversation_id: conversationId, direction: 'out',
      body: plain(renderBody(body, values)) || `Template “${templateName}”`,
      template_name: templateName, template_language: language,
      template_values: { bodyValues: values },
      ...media,
      status: 'queued', sent_by: args.sentBy,
    })
    .select('id')
    .single();
  if (insErr || !msg) {
    return { ok: false, messageId: null, timedOut: false, code: 'db', detail: insErr?.message || 'Could not save the message.' };
  }

  const call = (name: string): Promise<SendResult> => sendTemplate({
    phoneE164, templateName: name, languageCode: language, bodyValues: values,
    ...(header ? { headerValues: [header.url], fileName: header.fileName || undefined } : {}),
    callbackData: msg.id, limits: args.limits,
  });

  let result = await call(templateName);

  // Interakt's screen shows names in capitals while Meta stores them lower
  // case. A name right in spirit and wrong on the wire gets one more try.
  if (!result.ok && /no approved template found/i.test(result.detail || '')) {
    const alt = templateName === templateName.toLowerCase() ? templateName.toUpperCase() : templateName.toLowerCase();
    if (alt !== templateName) {
      const retry = await call(alt);
      if (retry.ok) {
        result = retry;
        templateName = alt;
        await admin.from('relay_messages').update({ template_name: alt }).eq('id', msg.id);
      }
    }
  }

  // A timeout is not a failure: Interakt may have taken the message and just
  // answered slowly. The row stays 'queued' until the webhook says what
  // happened; calling it failed would invite a retry and a duplicate.
  const timedOut = !result.ok && result.code === 'timeout';

  await admin.from('relay_messages').update({
    status: result.ok ? 'sent' : timedOut ? 'queued' : 'failed',
    provider_msg_id: result.providerMsgId || null,
    error_code: result.ok ? null : result.code || 'unknown',
    error_detail: result.ok ? null : (result.detail || '').slice(0, 500),
    ...(!result.ok && !timedOut && args.failOwner ? { sent_by: args.failOwner } : {}),
    updated_at: new Date().toISOString(),
  }).eq('id', msg.id);

  return {
    ok: result.ok, messageId: msg.id, timedOut,
    code: result.ok ? null : result.code || 'unknown',
    detail: result.ok ? null : result.detail || 'send failed',
  };
}
