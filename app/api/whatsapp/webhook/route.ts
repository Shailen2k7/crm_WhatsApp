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
import { RELAY_BUCKET, MAX_UPLOAD_BYTES, mediaPath, safeFilename, mimeFor } from '@/lib/files';
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
 * Returns what got stored, or nulls on failure — in which case the message
 * keeps the CDN url as a fallback and the archiver can retry later.
 */
async function archiveMedia(
  admin: SupabaseClient,
  opts: { workspaceId: string; conversationId: string; messageId: string; url: string; contentTypeHint?: string | null }
): Promise<{ path: string; name: string; mime: string; size: number } | null> {
  try {
    const res = await fetch(opts.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength === 0 || ab.byteLength > MAX_UPLOAD_BYTES) return null;
    const buf = Buffer.from(new Uint8Array(ab));

    // Name: last URL segment if it looks like a filename, else sniff the bytes.
    const urlName = decodeURIComponent(opts.url.split('?')[0].split('/').pop() || '');
    const declaredMime = res.headers.get('content-type') || opts.contentTypeHint || null;
    const { filename, ext } = safeFilename({ name: urlName, mime: declaredMime, buf, fallback: 'whatsapp-file' });
    const mime = mimeFor(ext, declaredMime);
    const path = mediaPath(opts.workspaceId, opts.conversationId, opts.messageId, filename);

    const { error } = await admin.storage.from(RELAY_BUCKET).upload(path, buf, {
      contentType: mime,
      upsert: true,
    });
    if (error) return null;
    return { path, name: filename, mime, size: buf.byteLength };
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
        .select('id');

      // TICK FIX: some status events echo our callbackData rather than the id
      // we stored. callbackData IS our message row's uuid (set at send), so a
      // zero-row update falls back to matching on it directly.
      if (!updated || updated.length === 0) {
        const meta = (message?.meta_data || {}) as Record<string, unknown>;
        const cb = String(
          meta.callback_data ?? meta.callbackData ??
          (payload.data as Record<string, unknown> | undefined)?.callback_data ?? ''
        );
        if (/^[0-9a-f-]{36}$/i.test(cb)) {
          await admin.from('relay_messages').update(patch).eq('id', cb);
        }
      }

      await logAttempt({ ok: true, reason: auth.how, eventType, sigPresent: !!sig, phone: customer?.channel_phone_number, handled: 'status:' + status });
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

      const { data: inserted, error: msgErr } = await admin
        .from('relay_messages')
        .insert({
          workspace_id: ws.id,
          conversation_id: convId,
          direction: 'in',
          body: message?.message || '',
          provider_msg_id: providerMsgId || null,
          status: 'received',
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
        });
        if (stored) {
          await admin.from('relay_messages').update({
            media_path: stored.path,
            media_name: stored.name,
            media_mime: stored.mime,
            media_size: stored.size,
          }).eq('id', inserted.id);
        }
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
        title: `${who} · WhatsApp`,
        body: previewText.slice(0, 140),
        url: '/',
        tag: `wa-${convId}`,
      });

      await logAttempt({ ok: true, reason: auth.how, eventType, sigPresent: !!sig, phone: customer?.channel_phone_number, handled: msgErr ? 'insert_failed' : 'message_stored' });
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
