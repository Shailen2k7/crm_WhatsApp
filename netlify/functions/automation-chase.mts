// =============================================================================
// NETLIFY SCHEDULED FUNCTION — the CV/LinkedIn follow-ups (T1 retry, T2–T4).
// -----------------------------------------------------------------------------
// Its own run, every 5 minutes at minutes 4, 9, 14 … — after T1 (minute 0) and
// the HS nurture (minute 2). Sharing T1's run, the follow-ups spent the whole
// budget reading (the database is in Singapore, Netlify in the US) and logged
// "47 due, 0 sent" run after run on 24 Oct 2026. Alone, with a longer budget,
// they have time to send.
//
// Calls /api/automation/tick?pass=chase and logs one line per run:
// Netlify → Functions → automation-chase → Logs.
// =============================================================================

export default async (): Promise<Response> => {
  const secret = process.env.CRON_SECRET;
  const base = process.env.URL || 'https://chat.migrizo.com';
  if (!secret) {
    console.error('[automation-chase] CRON_SECRET is not set — T2–T4 are NOT running.');
    return new Response('CRON_SECRET is not set', { status: 500 });
  }

  const started = Date.now();
  try {
    const res = await fetch(`${base}/api/automation/tick?pass=chase`, {
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
        ok: j.ok, ms: j.ms, sent: r.sent, due: r.due, examined: r.examined, note: r.note || j.skipped, error: j.error,
        held: (r.skipped || []).filter((x: string) => x.includes('held')).length,
      });
    } catch { /* not JSON: keep the raw start of the body */ }
    console.log(`[automation-chase] HTTP ${res.status} in ${Date.now() - started}ms ${summary}`);
    // EARLY WARNING: a run creeping towards its budget is flagged long before it
    // stops sending — search the logs for SLOW RUN.
    try { const ms = JSON.parse(text).ms; if (typeof ms === 'number' && ms > 9000) console.warn(`[automation-chase] SLOW RUN ${ms}ms — budget is $14000ms; investigate before it starves`); } catch { /* not JSON */ }
    return new Response(null, { status: res.ok ? 200 : 502 });
  } catch (e) {
    console.error(`[automation-chase] call failed after ${Date.now() - started}ms`, e);
    return new Response(null, { status: 500 });
  }
};

// Minutes 4, 9, 14 … — never at the same moment as T1 (0) or the nurture (2).
export const config = {
  schedule: '4-59/5 * * * *',
};
