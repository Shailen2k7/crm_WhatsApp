// =============================================================================
// NURTURE DATA — everything the HS1→HS8 planner needs, read in parallel.
// -----------------------------------------------------------------------------
// One loader, two readers (the tick that sends and the Automation tab that
// shows), so the screen can never promise something the engine will not do.
//
// The audience is LEADS (stage Hot, or the Spotlight flag on the lead or on a
// starred chat). Silence is measured across EVERY conversation that is this
// person: the one matching their CRM phone and any chat linked to their lead
// from another number — a reply anywhere resets the clock.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { toE164 } from '@/lib/phone';
import { ecosystemStatesByConv } from './ecosystem';
import { chunk } from './parallel';
import {
  NURTURE_KEYS, NURTURE_PAUSE_KEY, NURTURE_RULE_KEY,
  type NurtureHistRow, type NurturePerson,
} from './nurture';

export interface NurtureRule {
  ws: string;
  enabled: boolean;
  dailyCap: number;
  activatedAtMs: number;
}

export async function loadNurtureRule(admin: SupabaseClient, workspaceId: string | null, now: number): Promise<NurtureRule | null> {
  let q = admin.from('relay_automations').select('workspace_id, enabled, daily_cap, activated_at').eq('key', NURTURE_RULE_KEY);
  if (workspaceId) q = q.eq('workspace_id', workspaceId);
  const { data, error } = await q.limit(1);
  if (error) throw new Error(`nurture rule: ${error.message}`);
  const r = (data || [])[0] as { workspace_id: string; enabled: boolean; daily_cap: number | null; activated_at: string | null } | undefined;
  if (!r) return null;
  return {
    ws: r.workspace_id,
    enabled: !!r.enabled,
    dailyCap: Number(r.daily_cap) || 0,
    activatedAtMs: r.activated_at ? new Date(r.activated_at).getTime() : now,
  };
}

export interface NurtureFacts {
  people: NurturePerson[];
  history: NurtureHistRow[];
}

export async function loadNurtureFacts(
  admin: SupabaseClient,
  opts: { ws: string; now: number; suppressed?: { workspace_id: string; phone_e164: string }[] },
): Promise<NurtureFacts> {
  const { ws, now } = opts;
  const last10 = (p: string | null | undefined) => {
    const d = String(p || '').replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : null;
  };

  // ---- the audience, starred chats and opt-outs — in parallel ----------------
  // EVERY read here is bounded by the AUDIENCE (Hot/Spotlight leads), never by
  // all-time history: the number of conversations, sends and records can grow
  // forever and this run stays the same size. (Until 24 Oct 2026 it read every
  // conversation ever, capped at 5,000 — a ceiling that would one day have
  // silently hidden someone's latest message.)
  type LeadRow = { id: string; full_name: string | null; phone: string | null; visa_type: string | null; stage: string | null; is_spotlight: boolean | null };
  type ConvRow = { id: string; phone_e164: string; lead_id: string | null; last_message_at: string | null; spotlight: boolean | null };
  const convCols = 'id, phone_e164, lead_id, last_message_at, spotlight';
  const leadCols = 'id, full_name, phone, visa_type, stage, is_spotlight';
  const [leadsRes, starredRes, suppRes] = await Promise.all([
    admin.from('leads').select(leadCols)
      .eq('workspace_id', ws).eq('is_sample', false)
      .or('stage.eq.hot,is_spotlight.eq.true').limit(5000),
    admin.from('relay_conversations').select(convCols)
      .eq('workspace_id', ws).eq('spotlight', true).limit(2000),
    opts.suppressed
      ? Promise.resolve({ data: opts.suppressed, error: null })
      : admin.from('relay_suppressions').select('workspace_id, phone_e164').eq('workspace_id', ws),
  ]);
  if (leadsRes.error) throw new Error(`nurture leads: ${leadsRes.error.message}`);
  if (starredRes.error) throw new Error(`nurture starred: ${starredRes.error.message}`);
  const leads = (leadsRes.data || []) as LeadRow[];
  const suppressed = new Set(((suppRes.data || []) as { workspace_id: string; phone_e164: string }[])
    .filter((s) => s.workspace_id === ws).map((s) => s.phone_e164));

  // A starred chat whose lead is not Hot/Spotlight still counts (the team
  // starred it for a reason) — bring that lead in.
  const starred = (starredRes.data || []) as ConvRow[];
  const haveLead = new Set(leads.map((l) => l.id));
  const extraIds = [...new Set(starred.filter((c) => c.lead_id && !haveLead.has(c.lead_id)).map((c) => c.lead_id as string))];
  if (extraIds.length) {
    const parts = await Promise.all(chunk(extraIds, 100).map((ids) =>
      admin.from('leads').select(leadCols).eq('workspace_id', ws).eq('is_sample', false).in('id', ids)));
    for (const { data } of parts) leads.push(...((data || []) as LeadRow[]));
  }

  // ---- only the audience's own conversations: by lead link and by number ----
  const leadIds = leads.map((l) => l.id);
  const leadPhones = [...new Set(leads.map((l) => toE164(l.phone)).filter(Boolean) as string[])];
  const [byLead, byPhone] = await Promise.all([
    Promise.all(chunk(leadIds, 100).map((ids) =>
      admin.from('relay_conversations').select(convCols).eq('workspace_id', ws).in('lead_id', ids).limit(2000))),
    Promise.all(chunk(leadPhones, 100).map((ps) =>
      admin.from('relay_conversations').select(convCols).eq('workspace_id', ws).in('phone_e164', ps).limit(2000))),
  ]);
  const convById = new Map<string, ConvRow>();
  for (const part of [...byLead, ...byPhone, { data: starred, error: null }]) {
    if (part.error) throw new Error(`nurture convs: ${part.error.message}`);
    for (const c of (part.data || []) as ConvRow[]) convById.set(c.id, c);
  }
  const convs = [...convById.values()];

  // ---- their nurture history: only these people's numbers -------------------
  const histPhones = [...new Set([...convs.map((c) => c.phone_e164), ...leadPhones])];
  const histParts = await Promise.all(chunk(histPhones, 100).map((ps) =>
    admin.from('relay_automation_sent')
      .select('id, automation_key, lead_id, phone_e164, ok, attempts, sent_at, error')
      .eq('workspace_id', ws).in('automation_key', [...NURTURE_KEYS, NURTURE_PAUSE_KEY]).in('phone_e164', ps).limit(2000)));
  const history: NurtureHistRow[] = [];
  for (const part of histParts) {
    if (part.error) throw new Error(`nurture history: ${part.error.message}`);
    history.push(...((part.data || []) as NurtureHistRow[]));
  }

  const convsByLead = new Map<string, ConvRow[]>();
  const convsBy10 = new Map<string, ConvRow[]>();
  for (const c of convs) {
    if (c.lead_id) { if (!convsByLead.has(c.lead_id)) convsByLead.set(c.lead_id, []); convsByLead.get(c.lead_id)!.push(c); }
    const k = last10(c.phone_e164);
    if (k) { if (!convsBy10.has(k)) convsBy10.set(k, []); convsBy10.get(k)!.push(c); }
  }

  // ---- one person = lead + every conversation that is theirs -----------------
  const pre = leads.map((l) => {
    const mine = [...new Map([
      ...(convsByLead.get(l.id) || []).map((c) => [c.id, c] as const),
      ...(convsBy10.get(last10(l.phone) || '') || []).map((c) => [c.id, c] as const),
    ]).values()];
    // Send where they actually talk: the busiest linked chat wins; the CRM
    // phone is the fallback for a Hot lead who has never messaged.
    const best = mine.filter((c) => c.lead_id === l.id).sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')))[0]
      ?? mine.sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')))[0]
      ?? null;
    const phone = best?.phone_e164 ?? toE164(l.phone);
    return { l, mine, best, phone };
  }).filter((x): x is typeof x & { phone: string } => !!x.phone);

  const allConvIds = pre.flatMap((x) => x.mine.map((c) => c.id));
  // Ecosystem state and every refused automated message, side by side.
  const failsByConv = new Map<string, { atMs: number; code: string | null }[]>();
  const [eco] = await Promise.all([
    ecosystemStatesByConv(admin, allConvIds, now),
    Promise.all(chunk(allConvIds, 100).map(async (ids) => {
      const { data } = await admin.from('relay_messages').select('conversation_id, created_at, error_code')
        .in('conversation_id', ids).eq('direction', 'out').is('sent_by', null).eq('status', 'failed').limit(5000);
      for (const m of (data || []) as { conversation_id: string; created_at: string; error_code: string | null }[]) {
        if (!failsByConv.has(m.conversation_id)) failsByConv.set(m.conversation_id, []);
        failsByConv.get(m.conversation_id)!.push({ atMs: new Date(m.created_at).getTime(), code: m.error_code });
      }
    })),
  ]);

  const pausedPhones = new Set(history.filter((h) => h.automation_key === NURTURE_PAUSE_KEY && (h.error || '').startsWith('paused')).map((h) => h.phone_e164));

  const people: NurturePerson[] = pre.map(({ l, mine, best, phone }) => {
    const activity = mine.map((c) => (c.last_message_at ? new Date(c.last_message_at).getTime() : null)).filter((x): x is number => x !== null);
    const ecoStates = mine.map((c) => eco.get(c.id)).filter(Boolean) as { stopped: boolean; pausedUntil: string | null }[];
    const pausedUntilMs = ecoStates.map((e) => (e.pausedUntil ? new Date(e.pausedUntil).getTime() : null)).filter((x): x is number => x !== null);
    return {
      leadId: l.id,
      phoneE164: phone,
      name: l.full_name,
      visaType: l.visa_type,
      stage: l.stage,
      spotlight: !!l.is_spotlight || mine.some((c) => c.spotlight),
      conversationId: best?.id ?? null,
      lastActivityMs: activity.length ? Math.max(...activity) : null,
      suppressed: suppressed.has(phone) || mine.some((c) => suppressed.has(c.phone_e164)),
      ecosystem: ecoStates.length ? {
        stopped: ecoStates.some((e) => e.stopped),
        pausedUntil: pausedUntilMs.length ? new Date(Math.max(...pausedUntilMs)).toISOString() : null,
      } : null,
      paused: pausedPhones.has(phone),
      failTimes: mine.flatMap((c) => failsByConv.get(c.id) || []),
    };
  });

  return { people, history };
}
