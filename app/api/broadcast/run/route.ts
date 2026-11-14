// =============================================================================
// BROADCAST RUN — sends the next few messages of whatever is being broadcast.
// -----------------------------------------------------------------------------
// Two callers:
//   * the Netlify function `broadcast-run`, every 2 minutes, with CRON_SECRET —
//     so a broadcast carries on with every browser closed;
//   * the Broadcast page, as the signed-in admin, while a broadcast is on
//     screen — so a short one finishes in seconds instead of minutes.
//
// One lock for both: a run that finds another in progress answers
// { skipped: 'busy' } and does nothing. With nothing to send, a run is two
// small reads and returns.
// =============================================================================
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isConfigured } from '@/lib/interakt';
import { LONG_RUN, createAutomationAdminClient, createRunContext, isTimeoutError } from '@/lib/automation/run-context';
import { acquireTickLock, releaseTickLock } from '@/lib/automation/lock';
import { broadcastCaller } from '@/lib/broadcast/auth';
import { BROADCAST_LOCK_KEY, runBroadcasts } from '@/lib/broadcast/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : req.headers.get('x-cron-secret');

  let workspaceId: string | null = null;
  if (presented) {
    const expected = process.env.CRON_SECRET || '';
    if (!expected) return NextResponse.json({ ok: false, error: 'CRON_SECRET is not set on the server.' }, { status: 500 });
    if (!secretMatches(presented, expected)) return NextResponse.json({ ok: false, error: 'Invalid cron secret.' }, { status: 401 });
  } else {
    const who = await broadcastCaller();
    if ('error' in who) return who.error;
    workspaceId = who.ws;
  }

  if (!isConfigured()) return NextResponse.json({ ok: false, error: 'INTERAKT_API_KEY is not set.' }, { status: 503 });

  const started = Date.now();
  const ctx = createRunContext(LONG_RUN);
  const admin = createAutomationAdminClient(ctx);
  // Writes that must land whatever the clock says: claims, outcomes, the lock.
  const durable = createAdminClient();
  if (!admin || !durable) { ctx.dispose(); return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 }); }

  const lock = await acquireTickLock(durable, BROADCAST_LOCK_KEY);
  if (!lock.acquired) { ctx.dispose(); return NextResponse.json({ ok: true, skipped: 'busy', reason: lock.reason }); }

  try {
    const report = await runBroadcasts({ admin, durable, ctx, workspaceId });
    return NextResponse.json({ ok: true, ms: Date.now() - started, ...report });
  } catch (e) {
    const timedOut = isTimeoutError(e);
    return NextResponse.json(
      { ok: false, ms: Date.now() - started, error: timedOut ? 'The run ran out of time; the next one carries on.' : e instanceof Error ? e.message : 'Run failed.' },
      { status: timedOut ? 200 : 500 },
    );
  } finally {
    ctx.dispose();
    await releaseTickLock(durable, lock.token, BROADCAST_LOCK_KEY);
  }
}
