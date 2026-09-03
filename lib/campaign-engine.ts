// =============================================================================
// CAMPAIGN ENGINE — drains one-time campaigns, a few per tick.
// -----------------------------------------------------------------------------
// Rides the same 2-minute automation tick as the sequences. Each pass it picks
// up campaigns that are due and sends the next handful of queued recipients.
//
// Deliberately independent of the C1–C8 sequence: a campaign never reads or
// writes relay_lead_sequences, so blasting an announcement cannot disturb
// somebody's drip, and vice versa.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTemplateToLead } from '@/lib/send-template';

/** Kept small so a serverless invocation always finishes well inside its limit. */
const SEND_BUDGET_PER_TICK = 8;

export interface CampaignReport {
  campaign: string;
  sent: number;
  failed: number;
  remaining: number;
  finished: boolean;
}

export async function runCampaigns(admin: SupabaseClient): Promise<CampaignReport[]> {
  const nowIso = new Date().toISOString();

  // Anything actively sending, plus anything whose scheduled time has arrived.
  const { data: campaigns } = await admin
    .from('relay_campaigns')
    .select('*')
    .in('status', ['sending', 'scheduled'])
    .order('created_at', { ascending: true });
  if (!campaigns?.length) return [];

  const reports: CampaignReport[] = [];

  for (const c of campaigns) {
    if (c.status === 'scheduled') {
      if (c.scheduled_at && c.scheduled_at > nowIso) continue;   // not yet
      await admin.from('relay_campaigns')
        .update({ status: 'sending', started_at: c.started_at ?? nowIso, updated_at: nowIso })
        .eq('id', c.id);
    }

    const ws = c.workspace_id as string;
    const report: CampaignReport = { campaign: c.name, sent: 0, failed: 0, remaining: 0, finished: false };
    reports.push(report);

    const { data: queued } = await admin
      .from('relay_campaign_recipients')
      .select('*')
      .eq('campaign_id', c.id)
      .eq('status', 'queued')
      .limit(SEND_BUDGET_PER_TICK);

    // Nothing left to send — close it out.
    if (!queued?.length) {
      const { count } = await admin
        .from('relay_campaign_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', c.id).eq('status', 'queued');
      if ((count ?? 0) === 0) {
        await admin.from('relay_campaigns')
          .update({ status: 'done', finished_at: nowIso, updated_at: nowIso })
          .eq('id', c.id);
        report.finished = true;
      }
      continue;
    }

    // Anyone who opted out is skipped, campaign or not.
    const { data: suppressed } = await admin
      .from('relay_suppressions').select('phone_e164').eq('workspace_id', ws);
    const stop = new Set((suppressed || []).map((s) => s.phone_e164));

    for (const r of queued) {
      if (stop.has(r.phone_e164)) {
        await admin.from('relay_campaign_recipients')
          .update({ status: 'skipped', error: 'opted out (STOP)' }).eq('id', r.id);
        continue;
      }

      const { data: convId } = await admin.rpc('relay_get_or_create_conversation', {
        p_workspace_id: ws, p_phone_e164: r.phone_e164,
      });
      if (!convId) {
        await admin.from('relay_campaign_recipients')
          .update({ status: 'failed', error: 'could not open a conversation' }).eq('id', r.id);
        report.failed++;
        continue;
      }

      const { data: lead } = r.lead_id
        ? await admin.from('leads').select('full_name, visa_type').eq('id', r.lead_id).maybeSingle()
        : { data: null };

      const res = await sendTemplateToLead(admin, {
        workspaceId: ws, conversationId: convId as string, phoneE164: r.phone_e164,
        templateName: c.template_name, language: c.template_language || 'en',
        lead: lead || { full_name: r.full_name },
      });

      await admin.from('relay_campaign_recipients').update({
        status: res.ok ? 'sent' : 'failed',
        error: res.error, message_id: res.messageId, sent_at: new Date().toISOString(),
      }).eq('id', r.id);

      if (res.ok) report.sent++; else report.failed++;
    }

    // Roll the per-recipient outcomes up onto the campaign row.
    const [{ count: sentTotal }, { count: failedTotal }, { count: skippedTotal }, { count: left }] = await Promise.all([
      admin.from('relay_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).eq('status', 'sent'),
      admin.from('relay_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).eq('status', 'failed'),
      admin.from('relay_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).eq('status', 'skipped'),
      admin.from('relay_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).eq('status', 'queued'),
    ]);

    report.remaining = left ?? 0;
    const done = (left ?? 0) === 0;
    report.finished = done;

    await admin.from('relay_campaigns').update({
      sent: sentTotal ?? 0, failed: failedTotal ?? 0, skipped: skippedTotal ?? 0,
      status: done ? 'done' : 'sending',
      finished_at: done ? nowIso : null,
      updated_at: nowIso,
    }).eq('id', c.id);
  }

  return reports;
}
