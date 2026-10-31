// =============================================================================
// COMMUNITY DATA — everything the invite planner needs, read in a few trips.
// -----------------------------------------------------------------------------
// One loader, two readers (the tick that sends and the Automation tab).
//
// EVERYTHING here is bounded by one cheap fact: only conversations whose last
// inbound is younger than 24 hours can possibly qualify (the free window).
// That is a day's chats — a few dozen rows — however big the app grows. Past
// talkers need no backfill table: the moment they chat again, they appear here.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunk, inParallel } from './parallel';
import {
  COMMUNITY_KEY, COMMUNITY_RULE_KEY,
  type CommunityHistRow, type CommunityPerson,
} from './community';

export interface CommunityRule {
  ws: string;
  enabled: boolean;
  dailyCap: number;
  /** The quick reply (shortcut) whose text is sent. */
  quickReplyShortcut: string | null;
}

export async function loadCommunityRule(admin: SupabaseClient, workspaceId: string | null): Promise<CommunityRule | null> {
  let q = admin.from('relay_automations').select('workspace_id, enabled, daily_cap, quick_reply_shortcut').eq('key', COMMUNITY_RULE_KEY);
  if (workspaceId) q = q.eq('workspace_id', workspaceId);
  const { data, error } = await q.limit(1);
  if (error) throw new Error(`community rule: ${error.message}`);
  const r = (data || [])[0] as { workspace_id: string; enabled: boolean; daily_cap: number | null; quick_reply_shortcut: string | null } | undefined;
  if (!r) return null;
  return {
    ws: r.workspace_id,
    enabled: !!r.enabled,
    dailyCap: Number(r.daily_cap) || 0,
    quickReplyShortcut: r.quick_reply_shortcut,
  };
}

export async function loadCommunityPeople(
  admin: SupabaseClient,
  opts: { ws: string; now: number; suppressed?: { workspace_id: string; phone_e164: string }[] },
): Promise<CommunityPerson[]> {
  const { ws, now } = opts;

  // ---- the only audience that can qualify: inbound in the last 24 hours ------
  type ConvRow = { id: string; phone_e164: string; lead_id: string | null; last_inbound_at: string; last_message_at: string | null };
  const { data: convData, error: convErr } = await admin.from('relay_conversations')
    .select('id, phone_e164, lead_id, last_inbound_at, last_message_at')
    .eq('workspace_id', ws)
    .gte('last_inbound_at', new Date(now - 24 * 3_600_000).toISOString())
    .limit(2000);
  if (convErr) throw new Error(`community convs: ${convErr.message}`);
  const convs = (convData || []) as ConvRow[];
  if (!convs.length) return [];

  const convIds = convs.map((c) => c.id);
  const phones = [...new Set(convs.map((c) => c.phone_e164))];
  const leadIds = [...new Set(convs.map((c) => c.lead_id).filter(Boolean) as string[])];

  // ---- in parallel: their invite history, human replies, lead info, opt-outs --
  const history = new Map<string, CommunityHistRow>();           // by phone AND by lead
  const lastTeamOut = new Map<string, number>();                 // by conversation id
  const leadInfo = new Map<string, { full_name: string | null; visa_type: string | null; stage: string | null }>();
  const histCols = 'id, automation_key, lead_id, phone_e164, ok, attempts, sent_at, error';
  const keep = (h: CommunityHistRow) => {
    for (const k of [h.phone_e164, h.lead_id].filter(Boolean) as string[]) {
      const prev = history.get(k);
      // The row that already went (ok) always wins; otherwise the newest.
      if (!prev || (h.ok && !prev.ok) || (h.ok === prev.ok && h.sent_at > prev.sent_at)) history.set(k, h);
    }
  };
  const [, , , suppRows] = await Promise.all([
    inParallel(chunk(phones, 100), async (ps) => {
      const { data, error } = await admin.from('relay_automation_sent').select(histCols)
        .eq('workspace_id', ws).eq('automation_key', COMMUNITY_KEY).in('phone_e164', ps);
      if (error) throw new Error(`community history: ${error.message}`);
      for (const h of (data || []) as CommunityHistRow[]) keep(h);
    }),
    inParallel(chunk(convIds, 100), async (ids) => {
      const { data, error } = await admin.from('relay_messages').select('conversation_id, created_at')
        .in('conversation_id', ids).eq('direction', 'out').eq('is_internal', false)
        .not('sent_by', 'is', null).neq('status', 'failed')
        .gte('created_at', new Date(now - 48 * 3_600_000).toISOString()).limit(2000);
      if (error) throw new Error(`community team: ${error.message}`);
      for (const m of (data || []) as { conversation_id: string; created_at: string }[]) {
        lastTeamOut.set(m.conversation_id, Math.max(lastTeamOut.get(m.conversation_id) ?? 0, new Date(m.created_at).getTime()));
      }
    }),
    inParallel(chunk(leadIds, 100), async (ids) => {
      const { data, error } = await admin.from('leads').select('id, full_name, visa_type, stage').in('id', ids);
      if (error) throw new Error(`community leads: ${error.message}`);
      for (const l of (data || []) as { id: string; full_name: string | null; visa_type: string | null; stage: string | null }[]) {
        leadInfo.set(l.id, l);
      }
    }),
    opts.suppressed
      ? Promise.resolve(opts.suppressed)
      : admin.from('relay_suppressions').select('workspace_id, phone_e164').eq('workspace_id', ws)
        .then(({ data }) => (data || []) as { workspace_id: string; phone_e164: string }[]),
  ]);
  const suppressed = new Set(suppRows.filter((s) => s.workspace_id === ws).map((s) => s.phone_e164));

  return convs.map((c): CommunityPerson => {
    const lead = c.lead_id ? leadInfo.get(c.lead_id) ?? null : null;
    const lastInboundMs = new Date(c.last_inbound_at).getTime();
    return {
      conversationId: c.id,
      phoneE164: c.phone_e164,
      leadId: c.lead_id,
      name: lead?.full_name ?? null,
      visaType: lead?.visa_type ?? null,
      stage: lead?.stage ?? null,
      lastInboundMs,
      lastMessageMs: Math.max(lastInboundMs, c.last_message_at ? new Date(c.last_message_at).getTime() : 0),
      lastTeamOutMs: lastTeamOut.get(c.id) ?? null,
      suppressed: suppressed.has(c.phone_e164),
      prior: history.get(c.phone_e164) ?? (c.lead_id ? history.get(c.lead_id) : null) ?? null,
    };
  });
}
