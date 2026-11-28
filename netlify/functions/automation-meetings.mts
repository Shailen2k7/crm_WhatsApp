// =============================================================================
// NETLIFY SCHEDULED FUNCTION — the call messages (PC1 booked, PC2 completed).
// -----------------------------------------------------------------------------
// Its own run, every 2 minutes, so a booked call is acknowledged quickly. Its
// own lock; it touches only meetings, so it never competes with the chases.
//
// Calls /api/automation/tick?pass=meetings and logs one line per run:
// Netlify → Functions → automation-meetings → Logs.
// =============================================================================

export default async (): Promise<Response> => {
  const secret = process.env.CRON_SECRET;
  const base = process.env.URL || 'https://chat.migrizo.com';
  if (!secret) {
    console.error('[automation-meetings] CRON_SECRET is not set — call messages are NOT running.');
    return new Response('CRON_SECRET is not set', { status: 500 });
  }

  const started = Date.now();
  try {
    const res = await fetch(`${base}/api/automation/tick?pass=meetings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      // The route stops itself by ~18 s; this only guards against a platform hang.
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    let summary = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      const r = (j.report || [])[0] || {};
      summary = JSON.stringify({
        ok: j.ok, ms: j.ms, sent: r.sent, due: r.due, examined: r.examined,
        note: r.note || j.skipped, error: j.error,
      });
    } catch { /* not JSON: keep the raw start of the body */ }
    console.log(`[automation-meetings] HTTP ${res.status} in ${Date.now() - started}ms ${summary}`);
    return new Response(null, { status: res.ok ? 200 : 502 });
  } catch (e) {
    console.error(`[automation-meetings] call failed after ${Date.now() - started}ms`, e);
    return new Response(null, { status: 500 });
  }
};

// Every 2 minutes.
export const config = {
  schedule: '*/2 * * * *',
};
