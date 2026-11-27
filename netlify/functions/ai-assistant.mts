// =============================================================================
// NETLIFY SCHEDULED FUNCTION — the chat assistant.
// -----------------------------------------------------------------------------
// Every minute it asks /api/ai/run to answer the chats that are waiting. With
// the assistant switched off (Assistant page), the call is two small reads.
//
// It decides nothing itself. Logs: Netlify → Functions → ai-assistant → Logs.
// =============================================================================

export default async (): Promise<Response> => {
  const secret = process.env.CRON_SECRET;
  const base = process.env.URL || 'https://chat.migrizo.com';
  if (!secret) {
    console.error('[ai-assistant] CRON_SECRET is not set — the assistant cannot run.');
    return new Response('CRON_SECRET is not set', { status: 500 });
  }

  const started = Date.now();
  try {
    const res = await fetch(`${base}/api/ai/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      // The route stops itself by ~23 s; this only guards against a platform hang.
      signal: AbortSignal.timeout(28_000),
    });
    const text = await res.text();
    let summary = text.slice(0, 400);
    let quiet = false;
    try {
      const j = JSON.parse(text);
      quiet = res.ok && (j.skipped || (!j.answered && !j.verdicts && !j.booked && !j.handedOver && !j.followUps && !(j.errors || []).length));
      summary = JSON.stringify({
        ok: j.ok, ms: j.ms, skipped: j.skipped, answered: j.answered, verdicts: j.verdicts, booked: j.booked,
        handedOver: j.handedOver, waited: j.waited, followUps: j.followUps, errors: j.errors, error: j.error,
      });
    } catch { /* not JSON: keep the raw start of the body */ }
    // Quiet when idle: one line only when something happened or went wrong.
    if (!quiet) console.log(`[ai-assistant] HTTP ${res.status} in ${Date.now() - started}ms ${summary}`);
    return new Response(null, { status: res.ok ? 200 : 502 });
  } catch (e) {
    console.error(`[ai-assistant] call failed after ${Date.now() - started}ms`, e);
    return new Response(null, { status: 500 });
  }
};

export const config = {
  schedule: '* * * * *',
};
