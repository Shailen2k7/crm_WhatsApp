// =============================================================================
// NETLIFY SCHEDULED FUNCTION — manual broadcasts.
// -----------------------------------------------------------------------------
// A broadcast is started by a person on the Broadcast page; this only keeps it
// MOVING — every 2 minutes it asks /api/broadcast/run to send the next few
// messages of whatever is under way, and to start anything scheduled whose
// time has come. With nothing to send, the call is two small reads.
//
// It never decides who gets a message and never starts a broadcast nobody
// launched. Logs: Netlify → Functions → broadcast-run → Logs.
// =============================================================================

export default async (): Promise<Response> => {
  const secret = process.env.CRON_SECRET;
  const base = process.env.URL || 'https://chat.migrizo.com';
  if (!secret) {
    console.error('[broadcast-run] CRON_SECRET is not set — broadcasts only move while the Broadcast page is open.');
    return new Response('CRON_SECRET is not set', { status: 500 });
  }

  const started = Date.now();
  try {
    const res = await fetch(`${base}/api/broadcast/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      // The route stops itself by ~18 s; this only guards against a platform hang.
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    let summary = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      summary = JSON.stringify({
        ok: j.ok, ms: j.ms, sent: j.sentTotal, started: j.started, skipped: j.skipped, error: j.error,
        campaigns: (j.campaigns || []).map((c: { name: string; sent: number; failed: number; waiting: number; note?: string }) =>
          `${c.name}: +${c.sent} sent, ${c.failed} failed, ${c.waiting} waiting${c.note ? ` (${c.note})` : ''}`),
      });
    } catch { /* not JSON: keep the raw start of the body */ }
    // Quiet when idle: one line only when something happened or went wrong.
    if (!res.ok || !/"campaigns":\[\]/.test(summary) || /"started":\["/.test(summary)) {
      console.log(`[broadcast-run] HTTP ${res.status} in ${Date.now() - started}ms ${summary}`);
    }
    return new Response(null, { status: res.ok ? 200 : 502 });
  } catch (e) {
    console.error(`[broadcast-run] call failed after ${Date.now() - started}ms`, e);
    return new Response(null, { status: 500 });
  }
};

export const config = {
  schedule: '*/2 * * * *',
};
