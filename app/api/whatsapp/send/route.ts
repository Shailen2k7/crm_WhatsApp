// =============================================================================
// SEND — the agent presses Send and lands here.
// -----------------------------------------------------------------------------
// V2 accepts three kinds of payload:
//
//   text          {message}                       -> WhatsApp free-form
//   media         {attachments:[{path,...}]}      -> one WhatsApp media message
//                                                    per file, caption on first
//   internal note {message, internal:true}        -> stored in the thread,
//                                                    NEVER sent to WhatsApp
//
// The 24-hour rule is enforced BEFORE Interakt is called — for text AND media.
// Internal notes are exempt: they never leave the building, so the window is
// irrelevant to them. That asymmetry is the whole point of the feature.
//
// Media travels as a time-limited SIGNED url into our private bucket. Interakt
// fetches it within seconds; the link dies within the hour; the file itself
// stays private forever.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendText, sendTemplate, sendMedia, windowState, isConfigured } from '@/lib/interakt';
import { toE164 } from '@/lib/phone';
import { RELAY_BUCKET } from '@/lib/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Attachment { path: string; name: string; mime: string; size: number }

function mediaTypeOf(mime: string): 'image' | 'document' | 'audio' | 'video' {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'document';
}

export async function POST(req: Request) {
  // ---- who is calling ------------------------------------------------------
  const supabase = await createClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 });

  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id, status')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!member || member.status !== 'active') {
    return NextResponse.json({ ok: false, error: 'No active workspace membership.' }, { status: 403 });
  }
  const workspaceId = member.workspace_id as string;

  // ---- parse ---------------------------------------------------------------
  let body: {
    phone?: string;
    conversationId?: string;
    message?: string;
    internal?: boolean;
    attachments?: Attachment[];
    templateName?: string;
    templateLanguage?: string;
    templateValues?: string[];
    /** Candidate values, best-guess order, used to auto-fill and auto-retry. */
    autoValues?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Bad JSON.' }, { status: 400 });
  }

  const text = (body.message || '').trim();
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 10) : [];
  const isTemplate = !!body.templateName;
  const isInternal = !!body.internal;

  if (!text && attachments.length === 0 && !isTemplate) {
    return NextResponse.json({ ok: false, error: 'Message is empty.' }, { status: 400 });
  }
  if (text.length > 4096) {
    return NextResponse.json({ ok: false, error: 'Message is too long (max 4096 characters).' }, { status: 400 });
  }

  const phoneE164 = toE164(body.phone);
  if (!phoneE164) return NextResponse.json({ ok: false, error: 'That contact has no usable phone number.' }, { status: 400 });

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  // ---- conversation --------------------------------------------------------
  let conversationId = body.conversationId;
  if (!conversationId) {
    const { data, error } = await admin.rpc('relay_get_or_create_conversation', {
      p_workspace_id: workspaceId,
      p_phone_e164: phoneE164,
    });
    if (error || !data) return NextResponse.json({ ok: false, error: error?.message || 'Could not open conversation.' }, { status: 500 });
    conversationId = data as string;
  }

  const { data: conv } = await admin
    .from('relay_conversations')
    .select('id, workspace_id, last_inbound_at')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv || conv.workspace_id !== workspaceId) {
    return NextResponse.json({ ok: false, error: 'Conversation not found.' }, { status: 404 });
  }

  // ---- INTERNAL NOTE: store and stop. Never touches WhatsApp. --------------
  if (isInternal) {
    const { data: note, error: noteErr } = await admin
      .from('relay_messages')
      .insert({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        direction: 'out',
        body: text,
        is_internal: true,
        status: 'sent', // there is no delivery pipeline for a note
        sent_by: user.id,
      })
      .select('id')
      .single();
    if (noteErr || !note) return NextResponse.json({ ok: false, error: noteErr?.message || 'Could not save note.' }, { status: 500 });
    return NextResponse.json({ ok: true, messageId: note.id, conversationId, internal: true });
  }

  if (!isConfigured()) {
    return NextResponse.json({ ok: false, error: 'WhatsApp is not connected — INTERAKT_API_KEY is not set.' }, { status: 503 });
  }

  // ---- the 24-hour rule (text AND media, templates exempt) -----------------
  const win = windowState(conv.last_inbound_at);
  if (!isTemplate && !win.open) {
    return NextResponse.json(
      { ok: false, error: 'The 24-hour window is closed. WhatsApp only allows an approved template until they message you again.', code: 'window_closed' },
      { status: 409 }
    );
  }

  // ---- template ------------------------------------------------------------
  //
  // ONE CLICK, NO QUESTIONS. The agent picks a template and it goes.
  //
  // WhatsApp requires exactly as many values as the approved body has {{n}}
  // placeholders, and Interakt will not tell us that number until we try. So:
  // send with our best guess, and if Interakt rejects it for the count, read
  // the number out of its own error, refill from the same candidate list, and
  // retry immediately. The agent sees a sent message, not a form.
  if (isTemplate) {
    const templateName = body.templateName as string;

    // Best-guess values in order: first name, then visa route, then the firm.
    const candidates = (body.autoValues || []).filter((v) => typeof v === 'string');
    const pad = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => (candidates[i] && candidates[i].trim()) || candidates[0] || 'Migrizo');

    // What we know so far about this template's shape.
    const { data: tplRow } = await admin
      .from('relay_templates')
      .select('id, body, variable_count')
      .eq('workspace_id', workspaceId)
      .eq('name', templateName)
      .maybeSingle();

    const known = tplRow?.variable_count ?? 0;
    let values = body.templateValues && body.templateValues.length ? body.templateValues : pad(known);

    /** The approved wording with values filled, for the thread record. */
    const renderBody = (vals: string[]): string => {
      if (tplRow?.body) {
        return tplRow.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m: string, n: string) => vals[Number(n) - 1] || '');
      }
      return `Template “${templateName}”${vals.filter(Boolean).length ? ' · ' + vals.filter(Boolean).join(' · ') : ''}`;
    };

    const { data: msg } = await admin
      .from('relay_messages')
      .insert({
        workspace_id: workspaceId, conversation_id: conversationId, direction: 'out',
        body: renderBody(values),
        template_name: templateName, template_language: body.templateLanguage || null,
        template_values: { bodyValues: values },
        status: 'queued', sent_by: user.id,
      })
      .select('id').single();
    if (!msg) return NextResponse.json({ ok: false, error: 'Could not save message.' }, { status: 500 });

    let result = await sendTemplate({
      phoneE164, templateName,
      languageCode: body.templateLanguage, bodyValues: values, callbackData: msg.id,
    });

    // Wrong number of values? Interakt names the right one. Learn it and retry.
    if (!result.ok) {
      const m = /expected number of values (?:are|is)\s*(\d+)/i.exec(result.detail || '');
      if (m) {
        const required = Number(m[1]);
        values = pad(required);
        if (tplRow?.id) {
          await admin.from('relay_templates')
            .update({ variable_count: required, updated_at: new Date().toISOString() })
            .eq('id', tplRow.id);
        }
        await admin.from('relay_messages')
          .update({ body: renderBody(values), template_values: { bodyValues: values } })
          .eq('id', msg.id);

        result = await sendTemplate({
          phoneE164, templateName,
          languageCode: body.templateLanguage, bodyValues: values, callbackData: msg.id,
        });
      }
    }

    await admin.from('relay_messages').update({
      status: result.ok ? 'sent' : 'failed',
      provider_msg_id: result.providerMsgId || null,
      error_code: result.ok ? null : result.code || 'unknown',
      error_detail: result.ok ? null : (result.detail || '').slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq('id', msg.id);

    if (!result.ok) {
      return NextResponse.json({ ok: false, messageId: msg.id, error: result.detail, code: result.code }, { status: 502 });
    }
    return NextResponse.json({ ok: true, messageId: msg.id, conversationId, valuesUsed: values });
  }

  // ---- media (one WhatsApp message per file, caption rides on the first) ---
  if (attachments.length > 0) {
    const results: { id: string; ok: boolean; error?: string }[] = [];

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const caption = i === 0 ? text : '';
      const mType = mediaTypeOf(att.mime);

      const { data: msg } = await admin
        .from('relay_messages')
        .insert({
          workspace_id: workspaceId, conversation_id: conversationId, direction: 'out',
          body: caption,
          media_path: att.path, media_name: att.name, media_mime: att.mime,
          media_size: att.size, media_type: mType === 'document' ? 'document' : mType,
          status: 'queued', sent_by: user.id,
        })
        .select('id').single();
      if (!msg) { results.push({ id: '', ok: false, error: 'db_insert_failed' }); continue; }

      // Signed URL: Interakt fetches within seconds; the link expires in an hour.
      const { data: signed, error: signErr } = await admin.storage
        .from(RELAY_BUCKET)
        .createSignedUrl(att.path, 3600);

      let result;
      if (signErr || !signed?.signedUrl) {
        // Surface the REAL Supabase error, not a generic string — the generic
        // one made this bug undebuggable in the field.
        console.error('[relay send] sign failed', { path: att.path, err: signErr });
        // "Object not found" means the row still points at a file that is no
        // longer in the bucket — almost always a quick-reply attachment whose
        // file was deleted from Files. Say that, rather than the raw storage
        // error, because the fix is a re-upload and nothing else.
        const missing = /not found/i.test(signErr?.message || '');
        result = {
          ok: false,
          code: missing ? 'file_missing' : 'sign_failed',
          detail: missing
            ? `“${att.name}” is no longer stored — re-attach it in Quick replies and send again.`
            : signErr?.message ? `Link error: ${signErr.message}` : 'Could not create a link for the file.',
        };
      } else {
        result = await sendMedia({
          phoneE164, mediaUrl: signed.signedUrl, mediaType: mType,
          fileName: att.name, caption, callbackData: msg.id,
        });
      }

      await admin.from('relay_messages').update({
        status: result.ok ? 'sent' : 'failed',
        provider_msg_id: ('providerMsgId' in result ? result.providerMsgId : null) || null,
        error_code: result.ok ? null : result.code || 'unknown',
        error_detail: result.ok ? null : (result.detail || '').slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq('id', msg.id);

      results.push({ id: msg.id, ok: result.ok, error: result.ok ? undefined : result.detail });
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length === results.length) {
      return NextResponse.json({ ok: false, error: failed[0]?.error || 'All files failed to send.', results }, { status: 502 });
    }
    return NextResponse.json({ ok: true, conversationId, results, partialFailures: failed.length });
  }

  // ---- plain text ----------------------------------------------------------
  const { data: msg } = await admin
    .from('relay_messages')
    .insert({
      workspace_id: workspaceId, conversation_id: conversationId, direction: 'out',
      body: text, status: 'queued', sent_by: user.id,
    })
    .select('id').single();
  if (!msg) return NextResponse.json({ ok: false, error: 'Could not save message.' }, { status: 500 });

  const result = await sendText({ phoneE164, message: text, callbackData: msg.id });

  await admin.from('relay_messages').update({
    status: result.ok ? 'sent' : 'failed',
    provider_msg_id: result.providerMsgId || null,
    error_code: result.ok ? null : result.code || 'unknown',
    error_detail: result.ok ? null : (result.detail || '').slice(0, 500),
    updated_at: new Date().toISOString(),
  }).eq('id', msg.id);

  if (!result.ok) {
    return NextResponse.json({ ok: false, messageId: msg.id, error: result.detail || 'Interakt rejected the message.', code: result.code }, { status: 502 });
  }
  return NextResponse.json({ ok: true, messageId: msg.id, conversationId, providerMsgId: result.providerMsgId });
}
