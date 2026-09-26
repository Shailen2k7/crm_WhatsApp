// =============================================================================
// WEBHOOK — Interakt POSTs here for every inbound message and status update.
// -----------------------------------------------------------------------------
// AUTH: HMAC-SHA256 over the raw body, sent as Interakt-Signature. The secret
// never crosses the wire; the signature also proves the body is untampered.
// A ?key= query fallback exists purely for curl during setup.
//
// WHAT V2 ADDED HERE:
//   * Inbound MEDIA is pulled from Interakt's CDN immediately and stored in our
//     own private bucket. Their URLs expire; a client's passport must not.
//   * Every accepted inbound message pushes a notification to the whole team's
//     phones and desktops.
//   * Status updates match by provider id FIRST, then fall back to the
//     callbackData we set at send time — some Interakt events echo callback
//     but not the message id, which is why read ticks were unreliable.
//
// THE RULE: always answer 200 once authenticated. A 500 buys retries, and
// retries duplicate the customer's thread.
// =============================================================================
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { statusFromEvent, mediaTypeFrom, type InteraktWebhook } from '@/lib/interakt';
import { toE164 } from '@/lib/phone';
import { pushToWorkspace } from '@/lib/push-server';
import { RELAY_BUCKET, MAX_UPLOAD_BYTES, mediaPath, safeFilename, mimeFor, presentableName } from '@/lib/files';
import { captureCvFromDocument } from '@/lib/cv-capture';
import { createHmac, timingSafeEqual } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function verify(rawBody: string, signature: string | null, queryKey: string | null): { ok: boolean; how: string } {
  const secret = process.env.INTERAKT_WEBHOOK_SECRET;
  if (!secret) return { ok: false, how: 'no_secret_configured' };

  if (signature) {
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    if (safeEqual(signature.trim(), expected)) return { ok: true, how: 'signature' };
    const bare = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    if (safeEqual(signature.trim(), bare)) return { ok: true, how: 'signature_bare' };
    return { ok: false, how: 'signature_mismatch' };
  }
  if (queryKey && safeEqual(queryKey, secret)) return { ok: true, how: 'query_key' };
  return { ok: false, how: 'no_signature' };
}

/**
 * WHOSE MESSAGE IS THIS?
 *
 * Interakt fires `message_received` for traffic on a conversation — including
 * replies YOUR OWN TEAM sends from Interakt's inbox. Storing all of them as
 * inbound put our own replies on the left-hand side of the thread, as if the
 * client had said them. Wrong, and confusing to read.
 *
 * `chat_message_type` is the discriminator: "CustomerMessage" is the client;
 * anything else (UserMessage / AgentMessage / APIMessage …) is us.
 * Unknown/absent falls back to inbound, because mislabelling a client message
 * as ours would hide it from the unread count — the more damaging error.
 */
function directionOf(chatMessageType: string | undefined | null): 'in' | 'out' {
  const t = (chatMessageType || '').trim().toLowerCase();
  if (!t) return 'in';
  if (t === 'customermessage' || t === 'customer') return 'in';
  return 'out';
}

async function logAttempt(row: {
  ok: boolean; reason: string; eventType?: string | null; sigPresent: boolean;
  phone?: string | null; bodyPreview?: string | null; handled?: string | null;
}) {
  try {
    const admin = createAdminClient();
    if (!admin) return;
    await admin.from('relay_webhook_log').insert({
      ok: row.ok,
      reason: row.reason,
      event_type: row.eventType ?? null,
      sig_present: row.sigPresent,
      phone: row.phone ?? null,
      body_preview: (row.bodyPreview || '').slice(0, 200) || null,
      handled: row.handled ?? null,
    });
  } catch { /* best-effort */ }
}

/**
 * Downloads inbound media from Interakt's CDN into our private bucket.
 *
 * `path` is null when the file arrived but could not be archived — too big for
 * the bucket, or the upload failed. The bytes are still returned in that case,
 * because a 30 MB PDF is often somebody's CV and its text belongs on the lead
 * whether or not we keep a copy of the file. Five documents were lost this way
 * before this was split apart: the download succeeded, the archive did not, and
 * nothing downstream ever ran.
 *
 * Returns null only when there are no bytes at all.
 */
async function archiveMedia(
  admin: SupabaseClient,
  opts: { workspaceId: string; conversationId: string; messageId: string; url: string; contentTypeHint?: string | null; mediaType?: string | null }
): Promise<{ path: string | null; name: string; mime: string; size: number; buf: Buffer } | null> {
  try {
    const res = await fetch(opts.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength === 0) return null;
    const buf = Buffer.from(new Uint8Array(ab));

    // Name: last URL segment if it looks like a filename, else sniff the bytes.
    const urlName = decodeURIComponent(opts.url.split('?')[0].split('/').pop() || '');
    const declaredMime = res.headers.get('content-type') || opts.contentTypeHint || null;
    const { filename: rawFilename, ext } = safeFilename({ name: urlName, mime: declaredMime, buf, fallback: 'whatsapp-file' });
    // CDN hashes ("HbvMvkhxttDr.pdf") become "Migrizo Document <date>.pdf".
    const filename = presentableName(rawFilename, opts.mediaType ?? null, new Date());
    const mime = mimeFor(ext, declaredMime);
    const path = mediaPath(opts.workspaceId, opts.conversationId, opts.messageId, filename);

    if (buf.byteLength > MAX_UPLOAD_BYTES) {
      return { path: null, name: filename, mime, size: buf.byteLength, buf };
    }
    const { error } = await admin.storage.from(RELAY_BUCKET).upload(path, buf, {
      contentType: mime,
      upsert: true,
    });
    return { path: error ? null : path, name: filename, mime, size: buf.byteLength, buf };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const url = new URL(req.url);

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: 'unreadable_body' }, { status: 400 });
  }

  const sig = req.headers.get('interakt-signature') || req.headers.get('x-interakt-signature') || null;

  const auth = verify(rawBody, sig, url.searchParams.get('key'));
  if (!auth.ok) {
    console.error('[relay webhook] rejected:', auth.how, 'sigPresent=', !!sig);
    await logAttempt({ ok: false, reason: auth.how, sigPresent: !!sig, bodyPreview: rawBody });
    return NextResponse.json({ ok: false, error: auth.how }, { status: 401 });
  }

  let payload: InteraktWebhook;
  try {
    payload = JSON.parse(rawBody) as InteraktWebhook;
  } catch {
    return NextResponse.json({ ok: true, ignored: 'bad_json' });
  }

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: true, ignored: 'not_configured' });

  try {
    const eventType = payload.type || '';
    const message = payload.data?.message;
    const customer = payload.data?.customer;
    const providerMsgId = message?.id;

    // ---- status update on something we sent --------------------------------
    const status = statusFromEvent(eventType);
    if (status && providerMsgId) {
      const patch = {
        status,
        error_code: message?.channel_error_code || null,
        error_detail: message?.channel_failure_reason || null,
        updated_at: new Date().toISOString(),
      };

      const { data: updated } = await admin
        .from('relay_messages')
        .update(patch)
        .eq('provider_msg_id', providerMsgId)
        .select('id, direction');

      // SELF-HEALING DIRECTION.
      // A delivery/read receipt only ever exists for a message the BUSINESS
      // sent — WhatsApp never tells us a customer's own message was delivered
      // to them. So a receipt arriving for a row we filed as inbound is proof
      // that row is on the wrong side, and we correct it without being asked.
      const misfiled = (updated || []).filter((r) => (r as { direction?: string }).direction === 'in');
      if (misfiled.length > 0) {
        await admin
          .from('relay_messages')
          .update({ direction: 'out' })
          .in('id', misfiled.map((r) => (r as { id: string }).id));
        console.warn('[relay webhook] corrected', misfiled.length, 'misfiled message(s) to outbound');
      }

      // Some status events echo our callbackData rather than the id we
      // stored. callbackData IS our message row's uuid (set at send), so a
      // zero-row update falls back to matching on it directly. This runs
      // BEFORE the sent-from-Interakt fallback below: it used to run after,
      // and a message of ours whose provider id did not match got a duplicate
      // placeholder bubble inserted first — the '[template sent from
      // Interakt]' junk in the middle of a thread we ourselves wrote.
      let matched = (updated?.length ?? 0) > 0;
      if (!matched) {
        const meta = (message?.meta_data || {}) as Record<string, unknown>;
        const cb = String(
          meta.callback_data ?? meta.callbackData ??
          (payload.data as Record<string, unknown> | undefined)?.callback_data ?? ''
        );
        if (/^[0-9a-f-]{36}$/i.test(cb)) {
          const { data: cbHit } = await admin.from('relay_messages').update(patch).eq('id', cb).select('id');
          matched = (cbHit?.length ?? 0) > 0;
        }
      }

      // A status event for a message we truly never stored means it was sent
      // from INTERAKT'S OWN INBOX, not from Relay. Record it on the correct
      // side with the best text we can find — the payload's own text if it
      // carries one, else the template's wording from our library — never a
      // bracketed placeholder.
      if (!matched && status === 'sent' && customer?.channel_phone_number) {
        const phoneE164 = toE164(customer.channel_phone_number);
        const { data: ws0 } = await admin.from('workspaces').select('id').order('created_at', { ascending: true }).limit(1).maybeSingle();
        if (phoneE164 && ws0) {
          const { data: cid } = await admin.rpc('relay_get_or_create_conversation', { p_workspace_id: ws0.id, p_phone_e164: phoneE164 });
          if (cid) {
            const { data: dupe } = await admin.from('relay_messages').select('id').eq('provider_msg_id', providerMsgId).maybeSingle();
            if (!dupe) {
              const m = (message || {}) as Record<string, unknown>;
              let body = typeof m.message === 'string' ? m.message.trim() : '';
              const tplName = String(m.template_name || (m.template as Record<string, unknown> | undefined)?.name || '');
              if (!body && tplName) {
                const { data: tpl } = await admin
                  .from('relay_templates').select('body')
                  .eq('workspace_id', ws0.id).ilike('name', tplName).maybeSingle();
                if (tpl?.body) body = tpl.body;
              }
              if (!body) {
                body = m.is_template_message
                  ? 'Template sent from the Interakt dashboard'
                  : 'Sent from the Interakt dashboard';
              }
              await admin.from('relay_messages').insert({
                workspace_id: ws0.id,
                conversation_id: cid,
                direction: 'out',
                body,
                template_name: tplName || null,
                provider_msg_id: providerMsgId,
                status: 'sent',
              });
            }
          }
        }
      }

      await logAttempt({ ok: true, reason: auth.how, eventType, sigPresent: !!sig, phone: customer?.channel_phone_number, handled: 'status:' + status, bodyPreview: rawBody });
      return NextResponse.json({ ok: true, handled: eventType });
    }

    // ---- inbound message from a customer -----------------------------------
    if (eventType === 'message_received') {
      const phoneE164 = toE164(customer?.channel_phone_number);
      if (!phoneE164) return NextResponse.json({ ok: true, ignored: 'no_phone' });

      const { data: ws } = await admin
        .from('workspaces')
        .select('id')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!ws) return NextResponse.json({ ok: true, ignored: 'no_workspace' });

      // Interakt retries; dedupe on their message id.
      if (providerMsgId) {
        const { data: existing } = await admin
          .from('relay_messages')
          .select('id')
          .eq('provider_msg_id', providerMsgId)
          .maybeSingle();
        if (existing) return NextResponse.json({ ok: true, duplicate: true });
      }

      const { data: convId, error: convErr } = await admin.rpc('relay_get_or_create_conversation', {
        p_workspace_id: ws.id,
        p_phone_e164: phoneE164,
      });
      if (convErr || !convId) {
        console.error('[relay webhook] conversation failed', convErr);
        await logAttempt({ ok: true, reason: auth.how, eventType, sigPresent: !!sig, phone: customer?.channel_phone_number, handled: 'conversation_failed' });
        return NextResponse.json({ ok: true, ignored: 'conversation_failed' });
      }

      const mediaType = mediaTypeFrom(message?.message_content_type);
      const direction = directionOf(message?.chat_message_type);

      // Interakt sends Python's literal "None" as the caption of caption-less
      // media. Rendering the word "None" under a client's CV looks broken.
      let bodyText = message?.message || '';
      if (mediaType && (bodyText === 'None' || bodyText === 'null')) bodyText = '';

      const { data: inserted, error: msgErr } = await admin
        .from('relay_messages')
        .insert({
          workspace_id: ws.id,
          conversation_id: convId,
          direction,
          body: bodyText,
          provider_msg_id: providerMsgId || null,
          // An agent's reply typed in Interakt is already delivered by the time
          // we hear about it; a client's message is simply "received".
          status: direction === 'out' ? 'delivered' : 'received',
          media_url: message?.media_url || null,
          media_type: mediaType,
          created_at: message?.received_at_utc || new Date().toISOString(),
        })
        .select('id')
        .single();
      if (msgErr) console.error('[relay webhook] insert failed', msgErr);

      // Archive media into OUR bucket right now — Interakt's CDN links expire,
      // and these files are CVs and passports. The row is updated in place so
      // the UI flips from "downloading" to a real file within a second or two.
      if (inserted && message?.media_url) {
        const stored = await archiveMedia(admin, {
          workspaceId: ws.id,
          conversationId: convId as string,
          messageId: inserted.id,
          url: message.media_url,
          mediaType,
        });
        if (stored) {
          await admin.from('relay_messages').update({
            // Null when the file was too big to keep: the message then falls
            // back to the CDN url, exactly as it did before it was downloaded.
            ...(stored.path ? { media_path: stored.path } : {}),
            media_name: stored.name,
            media_mime: stored.mime,
            media_size: stored.size,
          }).eq('id', inserted.id);

          // A client's document might be their CV. If it reads like one, the
          // text lands on the lead right now, so the CRM drawer shows "View
          // profile" without anyone touching a file. Strict threshold, no
          // matching needed (the conversation already knows its lead), and
          // never allowed to fail the webhook.
          //
          // Runs on the bytes, not on the archive: a CV we could not file away
          // is still a CV, and leaving it unread is how people got missed.
          if (direction === 'in' && mediaType === 'document') {
            const cv = await captureCvFromDocument(admin, {
              workspaceId: ws.id, conversationId: convId as string, messageId: inserted.id,
              buf: stored.buf, filename: stored.name, mime: stored.mime,
            });
            if (cv.captured) console.log('[relay webhook] cv captured', inserted.id, cv.reason);
          }
        }
      }

      // A reply we sent ourselves must not ring our own phones.
      if (direction === 'out') {
        await logAttempt({
          ok: true, reason: auth.how, eventType, sigPresent: !!sig,
          phone: customer?.channel_phone_number,
          handled: `out · chat_message_type=${message?.chat_message_type || 'ABSENT'}`,
        });
        return NextResponse.json({ ok: true, handled: 'message_received', direction: 'out' });
      }

      // Any reply at all takes this person out of the C1–C8 follow-up machine:
      // they answered, so a human owns the conversation from here.
      await admin
        .from('relay_lead_sequences')
        .update({ status: 'replied', exit_reason: 'replied', exited_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('phone_e164', phoneE164)
        .eq('status', 'active');

      // Honour "Reply STOP to opt out": one word, alone, in the inbound text.
      // Automations check relay_suppressions before every send.
      const inboundText = (message?.message || '').trim().toLowerCase();
      if (/^(stop|unsubscribe|opt ?out)$/.test(inboundText)) {
        await admin.from('relay_suppressions').upsert(
          { workspace_id: ws.id, phone_e164: phoneE164, reason: 'stop' },
          { onConflict: 'workspace_id,phone_e164' },
        );
      }

      // Wake the team up. Name the sender if the CRM knows them.
      const { data: conv } = await admin
        .from('relay_conversations')
        .select('lead_id')
        .eq('id', convId)
        .maybeSingle();
      let who = phoneE164;
      if (conv?.lead_id) {
        const { data: lead } = await admin.from('leads').select('full_name').eq('id', conv.lead_id).maybeSingle();
        if (lead?.full_name) who = lead.full_name;
      }
      const previewText = message?.message || (mediaType ? `📎 ${mediaType === 'image' ? 'Photo' : mediaType === 'document' ? 'Document' : 'Attachment'}` : 'New message');
      await pushToWorkspace(admin, ws.id, {
        title: `${who} · Migrizo WhatsApp`,
        body: previewText.slice(0, 140),
        url: '/',
        tag: `wa-${convId}`,
      });

      await logAttempt({
        ok: true, reason: auth.how, eventType, sigPresent: !!sig,
        phone: customer?.channel_phone_number,
        handled: msgErr ? 'insert_failed' : `in · chat_message_type=${message?.chat_message_type || 'ABSENT'}`,
      });
      return NextResponse.json({ ok: true, handled: 'message_received' });
    }

    await logAttempt({ ok: true, reason: auth.how, eventType, sigPresent: !!sig, phone: customer?.channel_phone_number, handled: 'ignored' });
    return NextResponse.json({ ok: true, ignored: eventType || 'unknown_type' });
  } catch (e) {
    console.error('[relay webhook] unhandled', e);
    return NextResponse.json({ ok: true, error: 'logged' });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: 'relay whatsapp webhook',
    secretConfigured: !!process.env.INTERAKT_WEBHOOK_SECRET,
    databaseConfigured: !!createAdminClient(),
    pushConfigured: !!process.env.VAPID_PRIVATE_KEY,
    verifies: 'HMAC-SHA256 over the raw body, sent as Interakt-Signature',
  });
}
