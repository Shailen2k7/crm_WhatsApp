'use client';

// =============================================================================
// THE CONNECTION KEEPER — realtime that survives real life.
// -----------------------------------------------------------------------------
// A realtime channel dies quietly all the time: the auth token expires after an
// hour, the laptop lid closes, the phone puts Safari to sleep, the train goes
// through a tunnel. Left alone, a dead channel stays dead — the app looks fine
// and simply never hears another message until someone refreshes. That was
// exactly the bug report: "messages do not come in automatically, we have to
// refresh".
//
// Every subscription therefore goes through openLiveChannel(), which does the
// three things a raw .subscribe() does not:
//
//   1. RESUBSCRIBE — any error/timeout/close that we did not ask for tears the
//      channel down and rebuilds it, with backoff, forever.
//   2. CATCH UP — after a gap, the events that happened during the gap are gone
//      for good; realtime does not replay. So every channel carries a catchUp()
//      refetch that runs after each recovery (and after waking from >20s in the
//      background), pulling whatever was missed straight from the database.
//   3. WAKE WITH THE APP — one set of page-level listeners (visibility, online,
//      focus, plus a watchdog tick) nudges every registered channel the moment
//      the app is back in the foreground, instead of waiting for a heartbeat
//      to notice minutes later.
// =============================================================================
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';

interface LiveEntry {
  name: string;
  build: (ch: RealtimeChannel) => RealtimeChannel;
  catchUp?: () => void;
  onStatus?: (up: boolean) => void;
  channel: RealtimeChannel | null;
  /** True from the moment the channel is lost until it is joined again. */
  lost: boolean;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  lastCatchUp: number;
}

const registry = new Set<LiveEntry>();
let wakeInstalled = false;
let hiddenAt = 0;

/** Gaps shorter than this are treated as no gap at all — alt-tabbing to look
 *  something up must not refetch the world. */
const NAP_MS = 20_000;

function backoffMs(retries: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(retries, 5)); // 1s → 32s cap
}

/** One flap can surface as several CLOSED/SUBSCRIBED rounds in quick
 *  succession; the refetch it triggers must run once, not once per round. */
function runCatchUp(e: LiveEntry) {
  const now = Date.now();
  if (now - e.lastCatchUp < 5_000) return;
  e.lastCatchUp = now;
  e.catchUp?.();
}

function subscribeEntry(supabase: SupabaseClient, e: LiveEntry) {
  if (e.stopped) return;
  if (e.timer) { clearTimeout(e.timer); e.timer = null; }
  if (e.channel) { try { supabase.removeChannel(e.channel); } catch { /* already gone */ } }

  const ch = e.build(supabase.channel(e.name));
  e.channel = ch;

  ch.subscribe((status) => {
    if (e.stopped) return;
    if (status === 'SUBSCRIBED') {
      e.retries = 0;
      e.onStatus?.(true);
      if (e.lost) {
        e.lost = false;
        runCatchUp(e);          // pull whatever happened while we were deaf
      }
      return;
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      e.lost = true;
      e.onStatus?.(false);
      if (e.timer) clearTimeout(e.timer);
      e.timer = setTimeout(() => subscribeEntry(supabase, e), backoffMs(e.retries++));
    }
  });
}

function wakeEverything(supabase: SupabaseClient, longNap: boolean) {
  // The socket itself first: after OS-level sleep it can be half-dead in a way
  // no channel has noticed yet.
  try { if (!supabase.realtime.isConnected()) supabase.realtime.connect(); } catch { /* not fatal */ }

  for (const e of registry) {
    if (e.stopped) continue;
    const joined = e.channel?.state === 'joined';
    if (!joined) {
      e.lost = true;
      subscribeEntry(supabase, e);
    } else if (longNap) {
      // The channel looks healthy, but we were gone long enough that events
      // may have been dropped on the floor. The database knows the truth.
      runCatchUp(e);
    }
  }
}

function installWakeHandlers(supabase: SupabaseClient) {
  if (wakeInstalled || typeof window === 'undefined') return;
  wakeInstalled = true;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    wakeEverything(supabase, Date.now() - hiddenAt > NAP_MS);
  });
  window.addEventListener('online', () => wakeEverything(supabase, true));
  window.addEventListener('focus', () => wakeEverything(supabase, false));

  // The realtime socket authenticates with a JWT that expires hourly. The
  // refreshed token has to be handed to the socket, or the next rejoin is
  // silently refused — the classic "worked for an hour, then went quiet".
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session?.access_token) {
      try { supabase.realtime.setAuth(session.access_token); } catch { /* older client */ }
    }
  });

  // Watchdog: sleep events do not always fire visibilitychange (e.g. a phone
  // locking with the PWA frontmost). A slow tick catches whatever slips past.
  setInterval(() => {
    if (document.hidden) return;
    const anyDead = [...registry].some((e) => !e.stopped && e.channel?.state !== 'joined');
    if (anyDead || !supabase.realtime.isConnected()) wakeEverything(supabase, true);
  }, 25_000);
}

/**
 * A realtime channel that stays alive and never misses for long.
 *
 * @param name     stable channel name
 * @param build    attach your .on(...) handlers; return the channel
 * @param catchUp  refetch-from-database, run after every recovered gap
 * @param onStatus optional live/dead indicator feed
 * @returns cleanup function for useEffect
 */
export function openLiveChannel(
  supabase: SupabaseClient,
  name: string,
  build: (ch: RealtimeChannel) => RealtimeChannel,
  catchUp?: () => void,
  onStatus?: (up: boolean) => void,
): () => void {
  installWakeHandlers(supabase);

  const entry: LiveEntry = {
    name, build, catchUp, onStatus,
    channel: null, lost: false, retries: 0, timer: null, stopped: false, lastCatchUp: 0,
  };
  registry.add(entry);
  subscribeEntry(supabase, entry);

  return () => {
    entry.stopped = true;                     // so CLOSED does not resubscribe
    if (entry.timer) clearTimeout(entry.timer);
    registry.delete(entry);
    if (entry.channel) { try { supabase.removeChannel(entry.channel); } catch { /* fine */ } }
  };
}
