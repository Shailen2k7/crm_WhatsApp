// =============================================================================
// WEBHOOK — Interakt POSTs here for every inbound message and status update.
// -----------------------------------------------------------------------------
// Public by necessity (Interakt has no session), so it authenticates with the
// shared secret in ?key=. Compared in constant time: a timing-safe compare on a
// URL secret costs nothing and removes a whole class of attack.
//
// THE RULE THIS FILE OBEYS: always answer 200, unless the caller is not
// Interakt. A provider that receives a 500 will retry, and retries on a message
// we already stored produce duplicates in the customer's thread. So genuine
// processing failures are logged and swallowed — one lost status update beats a
// doubled conversation.
//
// Inbound messages are deduplicated on Interakt's own message id.
// =============================================================================
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { statusFromEvent, mediaTypeFrom, type InteraktWebhook } from '@/lib/interakt';
import { toE164 } from '@/lib/phone';
import { timingSafeEqual } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function secretMatches(provided: string | null): boolean {
  const expected = process.env.INTERAKT_WEBHOOK_SECRET;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!secretMatches(url.searchParams.get('key'))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let payload: InteraktWebhook;
  try {
    payload = (await req.json()) as InteraktWebhook;
  } catch {
    // Malformed body is not something a retry will fix.
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
      await admin
        .from('relay_messages')
        .update({
          status,
          error_code: message?.channel_error_code || null,
          error_detail: message?.channel_failure_reason || null,
          updated_at: new Date().toISOString(),
        })
        .eq('provider_msg_id', providerMsgId);

      return NextResponse.json({ ok: true, handled: eventType });
    }

    // ---- inbound message from a customer -----------------------------------
    if (eventType === 'message_received') {
      const phoneE164 = toE164(customer?.channel_phone_number);
      if (!phoneE164) return NextResponse.json({ ok: true, ignored: 'no_phone' });

      // Single-tenant, exactly as the CRM's own ingest route resolves it.
      const { data: ws } = await admin
        .from('workspaces')
        .select('id')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!ws) return NextResponse.json({ ok: true, ignored: 'no_workspace' });

      // Interakt retries. Without this check a retry appends the customer's
      // message to the thread a second time.
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
        return NextResponse.json({ ok: true, ignored: 'conversation_failed' });
      }

      const mediaType = mediaTypeFrom(message?.message_content_type);

      const { error: msgErr } = await admin.from('relay_messages').insert({
        workspace_id: ws.id,
        conversation_id: convId,
        direction: 'in',
        body: message?.message || '',
        provider_msg_id: providerMsgId || null,
        status: 'received',
        media_url: message?.media_url || null,
        media_type: mediaType,
        created_at: message?.received_at_utc || new Date().toISOString(),
      });
      if (msgErr) console.error('[relay webhook] insert failed', msgErr);

      return NextResponse.json({ ok: true, handled: 'message_received' });
    }

    return NextResponse.json({ ok: true, ignored: eventType || 'unknown_type' });
  } catch (e) {
    // Never 500 at Interakt — that buys retries and duplicates.
    console.error('[relay webhook] unhandled', e);
    return NextResponse.json({ ok: true, error: 'logged' });
  }
}

/** Interakt shows a green tick when this returns 200 to a GET. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const authed = secretMatches(url.searchParams.get('key'));
  return NextResponse.json(
    { ok: true, endpoint: 'relay whatsapp webhook', authenticated: authed },
    { status: authed ? 200 : 401 }
  );
}
