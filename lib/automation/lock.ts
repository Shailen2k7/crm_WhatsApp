// =============================================================================
// TICK LOCK — two automation runs never execute at the same time.
// -----------------------------------------------------------------------------
// A lease, stored as one row in relay_settings (key 'automation_tick_lock'),
// whose value is the ISO time the lease expires. Needs no migration.
//
// ACQUIRE is a single conditional UPDATE:
//
//     update relay_settings set value = <now + lease>
//      where key = 'automation_tick_lock' and value < <now>
//
// Postgres serialises concurrent updates to the same row, and the loser
// re-checks the WHERE clause against the winner's new value — which is now in
// the future — so exactly one caller gets the row back. That is the lock.
//
// The lease expires on its own, so a run that crashes or is killed by the
// platform cannot wedge the automation: the next run after LEASE_MS proceeds.
// Timestamps are compared as text; every value is written by toISOString(),
// which has a fixed format, so text order and time order are the same.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';

const LOCK_KEY = 'automation_tick_lock';
const EPOCH = '1970-01-01T00:00:00.000Z';

/** Longer than any run can live (the platform kills a function by ~27s). */
export const LEASE_MS = 60_000;

export type LockResult = { acquired: true; token: string } | { acquired: false; reason: string };

async function tryTake(admin: SupabaseClient): Promise<{ token: string | null; error: string | null }> {
  const now = new Date();
  const token = new Date(now.getTime() + LEASE_MS).toISOString();
  const { data, error } = await admin
    .from('relay_settings')
    .update({ value: token, updated_at: now.toISOString() })
    .eq('key', LOCK_KEY)
    .lt('value', now.toISOString())
    .select('key');
  if (error) return { token: null, error: error.message };
  return { token: data && data.length > 0 ? token : null, error: null };
}

export async function acquireTickLock(admin: SupabaseClient): Promise<LockResult> {
  const first = await tryTake(admin);
  if (first.error) return { acquired: false, reason: `lock error: ${first.error}` };
  if (first.token) return { acquired: true, token: first.token };

  // Not taken: either another run holds it, or the row has never existed.
  const { data: row } = await admin.from('relay_settings').select('value').eq('key', LOCK_KEY).limit(1);
  if (row && row.length > 0) {
    return { acquired: false, reason: `another run is in progress (lease until ${row[0].value})` };
  }

  // First run ever: create the row already expired, then take it.
  const { data: ws } = await admin
    .from('workspaces').select('id').order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!ws?.id) return { acquired: false, reason: 'no workspace to hold the lock row' };
  await admin
    .from('relay_settings')
    .upsert({ workspace_id: ws.id, key: LOCK_KEY, value: EPOCH }, { onConflict: 'workspace_id,key', ignoreDuplicates: true });

  const second = await tryTake(admin);
  if (second.token) return { acquired: true, token: second.token };
  return { acquired: false, reason: second.error ? `lock error: ${second.error}` : 'another run took the lock first' };
}

/** Releases only OUR lease: a run that overran and lost it cannot free a newer run's. */
export async function releaseTickLock(admin: SupabaseClient, token: string): Promise<void> {
  await admin
    .from('relay_settings')
    .update({ value: EPOCH, updated_at: new Date().toISOString() })
    .eq('key', LOCK_KEY)
    .eq('value', token);
}
