// =============================================================================
// META'S "HEALTHY ECOSYSTEM" REFUSALS — the three-strike rule.
// -----------------------------------------------------------------------------
// "This message was not delivered to maintain healthy ecosystem engagement"
// (code 131049) is Meta's per-person marketing cap: that person, personally,
// is getting more business messages than Meta thinks they want — from us and
// from everyone else. It is not a bad number and not a fault at our end, and
// it usually passes. So the answer is to back off and come back, and only give
// up when backing off clearly has not worked. Shailen's rule (29 Sep 2026):
//
//   1st strike → leave them alone for 4 days, then try again
//   2nd strike → leave them alone for 10 days, then try again
//   3rd strike → stop for good
//
// A refusal only counts as a NEW strike if it arrives after the previous pause
// has ended. Without that, one bad day (T2, T3, T4 all refused within hours)
// would count as three strikes and retire someone who never once got the pause
// they were owed.
//
// This file is the same logic the old sequence engine ran (ecosystemStateFrom,
// kept identical on purpose) — the pure function plus the query that feeds it.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';

export const ECOSYSTEM_CODE = '131049';
export const ECOSYSTEM_PAUSE_DAYS = [4, 10] as const;   // after strike 1, after strike 2; strike 3 is final

export interface EcosystemState {
  strikes: number;
  /** While in the future, send nothing automated to this person. */
  pausedUntil: string | null;
  /** Three strikes: never again. */
  stopped: boolean;
}

/** Pure: the refusal times of one person → where they stand now. */
export function ecosystemStateFrom(refusedAt: number[], now: number = Date.now()): EcosystemState {
  let strikes = 0;
  let pauseEnd = -Infinity;
  for (const t of [...refusedAt].sort((a, b) => a - b)) {
    if (t < pauseEnd) continue;                         // inside a pause: not a new strike
    strikes++;
    if (strikes > ECOSYSTEM_PAUSE_DAYS.length) { pauseEnd = Infinity; break; }
    pauseEnd = t + ECOSYSTEM_PAUSE_DAYS[strikes - 1] * 86_400_000;
  }
  const stopped = strikes > ECOSYSTEM_PAUSE_DAYS.length;
  return {
    strikes,
    stopped,
    pausedUntil: !stopped && pauseEnd > now ? new Date(pauseEnd).toISOString() : null,
  };
}

/** True when nothing automated may go to this person right now. */
export function heldByEcosystem(s: EcosystemState | undefined, now: number = Date.now()): boolean {
  return !!s && (s.stopped || (!!s.pausedUntil && new Date(s.pausedUntil).getTime() > now));
}

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * Where every one of these conversations stands under the three-strike rule.
 * Keyed by conversation id; a conversation with no refusals has no entry.
 */
export async function ecosystemStatesByConv(
  admin: SupabaseClient, convIds: string[], now: number = Date.now(),
): Promise<Map<string, EcosystemState>> {
  const out = new Map<string, EcosystemState>();
  if (!convIds.length) return out;
  const times = new Map<string, number[]>();
  // All chunks at once: these are small, indexed reads.
  const parts = await Promise.all(chunk(convIds, 100).map((ids) => admin.from('relay_messages')
    .select('conversation_id, created_at').eq('direction', 'out')
    .eq('error_code', ECOSYSTEM_CODE).in('conversation_id', ids).limit(2000)));
  for (const { data, error } of parts) {
    if (error) throw new Error(`ecosystem: ${error.message}`);
    for (const m of (data || []) as { conversation_id: string; created_at: string }[]) {
      if (!times.has(m.conversation_id)) times.set(m.conversation_id, []);
      times.get(m.conversation_id)!.push(new Date(m.created_at).getTime());
    }
  }
  for (const [c, t] of times) out.set(c, ecosystemStateFrom(t, now));
  return out;
}
