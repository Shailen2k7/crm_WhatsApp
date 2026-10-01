// =============================================================================
// NETLIFY SCHEDULED FUNCTION — sends T1 to new leads, every 5 minutes.
// -----------------------------------------------------------------------------
// The ONLY automation in the app (since 1 Oct 2026): the first message to each
// fresh lead in the CRM. No follow-ups, no meeting messages, no campaigns —
// the route it calls cannot do any of those.
//
// It makes one authenticated call to /api/automation/tick and logs a one-line
// summary, so every run is visible in Netlify → Functions → automation-tick →
// Logs. The route bounds its own run time to under 10s.
// =============================================================================

export default async (): Promise<Response> => {
  const secret = process.env.CRON_SECRET;
  // URL is the site's primary address, provided by Netlify; the fallback only
  // matters if that variable is ever missing.
  const base = process.env.URL || 'https://chat.migrizo.com';

  if (!secret) {
    console.error('[automation-tick] CRON_SECRET is not set — T1 is NOT being sent.');
    return new Response('CRON_SECRET is not set', { status: 500 });
  }

  const started = Date.now();
  try {
    const res = await fetch(`${base}/api/automation/tick`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      // The route stops itself by ~9s; this only guards against a platform hang.
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();

    let summary = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      summary = JSON.stringify({ ok: j.ok, ms: j.ms, sendsUsed: j.sendsUsed, note: j.note, skipped: j.skipped, error: j.error });
    } catch { /* not JSON: keep the raw start of the body */ }

    console.log(`[automation-tick] HTTP ${res.status} in ${Date.now() - started}ms ${summary}`);
    return new Response(null, { status: res.ok ? 200 : 502 });
  } catch (e) {
    console.error(`[automation-tick] call failed after ${Date.now() - started}ms`, e);
    return new Response(null, { status: 500 });
  }
};

export const config = {
  schedule: '*/5 * * * *',
};
