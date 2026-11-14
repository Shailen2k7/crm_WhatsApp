// =============================================================================
// BROADCAST PEOPLE — everyone a broadcast could go to, read once.
// -----------------------------------------------------------------------------
// One person per phone number: a CRM lead fused with their WhatsApp chats, plus
// the few chats that have no lead. The number used is the one they actually
// talk on (their busiest linked chat), falling back to the CRM phone — the same
// rule the nurture and the cold chase use.
//
// Read in a handful of parallel pages (about 4,500 leads and 3,200 chats), so
// the page opens in a second or two and every filter after that is instant.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { toE164, matchKey } from '@/lib/phone';
import { getVisaMeta } from '@/lib/types';
import type { BroadcastPerson } from './audience';

const PAGE = 1000;

/** Every row of a query, pages fetched side by side after the first tells us how many there are. */
async function readAll<T>(
  page: (from: number, to: number, withCount: boolean) => PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }>,
  label: string,
): Promise<T[]> {
  const first = await page(0, PAGE - 1, true);
  if (first.error) throw new Error(`${label}: ${first.error.message}`);
  const rows = [...((first.data || []) as T[])];
  const total = first.count ?? rows.length;
  if (total <= PAGE) return rows;
  const starts: number[] = [];
  for (let from = PAGE; from < total; from += PAGE) starts.push(from);
  const rest = await Promise.all(starts.map((from) => page(from, from + PAGE - 1, false)));
  for (const r of rest) {
    if (r.error) throw new Error(`${label}: ${r.error.message}`);
    rows.push(...((r.data || []) as T[]));
  }
  return rows;
}

interface LeadRow {
  id: string; full_name: string | null; phone: string | null; visa_type: string | null; stage: string | null;
  source: string | null; tags: string[] | null; eligibility: string | null; is_spotlight: boolean | null;
  is_sample: boolean | null; retired_at: string | null; created_at: string;
}
interface ConvRow {
  id: string; lead_id: string | null; phone_e164: string; spotlight: boolean | null;
  last_inbound_at: string | null; last_outbound_at: string | null; last_message_at: string | null; created_at: string;
}

/** When two leads share a number, the one that matters more speaks for it. */
const STAGE_RANK: Record<string, number> = {
  won: 0, invoice_sent: 1, hot: 2, mr_coming_soon: 3, not_responding: 4, cold: 5, lost: 6, junk: 7,
};

const latest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

export async function loadBroadcastPeople(
  admin: SupabaseClient, ws: string,
): Promise<{ people: BroadcastPerson[]; stopPhones: string[] }> {
  const leadCols = 'id, full_name, phone, visa_type, stage, source, tags, eligibility, is_spotlight, is_sample, retired_at, created_at';
  const convCols = 'id, lead_id, phone_e164, spotlight, last_inbound_at, last_outbound_at, last_message_at, created_at';

  const [leads, convs, stops] = await Promise.all([
    readAll<LeadRow>((from, to, withCount) =>
      admin.from('leads').select(leadCols, withCount ? { count: 'exact' } : undefined)
        .eq('workspace_id', ws).order('id').range(from, to), 'leads'),
    readAll<ConvRow>((from, to, withCount) =>
      admin.from('relay_conversations').select(convCols, withCount ? { count: 'exact' } : undefined)
        .eq('workspace_id', ws).order('id').range(from, to), 'chats'),
    admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', ws).limit(10000),
  ]);
  if (stops.error) throw new Error(`stop list: ${stops.error.message}`);
  const stopPhones = [...new Set(((stops.data || []) as { phone_e164: string }[]).map((s) => s.phone_e164))];
  const stopSet = new Set(stopPhones);
  const stop10 = new Set(stopPhones.map((p) => matchKey(p)).filter(Boolean) as string[]);

  const convsByLead = new Map<string, ConvRow[]>();
  const convsBy10 = new Map<string, ConvRow[]>();
  for (const c of convs) {
    if (c.lead_id) { if (!convsByLead.has(c.lead_id)) convsByLead.set(c.lead_id, []); convsByLead.get(c.lead_id)!.push(c); }
    const k = matchKey(c.phone_e164);
    if (k) { if (!convsBy10.has(k)) convsBy10.set(k, []); convsBy10.get(k)!.push(c); }
  }

  const byPhone = new Map<string, BroadcastPerson & { rank: number }>();
  const claimedConvs = new Set<string>();

  for (const l of leads) {
    if (l.is_sample) continue;
    const mine = [...new Map([
      ...(convsByLead.get(l.id) || []).map((c) => [c.id, c] as const),
      ...(convsBy10.get(matchKey(l.phone) || '') || []).map((c) => [c.id, c] as const),
    ]).values()];
    for (const c of mine) claimedConvs.add(c.id);
    const byRecent = (a: ConvRow, b: ConvRow) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || ''));
    const best = mine.filter((c) => c.lead_id === l.id).sort(byRecent)[0] ?? [...mine].sort(byRecent)[0] ?? null;
    const phone = best?.phone_e164 ?? toE164(l.phone);
    if (!phone) continue;

    const visaShort = getVisaMeta(l.visa_type)?.short;
    const person: BroadcastPerson & { rank: number } = {
      id: l.id,
      leadId: l.id,
      name: (l.full_name || '').trim(),
      phone,
      stage: l.stage || 'unknown',
      visa: visaShort === 'IFV' ? 'ifv' : visaShort === 'GTV' ? 'gtv' : 'unknown',
      eligibility: l.eligibility || 'unknown',
      tags: Array.isArray(l.tags) ? l.tags : [],
      source: (l.source || '').trim(),
      spotlight: !!l.is_spotlight || mine.some((c) => !!c.spotlight),
      createdAt: l.created_at,
      lastInboundAt: mine.reduce<string | null>((a, c) => latest(a, c.last_inbound_at), null),
      lastOutboundAt: mine.reduce<string | null>((a, c) => latest(a, c.last_outbound_at), null),
      // STOP on any of their numbers is STOP for the person.
      stop: stopSet.has(phone) || mine.some((c) => stopSet.has(c.phone_e164)) || stop10.has(matchKey(l.phone) || '-'),
      retired: !!l.retired_at,
      rank: (l.retired_at ? 100 : 0) + (STAGE_RANK[l.stage || ''] ?? 50),
    };
    const held = byPhone.get(phone);
    if (!held) { byPhone.set(phone, person); continue; }
    // Same number on two leads: one person. STOP and Spotlight carry over.
    const winner = person.rank < held.rank || (person.rank === held.rank && person.createdAt > held.createdAt) ? person : held;
    const other = winner === person ? held : person;
    byPhone.set(phone, {
      ...winner,
      stop: winner.stop || other.stop,
      spotlight: winner.spotlight || other.spotlight,
      lastInboundAt: latest(winner.lastInboundAt, other.lastInboundAt),
      lastOutboundAt: latest(winner.lastOutboundAt, other.lastOutboundAt),
    });
  }

  // Chats with nobody in the CRM behind them.
  for (const c of convs) {
    if (c.lead_id || claimedConvs.has(c.id) || byPhone.has(c.phone_e164)) continue;
    byPhone.set(c.phone_e164, {
      id: `c:${c.id}`, leadId: null, name: '', phone: c.phone_e164, stage: 'no_lead', visa: 'unknown',
      eligibility: 'unknown', tags: [], source: '', spotlight: !!c.spotlight, createdAt: c.created_at,
      lastInboundAt: c.last_inbound_at, lastOutboundAt: c.last_outbound_at,
      stop: stopSet.has(c.phone_e164), retired: false, rank: 60,
    });
  }

  const people: BroadcastPerson[] = [...byPhone.values()].map(({ rank: _rank, ...p }) => p);
  return { people, stopPhones };
}
