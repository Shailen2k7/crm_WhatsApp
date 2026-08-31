// =============================================================================
// WEBHOOK — Interakt POSTs here for every inbound message and status update.
// -----------------------------------------------------------------------------
// AUTHENTICATION — HMAC, not a shared token in the URL.
//
// Interakt never transmits the secret key. It uses the secret configured in
// Developer Settings to sign the raw request body, and sends the result as:
//
//     Interakt-Signature: sha256=<hex hmac-sha256 of the raw body>
//
// So we recompute that HMAC with our copy of the secret and compare in constant
// time. This is strictly better than a token in the query string: the secret
// never crosses the wire, and a signature proves the BODY is untampered, not
// merely that the caller knew a password.
//
// The raw body must be read as text BEFORE parsing — re-serialising parsed JSON
// would change the bytes (key order, whitespace) and the signature would never
// match.
//
// A ?key= query parameter is also accepted, purely so the endpoint can be
// exercised with curl during setup. Interakt itself never uses it.
//
// THE RULE THIS FILE OBEYS: always answer 200 once authenticated. A provider
// that receives a 500 retries, and retries on a message we already stored
// duplicate the customer's thread. Genuine failures are logged and swallowed —
// one lost status update beats a doubled conversation.
// =============================================================================
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { statusFromEvent, mediaTypeFrom, type InteraktWebhook } from '@/lib/interakt';
import { toE164 } from '@/lib/phone';
import { createHmac, timingSafeEqual } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verifies Interakt's HMAC signature over the raw body.
 * Returns why it failed, so setup problems are diagnosable from the logs.
 */
function verify(rawBody: string, signature: string | null, queryKey: string | null): { ok: boolean; how: string } {
  const secret = process.env.INTERAKT_WEBHOOK_SECRET;
  if (!secret) return { ok: false, how: 'no_secret_configured' };

  if (signature) {
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    if (safeEqual(signature.trim(), expected)) return { ok: true, how: 'signature' };
    // Some senders omit the prefix.
    const bare = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    if (safeEqual(signature.trim(), bare)) return { ok: true, how: 'signature_bare' };
    return { ok: false, how: 'signature_mismatch' };
  }

  // Manual/curl fallback only.
  if (queryKey && safeEqual(queryKey, secret)) return { ok: true, how: 'query_key' };

  return { ok: false, how: 'no_signature' };
}

export async function POST(req: Request) {
  const url = new URL(req.url);

  // Raw text first — the signature is over these exact bytes.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: 'unreadable_body' }, { status: 400 });
  }

  const sig =
    req.headers.get('interakt-signature') ||
    req.headers.get('x-interakt-signature') ||
    null;

  const auth = verify(rawBody, sig, url.searchParams.get('key'));
  if (!auth.ok) {
    console.error('[relay webhook] rejected:', auth.how, 'sigPresent=', !!sig);
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
      await admin
        .from('relay_messages')
        .update({
          status,
          error_code: message?.channel_error_code || null,
          error_detail: message?.channel_failure_reason || null,
          updated_at: new Date().toISOString(),
        })
        .eq('provider_msg_id', providerMsgId);

      return NextResponse.json({ ok: true, handled: eventType, auth: auth.how });
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

      // Interakt retries. Without this, a retry appends the customer's message
      // to the thread a second time.
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

      const { error: msgErr } = await admin.from('relay_messages').insert({
        workspace_id: ws.id,
        conversation_id: convId,
        direction: 'in',
        body: message?.message || '',
        provider_msg_id: providerMsgId || null,
        status: 'received',
        media_url: message?.media_url || null,
        media_type: mediaTypeFrom(message?.message_content_type),
        created_at: message?.received_at_utc || new Date().toISOString(),
      });
      if (msgErr) console.error('[relay webhook] insert failed', msgErr);

      return NextResponse.json({ ok: true, handled: 'message_received', auth: auth.how });
    }

    return NextResponse.json({ ok: true, ignored: eventType || 'unknown_type' });
  } catch (e) {
    console.error('[relay webhook] unhandled', e);
    return NextResponse.json({ ok: true, error: 'logged' });
  }
}

/**
 * Interakt shows a green tick when this returns 200 to a GET. There is no
 * signature on a GET (no body to sign), so this reports readiness rather than
 * authenticating — it deliberately reveals nothing beyond whether a secret and
 * database are configured.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: 'relay whatsapp webhook',
    secretConfigured: !!process.env.INTERAKT_WEBHOOK_SECRET,
    databaseConfigured: !!createAdminClient(),
    verifies: 'HMAC-SHA256 over the raw body, sent as Interakt-Signature',
  });
}
