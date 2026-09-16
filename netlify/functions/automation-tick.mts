// =============================================================================
// NETLIFY SCHEDULED FUNCTION — runs the automation every 5 minutes.
// -----------------------------------------------------------------------------
// Replaces the two Supabase pg_cron jobs (every 10 seconds and every 2 minutes)
// that called /api/automation/tick from the Singapore database server.
//
// It makes one authenticated call to the tick and logs a one-line summary, so
// every run is visible in Netlify → Functions → automation-tick → Logs. The
// tick itself does all the work and bounds its own run time to under 10s.
// =============================================================================

export default async (): Promise<Response> => {
  const secret = process.env.CRON_SECRET;
  // URL is the site's primary address, provided by Netlify; the fallback only
  // matters if that variable is ever missing.
  const base = process.env.URL || 'https://chat.migrizo.com';

  if (!secret) {
    console.error('[automation-tick] CRON_SECRET is not set — the automation is NOT running.');
    return new Response('CRON_SECRET is not set', { status: 500 });
  }

  const started = Date.now();
  try {
    const res = await fetch(`${base}/api/automation/tick`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      // The tick stops itself by ~9s; this only guards against a platform hang.
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();

    let summary = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      summary = JSON.stringify({ ok: j.ok, ms: j.ms, sendsUsed: j.sendsUsed, skipped: j.skipped, error: j.error });
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
