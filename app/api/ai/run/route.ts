// =============================================================================
// ASSISTANT RUN — answers the chats that are waiting.
// -----------------------------------------------------------------------------
// Called every minute by the Netlify function `ai-assistant` with CRON_SECRET,
// and by the Assistant page (as a signed-in admin) for "Run now". One lock for
// both: a run that finds another in progress answers { skipped: 'busy' }.
// With the switch off, a run is two small reads.
// =============================================================================
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isConfigured } from '@/lib/interakt';
import { createAutomationAdminClient, createRunContext, isTimeoutError } from '@/lib/automation/run-context';
import { acquireTickLock, releaseTickLock } from '@/lib/automation/lock';
import { aiCaller } from '@/lib/ai/auth';
import { AI_BUDGET, runAssistant } from '@/lib/ai/engine';
import { AI_LOCK_KEY } from '@/lib/ai/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : req.headers.get('x-cron-secret');
  if (presented) {
    const expected = process.env.CRON_SECRET || '';
    if (!expected) return NextResponse.json({ ok: false, error: 'CRON_SECRET is not set on the server.' }, { status: 500 });
    if (!secretMatches(presented, expected)) return NextResponse.json({ ok: false, error: 'Invalid cron secret.' }, { status: 401 });
  } else {
    const who = await aiCaller();
    if ('error' in who) return who.error;
    if (!who.isAdmin) return NextResponse.json({ ok: false, error: 'Only an admin can run the assistant by hand.' }, { status: 403 });
  }
  if (!isConfigured()) return NextResponse.json({ ok: false, error: 'INTERAKT_API_KEY is not set.' }, { status: 503 });

  const started = Date.now();
  const ctx = createRunContext(AI_BUDGET);
  const admin = createAutomationAdminClient(ctx);
  // Writes that must land whatever the clock says: the chat records, the sent rows, the lock.
  const durable = createAdminClient();
  if (!admin || !durable) { ctx.dispose(); return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 }); }

  const lock = await acquireTickLock(durable, AI_LOCK_KEY);
  if (!lock.acquired) { ctx.dispose(); return NextResponse.json({ ok: true, skipped: 'busy', reason: lock.reason }); }

  try {
    const report = await runAssistant({ admin, durable, ctx });
    return NextResponse.json({ ok: true, ms: Date.now() - started, ...report });
  } catch (e) {
    const timedOut = isTimeoutError(e);
    return NextResponse.json(
      { ok: false, ms: Date.now() - started, error: timedOut ? 'The run ran out of time; the next one carries on.' : e instanceof Error ? e.message : 'Run failed.' },
      { status: timedOut ? 200 : 500 },
    );
  } finally {
    ctx.dispose();
    await releaseTickLock(durable, lock.token, AI_LOCK_KEY);
  }
}
