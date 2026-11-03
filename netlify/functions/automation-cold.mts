// =============================================================================
// NETLIFY SCHEDULED FUNCTION — the cold lead chase (CC1 → CC8).
// -----------------------------------------------------------------------------
// Its own run, every 5 minutes at minutes 1, 6, 11 … — between T1 (minute 0),
// the HS nurture (minute 2) and the T2–T4 chase (minute 4). Each engine owns
// its run and its lock; the 20-hour cross-engine rule (read fresh before every
// send) keeps them off each other's people.
//
// Calls /api/automation/tick?pass=cold and logs one line per run:
// Netlify → Functions → automation-cold → Logs.
// =============================================================================

export default async (): Promise<Response> => {
  const secret = process.env.CRON_SECRET;
  const base = process.env.URL || 'https://chat.migrizo.com';
  if (!secret) {
    console.error('[automation-cold] CRON_SECRET is not set — the cold chase is NOT running.');
    return new Response('CRON_SECRET is not set', { status: 500 });
  }

  const started = Date.now();
  try {
    const res = await fetch(`${base}/api/automation/tick?pass=cold`, {
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
        ok: j.ok, ms: j.ms, sent: r.sent, due: r.due, examined: r.examined, sentToday: r.sentToday,
        note: r.note || j.skipped, error: j.error,
        held: (r.skipped || []).filter((x: string) => x.includes('held')).length,
      });
    } catch { /* not JSON: keep the raw start of the body */ }
    console.log(`[automation-cold] HTTP ${res.status} in ${Date.now() - started}ms ${summary}`);
    // EARLY WARNING — the one pattern that means trouble: a run that is slow
    // AND sent nothing while people were due (it spent its time reading, not
    // sending). A slow run that IS sending is just busy, and is fine.
    try {
      const j = JSON.parse(text);
      const r = (j.report || [])[0] || {}; const sent = r.sent ?? 0; const due = r.due ?? 0;
      if (typeof j.ms === 'number' && j.ms > 9000 && due > 0 && sent === 0) {
        console.warn(`[automation-cold] STARVING — ${j.ms}ms, ${due} due, 0 sent. Budget is 14000ms; investigate.`);
      }
    } catch { /* not JSON */ }
    return new Response(null, { status: res.ok ? 200 : 502 });
  } catch (e) {
    console.error(`[automation-cold] call failed after ${Date.now() - started}ms`, e);
    return new Response(null, { status: 500 });
  }
};

// Minutes 1, 6, 11 … — never at the same moment as T1 (0), the nurture (2) or
// the T2–T4 chase (4).
export const config = {
  schedule: '1-59/5 * * * *',
};
