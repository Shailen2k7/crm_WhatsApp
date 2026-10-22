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
import { chunk, inParallel } from './parallel';
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
  // ---- start from what FAILED, not from every T1 ever sent --------------------
  // Two small sets: automated messages Meta refused, and T1 records whose own
  // send failed (wallet, bad number…). Everyone else's T1 went through.
  type Row = { id: string; lead_id: string | null; phone_e164: string; ok: boolean; error: string | null; method: string | null; sent_at: string };
  type Fail = { conversation_id: string; created_at: string; error_code: string | null };
  type Conv = { id: string; phone_e164: string; last_inbound_at: string | null };
  const rowCols = 'id, lead_id, phone_e164, ok, error, method, sent_at';
  const failQuery = () => {
    const q = admin.from('relay_messages').select('conversation_id, created_at, error_code')
      .eq('workspace_id', ws).eq('direction', 'out').is('sent_by', null).eq('status', 'failed');
    return q;
  };
  const [failRes, badRowsRes] = await Promise.all([
    failQuery().limit(10000),
    (onlyPhone
      ? admin.from('relay_automation_sent').select(rowCols).eq('workspace_id', ws).eq('automation_key', 'new_lead_first').eq('ok', false).eq('phone_e164', onlyPhone)
      : admin.from('relay_automation_sent').select(rowCols).eq('workspace_id', ws).eq('automation_key', 'new_lead_first').eq('ok', false)
    ).limit(5000),
  ]);
  if (failRes.error) throw new Error(`fails: ${failRes.error.message}`);
  if (badRowsRes.error) throw new Error(`t1 rows: ${badRowsRes.error.message}`);
  const allFails = (failRes.data || []) as Fail[];

  // The conversations those refusals belong to → their phones.
  const failConvIds = [...new Set(allFails.map((f) => f.conversation_id))];
  const convs: Conv[] = (await inParallel(chunk(failConvIds, 100), async (ids) => {
    const { data, error } = await admin.from('relay_conversations')
      .select('id, phone_e164, last_inbound_at').in('id', ids);
    if (error) throw new Error(`convs: ${error.message}`);
    return (data || []) as Conv[];
  })).flat();

  // The T1 record of everyone who might be affected.
  const candidatePhones = new Set<string>([
    ...convs.map((c) => c.phone_e164),
    ...((badRowsRes.data || []) as Row[]).map((r) => r.phone_e164),
  ]);
  if (onlyPhone) for (const p of [...candidatePhones]) if (p !== onlyPhone) candidatePhones.delete(p);
  const rows: Row[] = (await inParallel(chunk([...candidatePhones], 100), async (ps) => {
    const { data, error } = await admin.from('relay_automation_sent').select(rowCols)
      .eq('workspace_id', ws).eq('automation_key', 'new_lead_first').in('phone_e164', ps);
    if (error) throw new Error(`t1 rows: ${error.message}`);
    return (data || []) as Row[];
  })).flat();
  const byPhone = new Map<string, Row>();
  for (const r of rows.sort((a, b) => a.sent_at.localeCompare(b.sent_at))) {
    if (r.method !== 'skipped' && !byPhone.has(r.phone_e164)) byPhone.set(r.phone_e164, r);
  }
  if (!byPhone.size) return [];

  // Conversations for people whose own send failed (they may have none above).
  const known = new Set(convs.map((c) => c.phone_e164));
  const missing = [...byPhone.keys()].filter((p) => !known.has(p));
  convs.push(...(await inParallel(chunk(missing, 100), async (ps) => {
    const { data } = await admin.from('relay_conversations')
      .select('id, phone_e164, last_inbound_at').eq('workspace_id', ws).in('phone_e164', ps);
    return (data || []) as Conv[];
  })).flat());
  const convByPhone = new Map(convs.map((c) => [c.phone_e164, c]));
  const phoneByConv = new Map(convs.map((c) => [c.id, c.phone_e164]));

  const failsByPhone = new Map<string, { atMs: number; code: string | null }[]>();
  for (const m of allFails) {
    const p = phoneByConv.get(m.conversation_id); if (!p) continue;
    if (!failsByPhone.has(p)) failsByPhone.set(p, []);
    failsByPhone.get(p)!.push({ atMs: new Date(m.created_at).getTime(), code: m.error_code });
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
  const leadIds = candidates.map((r) => r.lead_id).filter(Boolean) as string[];
  const leads = new Map<string, { full_name: string | null; stage: string | null }>();
  const suppressed = new Set<string>();
  await Promise.all([
    inParallel(chunk(candConvIds, 100), async (ids) => {
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
    }),
    inParallel(chunk(leadIds, 100), async (ids) => {
      const { data } = await admin.from('leads').select('id, full_name, stage').in('id', ids);
      for (const l of (data || []) as { id: string; full_name: string | null; stage: string | null }[]) leads.set(l.id, l);
    }),
    (async () => {
      const { data: supp } = await admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', ws);
      for (const x of (supp || []) as { phone_e164: string }[]) suppressed.add(x.phone_e164);
    })(),
  ]);

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
