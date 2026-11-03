// =============================================================================
// NETLIFY SCHEDULED FUNCTION — the Hot & Spotlight nurture (HS1 → HS8).
// -----------------------------------------------------------------------------
// Its own run, every 5 minutes, two minutes after the main automation-tick
// (T1 and T2–T4). Sharing one run, the nurture went last and never got a turn
// on Netlify: the database is in Singapore, so every lookup costs more here
// than it does on a laptop. Separate, it has a full run budget of its own.
//
// It calls /api/automation/tick?pass=nurture and logs a one-line summary per
// run — Netlify → Functions → automation-nurture → Logs. The route enforces
// the switch, sending hours, daily limit, and the cross-engine 20-hour lock.
// =============================================================================

export default async (): Promise<Response> => {
  const secret = process.env.CRON_SECRET;
  const base = process.env.URL || 'https://chat.migrizo.com';
  if (!secret) {
    console.error('[automation-nurture] CRON_SECRET is not set — the nurture is NOT running.');
    return new Response('CRON_SECRET is not set', { status: 500 });
  }

  const started = Date.now();
  try {
    const res = await fetch(`${base}/api/automation/tick?pass=nurture`, {
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
        ok: j.ok, ms: j.ms, sent: r.sent, due: r.due, audience: r.audience, note: r.note || j.skipped, error: j.error,
        held: (r.skipped || []).filter((x: string) => x.includes('held')).length,
      });
    } catch { /* not JSON: keep the raw start of the body */ }
    console.log(`[automation-nurture] HTTP ${res.status} in ${Date.now() - started}ms ${summary}`);
    // EARLY WARNING — the one pattern that means trouble: a run that is slow
    // AND sent nothing while people were due (it spent its time reading, not
    // sending). A slow run that IS sending is just busy, and is fine.
    try {
      const j = JSON.parse(text);
      const r = (j.report || [])[0] || {}; const sent = r.sent ?? 0; const due = r.due ?? 0;
      if (typeof j.ms === 'number' && j.ms > 9000 && due > 0 && sent === 0) {
        console.warn(`[automation-nurture] STARVING — ${j.ms}ms, ${due} due, 0 sent. Budget is 14000ms; investigate.`);
      }
    } catch { /* not JSON */ }
    return new Response(null, { status: res.ok ? 200 : 502 });
  } catch (e) {
    console.error(`[automation-nurture] call failed after ${Date.now() - started}ms`, e);
    return new Response(null, { status: 500 });
  }
};

// Minutes 2, 7, 12 … — offset from the main run, so the two never start together.
export const config = {
  schedule: '2-59/5 * * * *',
};
