// =============================================================================
// RUN CONTEXT — the limits every automation run lives inside.
// -----------------------------------------------------------------------------
// The tick used to have no limits at all. A run with nothing to send made ~108
// sequential round trips to a database in Singapore and took 15–25 seconds;
// nothing ever timed out, so a slow provider or a slow query simply stretched
// the run until the platform killed it at ~27s. A caller giving up did not stop
// it either. With a new run started every 10 seconds, three were always
// overlapping and the bill went from ~30 to ~590 credits a day.
//
// Three rules now bound every run:
//
//   1. EVERY external call gives up after CALL_TIMEOUT_MS (database and
//      WhatsApp alike), so no single call can hold a run hostage.
//   2. No new unit of work STARTS after STOP_STARTING_AFTER_MS, and at
//      HARD_STOP_MS everything still in flight is aborted. A run returns in
//      under 10 seconds whatever the network is doing; unfinished work is
//      picked up by the next run.
//   3. At most MAX_SENDS_PER_RUN messages per run, shared across every machine.
// =============================================================================
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { linkedSignal } from './signals';

export { linkedSignal };

export const CALL_TIMEOUT_MS = 5_000;
export const STOP_STARTING_AFTER_MS = 6_000;
export const HARD_STOP_MS = 9_000;
export const MAX_SENDS_PER_RUN = 20;

export interface RunContext {
  readonly startedAt: number;
  /** Aborts every in-flight call when the run hits HARD_STOP_MS. */
  readonly signal: AbortSignal;
  /** True while there is time left to START a new unit of work. */
  hasTime(): boolean;
  /** Claims one send from the budget. False when out of time or budget. */
  takeSend(): boolean;
  /** Returns a claimed send that did not happen, so the budget is not wasted. */
  giveBackSend(): void;
  sendsLeft(): number;
  elapsedMs(): number;
  /** Stops the hard-stop timer. Call once the run is finished. */
  dispose(): void;
  /** Per-run memo for rows that do not change mid-run (template wording). */
  readonly cache: Map<string, unknown>;
}

export function createRunContext(): RunContext {
  const startedAt = Date.now();
  const controller = new AbortController();
  const hardStop = setTimeout(
    () => controller.abort(new DOMException(`run exceeded ${HARD_STOP_MS}ms`, 'TimeoutError')),
    HARD_STOP_MS,
  );
  let sends = MAX_SENDS_PER_RUN;
  const hasTime = () => !controller.signal.aborted && Date.now() - startedAt < STOP_STARTING_AFTER_MS;

  return {
    startedAt,
    signal: controller.signal,
    cache: new Map(),
    hasTime,
    takeSend: () => {
      if (sends <= 0 || !hasTime()) return false;
      sends--;
      return true;
    },
    giveBackSend: () => { sends = Math.min(MAX_SENDS_PER_RUN, sends + 1); },
    sendsLeft: () => sends,
    elapsedMs: () => Date.now() - startedAt,
    dispose: () => clearTimeout(hardStop),
  };
}

/**
 * The service-role client for automation runs: identical to createAdminClient
 * except every request carries the per-call timeout and, when a run is given,
 * the run's hard stop. Deliberately a separate constructor — the webhook and
 * manual send routes keep their existing client and are untouched by these
 * limits.
 *
 * Pass no ctx for work that must still complete after the hard stop, such as
 * releasing the lock.
 */
export function createAutomationAdminClient(ctx?: RunContext): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const timedFetch: typeof fetch = async (input, init) => {
    const { signal, done } = linkedSignal([ctx?.signal, init?.signal], CALL_TIMEOUT_MS);
    try {
      const res = await fetch(input, { ...init, signal });
      // Read the body INSIDE the timeout. Returning the live response would end
      // the time limit at the headers, leaving a slow body free to hang the run.
      // Database responses are small JSON, so buffering them costs nothing.
      const nullBodyStatus = [101, 204, 205, 304].includes(res.status);
      const body = nullBodyStatus ? null : await res.arrayBuffer();
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } finally {
      done();
    }
  };

  return createClient(url, key, { auth: { persistSession: false }, global: { fetch: timedFetch } });
}

/**
 * Runs `fn` over `items` with at most `limit` in flight. Stops STARTING new
 * items once `shouldContinue()` is false; items already running finish.
 */
export async function forEachLimited<T>(
  items: T[],
  limit: number,
  shouldContinue: () => boolean,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && shouldContinue()) {
      const item = items[next++];
      try { await fn(item); } catch { /* one item's failure must not stop the others */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, worker));
}

/** True for the abort/timeout errors our own limits raise. */
export function isTimeoutError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
