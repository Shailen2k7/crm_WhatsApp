// =============================================================================
// THE ASSISTANT'S MEMORY — settings, one small record per chat, and the lists
// the Assistant page shows. Everything lives in relay_settings as JSON, so the
// assistant needs no new table and no SQL.
//
//   ai_assistant        the switch and its settings
//   ai:<conversation>   what the assistant knows and has done in one chat
//   ai_index            who is waiting for a human, who is due a call-booking
//                       follow-up, and the last things the assistant did
//
// Only one run executes at a time (the run lock), so the index is written by
// one writer; the page's buttons change single chats and re-read before saving.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';

export const AI_CONFIG_KEY = 'ai_assistant';
export const AI_INDEX_KEY = 'ai_index';
export const AI_LOCK_KEY = 'ai_assistant_lock';
export const stateKey = (conversationId: string) => `ai:${conversationId}`;

export interface AiConfig {
  enabled: boolean;
  /** Only customer messages that arrive after this are answered. */
  activatedAt: string | null;
  /** Whose CRM booking page the assistant books on. */
  bookingSlug: string;
  /** Send the call-booking follow-ups (cbr1–cbr3) to eligible people who have not booked. */
  followUps: boolean;
}
export const DEFAULT_CONFIG: AiConfig = { enabled: false, activatedAt: null, bookingSlug: 'shailen', followUps: true };

export type Verdict = 'gtv' | 'gtv_high' | 'not' | 'ifv';

export type PlanStep =
  | { kind: 'text'; body: string; status: StepStatus; messageId?: string }
  | { kind: 'media'; path: string; name: string; mime: string; size: number; status: StepStatus; messageId?: string }
  | { kind: 'book'; slot: string; email: string; reschedule: boolean; thenTexts: string[]; status: StepStatus }
  | { kind: 'lead'; verdict: Verdict; reason: string; status: StepStatus }
  | { kind: 'note'; body: string; status: StepStatus };
export type StepStatus = 'todo' | 'doing' | 'done' | 'failed' | 'unknown';

export interface AiState {
  /** active = the assistant answers; hold = waiting for a human; off = a human switched it off here. */
  status: 'active' | 'hold' | 'off';
  holdReason?: string;
  holdAt?: string;
  /** The newest customer message the assistant has dealt with. */
  handledId?: string;
  /** The chat's last_inbound_at when that happened: lets a run skip the chat without reading it. */
  seenInboundAt?: string;
  /** A decision in progress: which message, how many tries, the last error. */
  claim?: { inboundId: string; attempts: number; error?: string };
  /** Messages decided but not all sent yet. */
  plan?: { inboundId: string; madeAt: string; kind: 'reply' | 'verdict' | 'book'; steps: PlanStep[] };
  verdict?: Verdict;
  verdictAt?: string;
  /** When the booking link went to them. */
  linkAt?: string;
  /** The call the assistant knows about. */
  meetingStart?: string;
  meetingSeenAt?: string;
  /** A slot that turned out to be taken, so the next decision offers another. */
  slotTaken?: string;
  log: { at: string; kind: string; note: string }[];
}
export const freshState = (): AiState => ({ status: 'active', log: [] });

export interface HoldEntry { at: string; reason: string; name: string; phone: string }
export interface FollowUpEntry { since: string; step: number; lastAt?: string; fails?: number; name: string; phone: string; leadId: string | null }
export interface ActivityEntry { at: string; conversationId: string; name: string; kind: string; note: string }
export interface AiIndex {
  holds: Record<string, HoldEntry>;
  followUps: Record<string, FollowUpEntry>;
  activity: ActivityEntry[];
  /** Something that stops the assistant altogether (a rejected key), shown on the page. */
  problem?: { at: string; text: string } | null;
}
const emptyIndex = (): AiIndex => ({ holds: {}, followUps: {}, activity: [] });
const ACTIVITY_KEEP = 300;

function parse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? (v as T) : fallback; } catch { return fallback; }
}

async function readRow(admin: SupabaseClient, ws: string, key: string): Promise<string | null> {
  const { data, error } = await admin.from('relay_settings').select('value').eq('workspace_id', ws).eq('key', key).maybeSingle();
  if (error) throw new Error(`settings ${key}: ${error.message}`);
  return (data?.value as string | undefined) ?? null;
}
async function writeRow(admin: SupabaseClient, ws: string, key: string, value: unknown): Promise<void> {
  const { error } = await admin.from('relay_settings').upsert(
    { workspace_id: ws, key, value: JSON.stringify(value), updated_at: new Date().toISOString() },
    { onConflict: 'workspace_id,key' },
  );
  if (error) throw new Error(`settings ${key}: ${error.message}`);
}

export async function loadConfig(admin: SupabaseClient, ws: string): Promise<AiConfig> {
  return { ...DEFAULT_CONFIG, ...parse<Partial<AiConfig>>(await readRow(admin, ws, AI_CONFIG_KEY), {}) };
}
export const saveConfig = (admin: SupabaseClient, ws: string, c: AiConfig) => writeRow(admin, ws, AI_CONFIG_KEY, c);

export async function loadIndex(admin: SupabaseClient, ws: string): Promise<AiIndex> {
  const v = parse<Partial<AiIndex>>(await readRow(admin, ws, AI_INDEX_KEY), {});
  return { ...emptyIndex(), ...v, holds: v.holds || {}, followUps: v.followUps || {}, activity: v.activity || [] };
}
export async function saveIndex(admin: SupabaseClient, ws: string, idx: AiIndex): Promise<void> {
  idx.activity = idx.activity.slice(-ACTIVITY_KEEP);
  await writeRow(admin, ws, AI_INDEX_KEY, idx);
}

function normaliseState(v: Partial<AiState>): AiState {
  return { ...freshState(), ...v, status: v.status === 'hold' || v.status === 'off' ? v.status : 'active', log: Array.isArray(v.log) ? v.log : [] };
}
export async function loadState(admin: SupabaseClient, ws: string, conversationId: string): Promise<AiState> {
  return normaliseState(parse<Partial<AiState>>(await readRow(admin, ws, stateKey(conversationId)), {}));
}
export async function loadStates(admin: SupabaseClient, ws: string, conversationIds: string[]): Promise<Map<string, AiState>> {
  const out = new Map<string, AiState>();
  for (let i = 0; i < conversationIds.length; i += 80) {
    const keys = conversationIds.slice(i, i + 80).map(stateKey);
    const { data, error } = await admin.from('relay_settings').select('key, value').eq('workspace_id', ws).in('key', keys);
    if (error) throw new Error(`ai states: ${error.message}`);
    for (const r of (data || []) as { key: string; value: string }[]) {
      out.set(r.key.slice(3), normaliseState(parse<Partial<AiState>>(r.value, {})));
    }
  }
  return out;
}
export async function saveState(admin: SupabaseClient, ws: string, conversationId: string, s: AiState): Promise<void> {
  s.log = s.log.slice(-40);
  await writeRow(admin, ws, stateKey(conversationId), s);
}

/** One line in the chat's own history and in the page's "what it did" list. */
export function record(idx: AiIndex, s: AiState, e: Omit<ActivityEntry, 'at'>, at: string): void {
  s.log.push({ at, kind: e.kind, note: e.note });
  idx.activity.push({ at, ...e });
}
