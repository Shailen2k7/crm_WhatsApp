// =============================================================================
// NETLIFY SCHEDULED FUNCTION — T1 (first message to new leads), every 5 minutes.
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
      // The route stops itself by ~18 s; this only guards against a platform hang.
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();

    let summary = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      // Per engine: what it sent, what was due, and why it stopped — so a run
      // that quietly sends nothing can be read straight off the log.
      const passes = (j.report || []).map((r: { key?: string; sent?: number; due?: number; note?: string }) => ({ k: r.key, sent: r.sent, due: r.due, note: r.note }));
      summary = JSON.stringify({ ok: j.ok, ms: j.ms, sendsUsed: j.sendsUsed, note: j.note, skipped: j.skipped, error: j.error, passes });
    } catch { /* not JSON: keep the raw start of the body */ }

    console.log(`[automation-tick] HTTP ${res.status} in ${Date.now() - started}ms ${summary}`);
    // EARLY WARNING — the one pattern that means trouble: a run that is slow
    // AND sent nothing while people were due (it spent its time reading, not
    // sending). A slow run that IS sending is just busy, and is fine.
    try {
      const j = JSON.parse(text);
      const p = (j.report || []).find((r: { key?: string }) => r.key === 'new_lead_first') || {}; const sent = p.sent ?? 0; const due = p.waiting ?? 0;
      if (typeof j.ms === 'number' && j.ms > 9000 && due > 0 && sent === 0) {
        console.warn(`[automation-tick] STARVING — ${j.ms}ms, ${due} due, 0 sent. Budget is 14000ms; investigate.`);
      }
    } catch { /* not JSON */ }
    return new Response(null, { status: res.ok ? 200 : 502 });
  } catch (e) {
    console.error(`[automation-tick] call failed after ${Date.now() - started}ms`, e);
    return new Response(null, { status: 500 });
  }
};

export const config = {
  schedule: '*/5 * * * *',
};
