// =============================================================================
// TEST CONNECTION — proves the Interakt API key works, WITHOUT messaging anyone.
// -----------------------------------------------------------------------------
// There is no read-only "who am I" endpoint on Interakt's public API, so the
// check is indirect: send a request with a deliberately INVALID phone number.
//
//   401 / 403  -> the key is wrong. Authentication failed before validation.
//   400 / 422  -> the key is RIGHT. Interakt got far enough to reject the phone.
//
// Nothing is delivered either way, because no valid recipient is ever supplied.
// That distinction — auth failure vs validation failure — is the whole test.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 });

  const key = process.env.INTERAKT_API_KEY;
  if (!key) {
    return NextResponse.json({ ok: false, state: 'not_configured', detail: 'INTERAKT_API_KEY is not set.' });
  }

  try {
    const res = await fetch('https://api.interakt.ai/v1/public/message/', {
      method: 'POST',
      headers: { Authorization: `Basic ${key}`, 'Content-Type': 'application/json' },
      // "0" is not a dialable number anywhere. Interakt must reject it — the
      // only question is whether it rejects on AUTH or on VALIDATION.
      body: JSON.stringify({ countryCode: '+0', phoneNumber: '0', type: 'Text', data: { message: '' } }),
      signal: AbortSignal.timeout(15_000),
    });

    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 300) }; }

    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({
        ok: false,
        state: 'unauthorized',
        httpStatus: res.status,
        detail: 'Interakt rejected the API key. Re-copy it from Developer Settings.',
        body,
      });
    }

    // Anything else means the key was accepted and Interakt moved on to
    // validating the payload — which is exactly what we wanted to learn.
    return NextResponse.json({
      ok: true,
      state: 'authenticated',
      httpStatus: res.status,
      detail: 'API key accepted by Interakt. Sending is wired up.',
      body,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'TimeoutError';
    return NextResponse.json({
      ok: false,
      state: aborted ? 'timeout' : 'unreachable',
      detail: aborted ? 'Interakt did not respond within 15s.' : 'Could not reach Interakt.',
    });
  }
}
