// =============================================================================
// CALL MESSAGES DATA — the two rules and the recent meetings, in a few trips.
// One loader, two readers (the tick that sends and the Automation tab).
// Bounded by the 48-hour look-back: a couple of days of meetings, however big
// the CRM grows.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { toE164 } from '@/lib/phone';
import { chunk, inParallel } from './parallel';
import {
  MEETING_LOOKBACK_MS, MEETING_RULE_KEYS, meetingSentKey,
  type MeetingHistRow, type MeetingRow, type MeetingRule, type MeetingRuleKey,
} from './meetings';

export async function loadMeetingRules(admin: SupabaseClient, workspaceId: string | null): Promise<{ ws: string; rules: MeetingRule[] } | null> {
  let q = admin.from('relay_automations')
    .select('workspace_id, key, enabled, activated_at, template_name, template_language, delay_seconds, quiet_start_hour, quiet_end_hour')
    .in('key', MEETING_RULE_KEYS);
  if (workspaceId) q = q.eq('workspace_id', workspaceId);
  const { data, error } = await q;
  if (error) throw new Error(`meeting rules: ${error.message}`);
  const rows = (data || []) as {
    workspace_id: string; key: MeetingRuleKey; enabled: boolean; activated_at: string | null; template_name: string | null;
    template_language: string | null; delay_seconds: number | null; quiet_start_hour: number | null; quiet_end_hour: number | null;
  }[];
  if (!rows.length) return null;
  const ws = rows[0].workspace_id;
  return {
    ws,
    rules: MEETING_RULE_KEYS.map((key) => rows.find((r) => r.workspace_id === ws && r.key === key)).filter(Boolean).map((r) => ({
      key: r!.key,
      enabled: !!r!.enabled,
      activatedAt: r!.activated_at,
      templateName: r!.template_name,
      templateLanguage: r!.template_language || 'en',
      delaySeconds: Math.max(0, Number(r!.delay_seconds) || 0),
      quietStartHour: r!.quiet_start_hour,
      quietEndHour: r!.quiet_end_hour,
    })),
  };
}

export async function loadMeetingFacts(
  admin: SupabaseClient,
  opts: { ws: string; now: number; suppressed?: { workspace_id: string; phone_e164: string }[]; templates?: string[] },
): Promise<{ meetings: MeetingRow[]; history: Map<string, MeetingHistRow> }> {
  const { ws, now } = opts;
  const since = new Date(now - MEETING_LOOKBACK_MS).toISOString();

  // Booked OR completed in the look-back window.
  type Raw = { id: string; lead_id: string | null; client_name: string | null; client_phone: string | null; status: string; starts_at: string; created_at: string; completed_at: string | null };
  const cols = 'id, lead_id, client_name, client_phone, status, starts_at, created_at, completed_at';
  const [booked, completed] = await Promise.all([
    admin.from('meetings').select(cols).eq('workspace_id', ws).gte('created_at', since).limit(500),
    admin.from('meetings').select(cols).eq('workspace_id', ws).gte('completed_at', since).limit(500),
  ]);
  if (booked.error) throw new Error(`meetings: ${booked.error.message}`);
  if (completed.error) throw new Error(`meetings: ${completed.error.message}`);
  const raw = new Map<string, Raw>();
  for (const m of [...(booked.data || []), ...(completed.data || [])] as Raw[]) raw.set(m.id, m);
  if (!raw.size) return { meetings: [], history: new Map() };

  const ids = [...raw.keys()];
  const leadIds = [...new Set([...raw.values()].map((m) => m.lead_id).filter(Boolean) as string[])];
  const leads = new Map<string, { full_name: string | null; visa_type: string | null; phone: string | null; eligibility: string | null }>();
  const chatByLead = new Map<string, { id: string; phone_e164: string; last_inbound_at: string | null }>();
  const history = new Map<string, MeetingHistRow>();

  const [, , , suppRows] = await Promise.all([
    inParallel(chunk(leadIds, 100), async (ls) => {
      const { data, error } = await admin.from('leads').select('id, full_name, visa_type, phone, eligibility').in('id', ls);
      if (error) throw new Error(`meeting leads: ${error.message}`);
      for (const l of (data || []) as { id: string; full_name: string | null; visa_type: string | null; phone: string | null; eligibility: string | null }[]) leads.set(l.id, l);
    }),
    inParallel(chunk(leadIds, 100), async (ls) => {
      // The chat they actually write from wins over the phone typed on a form.
      const { data, error } = await admin.from('relay_conversations').select('id, phone_e164, last_inbound_at, lead_id')
        .eq('workspace_id', ws).in('lead_id', ls);
      if (error) throw new Error(`meeting chats: ${error.message}`);
      for (const c of (data || []) as { id: string; phone_e164: string; last_inbound_at: string | null; lead_id: string }[]) {
        const cur = chatByLead.get(c.lead_id);
        if (!cur || String(c.last_inbound_at || '') > String(cur.last_inbound_at || '')) chatByLead.set(c.lead_id, c);
      }
    }),
    inParallel(chunk(ids, 100), async (ms) => {
      const { data, error } = await admin.from('relay_automation_sent')
        .select('id, automation_key, meeting_id, ok, attempts, sent_at, error')
        .eq('workspace_id', ws).in('meeting_id', ms);
      if (error) throw new Error(`meeting history: ${error.message}`);
      for (const h of (data || []) as MeetingHistRow[]) history.set(h.automation_key, h);
    }),
    opts.suppressed
      ? Promise.resolve(opts.suppressed)
      : admin.from('relay_suppressions').select('workspace_id, phone_e164').eq('workspace_id', ws)
        .then(({ data }) => (data || []) as { workspace_id: string; phone_e164: string }[]),
  ]);
  const suppressed = new Set(suppRows.filter((s) => s.workspace_id === ws).map((s) => s.phone_e164));

  // Chats found by phone, for bookings with no lead (or a lead with no chat).
  const byPhone = new Map<string, { id: string; phone_e164: string }>();
  const loosePhones = [...new Set([...raw.values()]
    .filter((m) => !(m.lead_id && chatByLead.has(m.lead_id)))
    .map((m) => toE164(m.client_phone) || (m.lead_id ? toE164(leads.get(m.lead_id)?.phone) : null))
    .filter(Boolean) as string[])];
  await inParallel(chunk(loosePhones, 100), async (ps) => {
    const { data } = await admin.from('relay_conversations').select('id, phone_e164').eq('workspace_id', ws).in('phone_e164', ps);
    for (const c of (data || []) as { id: string; phone_e164: string }[]) byPhone.set(c.phone_e164, c);
  });

  // When pc1 / pc2 last went to each of these chats, by anyone (the team sends them by hand too).
  const templates = opts.templates?.length ? opts.templates : ['pc1', 'pc2'];
  const convIds = [...new Set([...chatByLead.values(), ...byPhone.values()].map((c) => c.id))];
  const sentByConv = new Map<string, Record<string, number>>();
  await inParallel(chunk(convIds, 100), async (cs) => {
    const { data, error } = await admin.from('relay_messages').select('conversation_id, template_name, created_at')
      .in('conversation_id', cs).eq('direction', 'out').in('template_name', templates).neq('status', 'failed')
      .gte('created_at', new Date(now - MEETING_LOOKBACK_MS - 24 * 3_600_000).toISOString()).limit(2000);
    if (error) throw new Error(`meeting messages: ${error.message}`);
    for (const r of (data || []) as { conversation_id: string; template_name: string; created_at: string }[]) {
      const rec = sentByConv.get(r.conversation_id) ?? {};
      rec[r.template_name] = Math.max(rec[r.template_name] ?? 0, new Date(r.created_at).getTime());
      sentByConv.set(r.conversation_id, rec);
    }
  });

  const meetings: MeetingRow[] = [...raw.values()].map((m) => {
    const lead = m.lead_id ? leads.get(m.lead_id) ?? null : null;
    const chat = m.lead_id ? chatByLead.get(m.lead_id) ?? null : null;
    const phone = chat?.phone_e164 || toE164(m.client_phone) || toE164(lead?.phone) || null;
    const conv = chat ?? (phone ? byPhone.get(phone) ?? null : null);
    return {
      id: m.id, lead_id: m.lead_id, client_name: m.client_name, status: m.status,
      starts_at: m.starts_at, created_at: m.created_at, completed_at: m.completed_at,
      phoneE164: phone, conversationId: conv?.id ?? null,
      name: lead?.full_name || m.client_name, visaType: lead?.visa_type ?? null,
      eligibility: lead?.eligibility ?? null,
      suppressed: !!phone && suppressed.has(phone),
      templateSentMs: conv ? sentByConv.get(conv.id) ?? {} : {},
    };
  });
  // Oldest event first: nobody waits behind a newer booking.
  meetings.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { meetings, history };
}

export { meetingSentKey };
