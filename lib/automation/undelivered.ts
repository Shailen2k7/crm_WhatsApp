// =============================================================================
// T1 THAT NEVER ARRIVED — who they are, why, and whether a resend can help.
// -----------------------------------------------------------------------------
// Shown on the T1 tab of Settings → Automation, and re-checked by the Resend
// button immediately before it sends (so a stale screen can never cause a
// wrong send).
//
// A lead is listed only if NOTHING has reached them since: no delivered or
// read message of any kind, no reply, no message from the team, not marked
// Hot/Won/Junk/Lost, not opted out. Everyone else is either fine or a human's.
//
// Whether a resend can help depends on WHY it failed:
//   131049 healthy ecosystem  → yes, once the 4-/10-day pause is over;
//                               never after the third refusal
//   wallet empty (our outage) → yes
//   130472 / 131048 / 5xx …   → yes (timing, not the person)
//   131026 not on WhatsApp    → no — the team should call or email
//   unusable number           → no — fix the number in the CRM first
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { ecosystemStateFrom, ECOSYSTEM_CODE } from './ecosystem';

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const HUMAN_STAGES = new Set(['hot', 'won', 'junk', 'lost', 'retired']);

export interface UndeliveredT1 {
  rowId: string;
  rowSentAt: string;
  leadId: string | null;
  phoneE164: string;
  name: string | null;
  t1At: string;
  /** Plain-English reason it did not arrive. */
  reason: string;
  code: string | null;
  canResend: boolean;
  /** Why not, or when it becomes possible. */
  note: string | null;
}

function explain(code: string | null, rowError: string | null): { reason: string; kind: 'eco' | 'retry' | 'never' | 'fix' | 'unknown' } {
  const err = (rowError || '').toLowerCase();
  // A send whose outcome is unknown may well have arrived — resending blind
  // could message them twice. A human looks at the chat first.
  if (err.includes('delivery unknown')) return { reason: 'Last attempt timed out — outcome unknown', kind: 'unknown' };
  if (err.includes('wallet') || err.includes('balance')) return { reason: 'Interakt wallet was empty', kind: 'retry' };
  if (err.includes('not a usable number') || code === 'bad_phone') return { reason: 'Phone number is not usable', kind: 'fix' };
  if (code === ECOSYSTEM_CODE) return { reason: 'Meta: healthy-ecosystem limit', kind: 'eco' };
  if (code === '131026') return { reason: 'Meta: number not on WhatsApp / cannot receive', kind: 'never' };
  if (code === '130472') return { reason: 'Meta: number in a test group', kind: 'retry' };
  if (code === '131048') return { reason: 'Meta: spam rate limit', kind: 'retry' };
  return { reason: code ? `Failed (${code})` : (rowError ? rowError.slice(0, 80) : 'Failed'), kind: 'retry' };
}

export async function findUndeliveredT1(
  admin: SupabaseClient, ws: string, now: number, onlyPhone?: string,
): Promise<UndeliveredT1[]> {
  // ---- every T1 record (one per person) ---------------------------------------
  // A query builder is mutable, so each page gets a fresh one.
  const query = () => {
    let q = admin.from('relay_automation_sent')
      .select('id, lead_id, phone_e164, ok, error, method, sent_at')
      .eq('workspace_id', ws).eq('automation_key', 'new_lead_first');
    if (onlyPhone) q = q.eq('phone_e164', onlyPhone);
    return q;
  };
  const rows: { id: string; lead_id: string | null; phone_e164: string; ok: boolean; error: string | null; method: string | null; sent_at: string }[] = [];
  for (let page = 0; page < 20; page++) {
    const { data, error } = await query().order('sent_at', { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`t1 rows: ${error.message}`);
    rows.push(...((data || []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const byPhone = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (r.method !== 'skipped' && !byPhone.has(r.phone_e164)) byPhone.set(r.phone_e164, r);
  if (!byPhone.size) return [];

  // ---- conversations for these people -------------------------------------------
  const convs: { id: string; phone_e164: string; last_inbound_at: string | null }[] = [];
  for (const ps of chunk([...byPhone.keys()], 100)) {
    const { data, error } = await admin.from('relay_conversations')
      .select('id, phone_e164, last_inbound_at').eq('workspace_id', ws).in('phone_e164', ps);
    if (error) throw new Error(`convs: ${error.message}`);
    convs.push(...((data || []) as typeof convs));
  }
  const convByPhone = new Map(convs.map((c) => [c.phone_e164, c]));
  const phoneByConv = new Map(convs.map((c) => [c.id, c.phone_e164]));

  // ---- failed automated messages (small) → the candidates -----------------------
  const failsByPhone = new Map<string, { atMs: number; code: string | null }[]>();
  for (const ids of chunk(convs.map((c) => c.id), 100)) {
    const { data, error } = await admin.from('relay_messages')
      .select('conversation_id, created_at, error_code')
      .in('conversation_id', ids).eq('direction', 'out').is('sent_by', null).eq('status', 'failed').limit(5000);
    if (error) throw new Error(`fails: ${error.message}`);
    for (const m of (data || []) as { conversation_id: string; created_at: string; error_code: string | null }[]) {
      const p = phoneByConv.get(m.conversation_id); if (!p) continue;
      if (!failsByPhone.has(p)) failsByPhone.set(p, []);
      failsByPhone.get(p)!.push({ atMs: new Date(m.created_at).getTime(), code: m.error_code });
    }
  }

  const candidates = [...byPhone.values()].filter((r) => {
    if (!r.ok) return true;                                    // the send itself failed (wallet, bad number…)
    const t = new Date(r.sent_at).getTime();                   // accepted, then refused by Meta?
    return (failsByPhone.get(r.phone_e164) || []).some((f) => Math.abs(f.atMs - t) <= 30 * 60_000);
  });
  if (!candidates.length) return [];

  // ---- has ANYTHING reached them since, or has a human stepped in? ---------------
  const candConvIds = candidates.map((r) => convByPhone.get(r.phone_e164)?.id).filter(Boolean) as string[];
  const reached = new Set<string>();
  const teamed = new Set<string>();
  for (const ids of chunk(candConvIds, 100)) {
    const [ok, team] = await Promise.all([
      admin.from('relay_messages').select('conversation_id')
        .in('conversation_id', ids).eq('direction', 'out').in('status', ['delivered', 'read']).limit(5000),
      admin.from('relay_messages').select('conversation_id')
        .in('conversation_id', ids).eq('direction', 'out').eq('is_internal', false)
        .not('sent_by', 'is', null).neq('status', 'failed').limit(5000),
    ]);
    if (ok.error) throw new Error(`reached: ${ok.error.message}`);
    if (team.error) throw new Error(`team: ${team.error.message}`);
    for (const m of (ok.data || []) as { conversation_id: string }[]) reached.add(m.conversation_id);
    for (const m of (team.data || []) as { conversation_id: string }[]) teamed.add(m.conversation_id);
  }

  const leadIds = candidates.map((r) => r.lead_id).filter(Boolean) as string[];
  const leads = new Map<string, { full_name: string | null; stage: string | null }>();
  for (const ids of chunk(leadIds, 100)) {
    const { data } = await admin.from('leads').select('id, full_name, stage').in('id', ids);
    for (const l of (data || []) as { id: string; full_name: string | null; stage: string | null }[]) leads.set(l.id, l);
  }
  const { data: supp } = await admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', ws);
  const suppressed = new Set(((supp || []) as { phone_e164: string }[]).map((s) => s.phone_e164));

  const out: UndeliveredT1[] = [];
  for (const r of candidates) {
    const conv = convByPhone.get(r.phone_e164) ?? null;
    const lead = r.lead_id ? leads.get(r.lead_id) ?? null : null;
    const t1Ms = new Date(r.sent_at).getTime();
    if (conv && (reached.has(conv.id) || teamed.has(conv.id))) continue;
    if (conv?.last_inbound_at && new Date(conv.last_inbound_at).getTime() > t1Ms - 5 * 60_000) continue;
    if (lead?.stage && HUMAN_STAGES.has(lead.stage)) continue;
    if (suppressed.has(r.phone_e164)) continue;

    const fails = failsByPhone.get(r.phone_e164) || [];
    const lastFail = fails.filter((f) => Math.abs(f.atMs - t1Ms) <= 30 * 60_000).sort((a, b) => b.atMs - a.atMs)[0];
    const { reason, kind } = explain(r.ok ? lastFail?.code ?? null : null, r.ok ? null : r.error);

    let canResend = kind === 'retry';
    let note: string | null = null;
    if (kind === 'never') note = 'Cannot arrive — call or email them instead';
    if (kind === 'fix') note = 'Fix the number in the CRM first';
    if (kind === 'unknown') note = 'Open the chat to check whether it arrived';
    if (kind === 'eco') {
      const state = ecosystemStateFrom(fails.filter((f) => f.code === ECOSYSTEM_CODE).map((f) => f.atMs), now);
      if (state.stopped) note = 'Refused by Meta 3 times — stopped for good';
      else if (state.pausedUntil) note = `Meta pause — can resend from ${state.pausedUntil.slice(0, 10)}`;
      else canResend = true;
    }
    out.push({
      rowId: r.id, rowSentAt: r.sent_at, leadId: r.lead_id, phoneE164: r.phone_e164,
      name: lead?.full_name ?? null, t1At: r.sent_at, reason, code: lastFail?.code ?? null, canResend, note,
    });
  }
  out.sort((a, b) => Number(b.canResend) - Number(a.canResend) || b.t1At.localeCompare(a.t1At));
  return out;
}
