// =============================================================================
// BROADCAST RESULTS — what happened to each person, read live.
// -----------------------------------------------------------------------------
// A person's line knows whether Interakt took the message. Whether it was then
// DELIVERED and READ lives on the chat message (the webhook stamps it), and
// whether they REPLIED is an inbound message after it. This joins the three in
// a few paged reads — never one query per person — so a 2,000-person broadcast
// can be watched while it sends.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  inQuietHours, quietHoursEnd,
  type BroadcastDetail, type BroadcastMeta, type BroadcastSummary, type RecipientLine,
} from './model';
import { refreshCounters, UNCONFIRMED, type CampaignRow } from './engine';

const PAGE = 1000;

async function pages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string, max = 20,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    const { data, error } = await page(i * PAGE, i * PAGE + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = (data || []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export function summarise(c: CampaignRow, meta: BroadcastMeta | null | undefined): BroadcastSummary {
  return {
    id: c.id, name: c.name, templateName: c.template_name, templateLanguage: c.template_language,
    status: c.status, scheduledAt: c.scheduled_at, startedAt: c.started_at, finishedAt: c.finished_at,
    createdAt: c.created_at, total: c.total, sent: c.sent, failed: c.failed, skipped: c.skipped,
    waiting: Math.max(0, c.total - c.sent - c.failed - c.skipped),
    audienceLabel: meta?.audienceLabel ?? null, createdByName: meta?.createdByName ?? null,
    pausedReason: meta?.pausedReason ?? null, quietHours: meta?.quietHours ?? true, rate: meta?.rate ?? 'normal',
  };
}

export async function buildDetail(
  admin: SupabaseClient, c: CampaignRow, meta: BroadcastMeta, now: number = Date.now(),
): Promise<BroadcastDetail> {
  // Late verdicts first, so the lines below are already the truth.
  if (c.started_at) {
    const counts = await refreshCounters(admin, c);
    c = { ...c, sent: counts.sent, failed: counts.failed, skipped: counts.skipped, total: counts.queued + counts.sent + counts.failed + counts.skipped };
  }

  type Rec = { id: string; lead_id: string | null; phone_e164: string; full_name: string | null; status: string; error: string | null; message_id: string | null; sent_at: string | null };
  type Msg = { id: string; status: string; conversation_id: string };
  type In = { conversation_id: string; created_at: string };

  const since = c.started_at;
  const [recs, msgs, inbound] = await Promise.all([
    pages<Rec>((from, to) => admin.from('relay_campaign_recipients')
      .select('id, lead_id, phone_e164, full_name, status, error, message_id, sent_at')
      .eq('campaign_id', c.id).order('id').range(from, to), 'people'),
    since
      ? pages<Msg>((from, to) => admin.from('relay_messages').select('id, status, conversation_id')
          .eq('workspace_id', c.workspace_id).eq('direction', 'out').eq('template_name', c.template_name)
          .gte('created_at', since).order('created_at').range(from, to), 'messages')
      : Promise.resolve([] as Msg[]),
    since
      ? pages<In>((from, to) => admin.from('relay_messages').select('conversation_id, created_at')
          .eq('workspace_id', c.workspace_id).eq('direction', 'in')
          .gte('created_at', since).order('created_at').range(from, to), 'replies')
      : Promise.resolve([] as In[]),
  ]);

  const msgById = new Map(msgs.map((m) => [m.id, m]));
  const lastInbound = new Map<string, string>();
  for (const m of inbound) {
    const held = lastInbound.get(m.conversation_id);
    if (!held || m.created_at > held) lastInbound.set(m.conversation_id, m.created_at);
  }

  const counts = { waiting: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0 };
  const people: RecipientLine[] = recs.map((r) => {
    const msg = r.message_id ? msgById.get(r.message_id) : undefined;
    let state: RecipientLine['state'];
    if (r.status === 'queued') state = 'waiting';
    else if (r.status === 'skipped') state = 'skipped';
    else if (r.status === 'failed' || msg?.status === 'failed') state = 'failed';
    else state = msg?.status === 'read' ? 'read' : msg?.status === 'delivered' ? 'delivered' : 'sent';

    const repliedAt = msg ? lastInbound.get(msg.conversation_id) : undefined;
    const replied = !!(repliedAt && r.sent_at && repliedAt > r.sent_at && state !== 'failed' && state !== 'skipped' && state !== 'waiting');

    counts[state]++;
    // "Sent" is everyone it went to; delivered and read are steps further along.
    if (state === 'delivered' || state === 'read') counts.sent++;
    if (state === 'read') counts.delivered++;
    if (replied) counts.replied++;

    return {
      id: r.id, leadId: r.lead_id, name: (r.full_name || '').trim(), phone: r.phone_e164, state, replied,
      note: state === 'failed' || state === 'skipped' ? r.error : r.error === UNCONFIRMED ? r.error : null,
      sentAt: r.sent_at,
    };
  });

  const holding = c.status === 'sending' && meta.quietHours && inQuietHours(now) && counts.waiting > 0;
  return {
    ...summarise(c, meta),
    waiting: counts.waiting,
    body: meta.body, variables: meta.variables, spec: meta.spec, header: meta.header,
    counts, people, holding, resumesAt: holding ? quietHoursEnd(now) : null,
  };
}
