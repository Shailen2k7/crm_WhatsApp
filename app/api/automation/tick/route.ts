import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { sendTemplateToLead } from '@/lib/send-template';
import { sendText, sendMedia, windowState, isConfigured, mediaTypeFrom } from '@/lib/interakt';
import { toE164 } from '@/lib/phone';
import { runSequences } from '@/lib/sequence-engine';
import { runCampaigns } from '@/lib/campaign-engine';
import { RELAY_BUCKET } from '@/lib/files';
import {
  CALL_TIMEOUT_MS, MAX_SENDS_PER_RUN, createAutomationAdminClient, createRunContext, forEachLimited, isTimeoutError,
  type RunContext,
} from '@/lib/automation/run-context';
import { acquireTickLock, releaseTickLock } from '@/lib/automation/lock';
import {
  planFirstMessages, isEnquiry, RECENT_WINDOW_HOURS,
  type ConvRow, type HistoryRow, type Job, type LeadRow,
} from '@/lib/automation/first-message';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// =============================================================================
// AUTOMATION TICK — the worker behind the workflow module.
//
// Called two ways:
//   * the Netlify Scheduled Function `automation-tick`, every 5 minutes, with
//     `Authorization: Bearer <CRON_SECRET>`
//   * the Automation panel's "Run it now" / dry-run button (signed-in user)
//
// One run does, within a fixed budget (see lib/automation/run-context.ts):
//   1. the first CV + LinkedIn message to every new lead / unknown enquiry
//   2. meeting booked / completed messages
//   3. the C1–C8, no-reply and hot sequences
//   4. one-time campaigns
//
// WHY IT LOOKS LIKE THIS — a run with nothing to send used to make ~108
// sequential round trips to the Singapore database (one per recent
// conversation) and take 15–25s. Called every 10s by pg_cron it ran into the
// ~27s platform timeout, overlapped itself, and pushed the bill from ~30 to
// ~590 credits a day. Now:
//   * a lock means two runs never overlap
//   * everything a run needs is read in two PARALLEL rounds, then planned in
//     memory — an idle run is ~3 round trips and returns in well under a second
//     on a warm function
//   * every call times out at 5s, nothing new starts after 6s, everything is
//     aborted at 9s, and at most 20 messages go out per run; the rest continue
//     next run
//
// A lead is only ever messaged ONCE by the first-message rule — enforced by two
// unique indexes (per lead id AND per phone), so even overlapping or duplicate
// work cannot send twice.
// =============================================================================

const IST = 'Asia/Kolkata';
const SEND_CONCURRENCY = 4;
/** Marks a send whose outcome is unknown because the provider did not answer in time. */
const TIMEOUT_NOTE = 'timeout — delivery unknown';

type Admin = SupabaseClient;

function istDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(d); // YYYY-MM-DD
}
function istHour(d = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: 'numeric', hour12: false }).format(d));
}
function firstNameOf(fullName: string | null | undefined): string {
  const n = (fullName || '').trim().split(/\s+/)[0];
  return n || 'there';
}
function visaLabelOf(visaType: string | null | undefined): string {
  const v = (visaType || '').toLowerCase();
  return v.includes('ifv') || v.includes('innovator') ? 'Innovator Founder Visa' : 'Global Talent Visa';
}
/** {{name}} / {{first_name}} / {{visa}} tokens in quick-reply bodies. */
function personalise(body: string, lead: { full_name?: string | null; visa_type?: string | null }): string {
  return body
    .replace(/\{\{\s*(?:name|first_name|firstname)\s*\}\}/gi, firstNameOf(lead.full_name))
    .replace(/\{\{\s*visa\s*\}\}/gi, visaLabelOf(lead.visa_type));
}
const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Constant-time comparison, so the secret cannot be guessed byte by byte. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  // ---- who is calling? -----------------------------------------------------
  // Machine callers must present CRON_SECRET, as a Bearer token or the
  // x-cron-secret header. This check touches no database, so a caller with a
  // wrong or retired secret — such as the old pg_cron jobs — costs a few
  // milliseconds, not a run.
  const auth = req.headers.get('authorization') || '';
  const presented = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : req.headers.get('x-cron-secret');

  let viaCron = false;
  if (presented) {
    const expected = process.env.CRON_SECRET || '';
    if (!expected) {
      return NextResponse.json({ ok: false, error: 'CRON_SECRET is not set on the server. Add it in Netlify and redeploy.' }, { status: 500 });
    }
    if (!secretMatches(presented, expected)) {
      return NextResponse.json({ ok: false, error: 'Invalid cron secret.' }, { status: 401 });
    }
    viaCron = true;
  }

  let workspaceId: string | null = null;
  if (!viaCron) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 });
    const { data: mem } = await supabase.from('workspace_members').select('workspace_id').eq('user_id', user.id).limit(1).maybeSingle();
    workspaceId = mem?.workspace_id ?? null;
    if (!workspaceId) return NextResponse.json({ ok: false, error: 'No workspace.' }, { status: 403 });
  }

  const dryRun = req.nextUrl.searchParams.get('dry') === '1';
  // ?scope=new_leads — first messages and meetings only; skips the sequences
  // and campaigns. Kept for manual use; the schedule runs the full tick.
  const fastLane = req.nextUrl.searchParams.get('scope') === 'new_leads';

  const ctx = createRunContext();
  const admin = createAutomationAdminClient(ctx);
  // Releasing the lock must still work after the run's hard stop has fired.
  const lockAdmin = createAutomationAdminClient();
  if (!admin || !lockAdmin) {
    ctx.dispose();
    return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const sinceIso = new Date(now - RECENT_WINDOW_HOURS * 3_600_000).toISOString();
  const report: Record<string, unknown>[] = [];
  const minute = new Date(now).getMinutes();
  // Enrolling new people into sequences and repairing bounces are not urgent:
  // doing them every 15 min / hourly instead of every run saves most of the
  // database work. A manual run does everything.
  const enrolDue = !viaCron || minute % 15 < 5;
  const repairDue = !viaCron || minute < 5;

  let lockToken: string | null = null;
  try {
    // ==== ROUND 1: the lock, and everything cheap, in parallel ===============
    // Narrow to the caller's workspace for a manual run; the schedule covers all.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scope = <Q,>(q: Q): Q => (workspaceId ? (q as any).eq('workspace_id', workspaceId) : q);

    // The lock runs alongside the reads, but is awaited on its own first so its
    // token is kept — and released — even if one of the reads fails.
    const lockPromise = dryRun ? Promise.resolve({ acquired: true as const, token: '' }) : acquireTickLock(admin);
    const readsPromise = Promise.all([
      scope(admin.from('relay_automations').select('*')
        .in('key', ['new_lead_first', 'meeting_booked', 'meeting_completed']).eq('enabled', true)),
      scope(admin.from('leads')
        .select('id, workspace_id, full_name, phone, visa_type, created_at, is_sample')
        .gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(1000)),
      // Each conversation arrives WITH its first inbound message — the one
      // query that replaces ~92 separate per-conversation lookups.
      scope(admin.from('relay_conversations')
        .select('id, workspace_id, phone_e164, last_inbound_at, lead_id, relay_messages(body, created_at)')
        .gte('last_inbound_at', sinceIso)
        .eq('relay_messages.direction', 'in')
        .order('created_at', { referencedTable: 'relay_messages', ascending: true })
        .limit(1, { referencedTable: 'relay_messages' })
        .order('last_inbound_at', { ascending: false }).limit(1000)),
      scope(admin.from('relay_suppressions').select('workspace_id, phone_e164')),
      scope(admin.from('leads').select('id', { count: 'exact', head: true })),
      fastLane ? Promise.resolve({ data: [] }) :
        admin.from('relay_sequences')
          .select('id, workspace_id, hours_enabled, send_start_hour, send_end_hour, per_hour_cap')
          .eq('status', 'running'),
      fastLane ? Promise.resolve({ data: [] }) :
        admin.from('relay_campaigns').select('id, status, scheduled_at').in('status', ['sending', 'scheduled']),
    ]);
    readsPromise.catch(() => {});   // observed below; never an unhandled rejection

    const lock = await lockPromise;
    if (!lock.acquired) {
      return NextResponse.json({ ok: true, skipped: 'locked', reason: lock.reason, ms: ctx.elapsedMs() });
    }
    lockToken = lock.token || null;
    const [rulesRes, leadsRes, convsRes, suppRes, leadCountRes, seqRes, campRes] = await readsPromise;
    if (rulesRes.error) throw new Error(`rules: ${rulesRes.error.message}`);

    const rules = (rulesRes.data || []) as Record<string, any>[];   // eslint-disable-line @typescript-eslint/no-explicit-any
    const leadRuleByWs = new Map(rules.filter((r) => r.key === 'new_lead_first').map((r) => [r.workspace_id as string, r]));
    const meetingRules = rules.filter((r) => r.key !== 'new_lead_first');

    const recentLeads = (leadsRes.data || []) as (LeadRow & { workspace_id: string })[];
    const recentConvs: (ConvRow & { workspace_id: string })[] = ((convsRes.data || []) as {
      id: string; workspace_id: string; phone_e164: string; last_inbound_at: string; lead_id: string | null;
      relay_messages: { body: string | null }[] | null;
    }[]).map((c) => ({
      id: c.id, workspace_id: c.workspace_id, phone_e164: c.phone_e164,
      last_inbound_at: c.last_inbound_at, lead_id: c.lead_id,
      first_inbound_body: c.relay_messages?.[0]?.body ?? null,
    }));
    const suppressed = (suppRes.data || []) as { workspace_id: string; phone_e164: string }[];
    const convByKey = new Map(recentConvs.map((c) => [`${c.workspace_id}|${c.phone_e164}`, c]));
    if ((leadsRes.data?.length ?? 0) >= 1000 || (convsRes.data?.length ?? 0) >= 1000) {
      report.push({ key: 'new_lead_first', note: `More than 1000 leads or conversations in ${RECENT_WINDOW_HOURS}h — newest 1000 handled first, the rest next run.` });
    }

    // ==== ROUND 2: history for exactly the people in view, in parallel =======
    const leadIds = recentLeads.map((l) => l.id);
    const phones = [...new Set([
      ...recentLeads.map((l) => toE164(l.phone)).filter(Boolean) as string[],
      ...recentConvs.map((c) => c.phone_e164),
    ])];
    // Lead phones are only needed to tell an unlinked stranger's ordinary text
    // from a customer typed in another format — load them only when that
    // question actually arises.
    const needLeadPhones = recentConvs.some((c) => !c.lead_id && !isEnquiry(c.first_inbound_body));
    const leadPages = needLeadPhones ? Math.ceil((leadCountRes.count ?? 0) / 1000) : 0;

    const running = (seqRes.data || []) as {
      id: string; workspace_id: string; hours_enabled: boolean; send_start_hour: number; send_end_hour: number; per_hour_cap: number | null;
    }[];
    const hourStartIso = new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString();
    const hourIst = istHour(new Date(now));
    const inHours = running.filter((s) => !s.hours_enabled || (hourIst >= s.send_start_hour && hourIst < s.send_end_hour));

    const histCols = 'id, workspace_id, lead_id, phone_e164, ok, attempts, sent_at, error';
    const [histParts, leadPhoneParts, seqDue, seqSentThisHour] = await Promise.all([
      Promise.all([
        ...chunk(leadIds, 100).map((ids) => admin.from('relay_automation_sent').select(histCols)
          .eq('automation_key', 'new_lead_first').in('lead_id', ids)),
        ...chunk(phones, 100).map((ps) => admin.from('relay_automation_sent').select(histCols)
          .eq('automation_key', 'new_lead_first').in('phone_e164', ps)),
      ]),
      Promise.all(Array.from({ length: leadPages }, (_, p) =>
        scope(admin.from('leads').select('workspace_id, phone')).order('id').range(p * 1000, p * 1000 + 999))),
      Promise.all(inHours.map((s) => admin.from('relay_lead_sequences').select('id')
        .eq('sequence_id', s.id).eq('status', 'active').lte('next_send_at', nowIso).limit(1))),
      Promise.all(inHours.map((s) => Number(s.per_hour_cap) > 0
        ? admin.from('relay_sequence_sends').select('id', { count: 'exact', head: true })
            .eq('sequence_id', s.id).gte('sent_at', hourStartIso)
        : Promise.resolve({ count: 0 }))),
    ]);

    const historyById = new Map<string, HistoryRow & { workspace_id: string }>();
    for (const part of histParts) {
      if (part.error) throw new Error(`history: ${part.error.message}`);
      for (const h of (part.data || []) as (HistoryRow & { workspace_id: string })[]) historyById.set(h.id, h);
    }
    const knownDigitsByWs = new Map<string, Set<string>>();
    for (const part of leadPhoneParts) {
      for (const l of (part.data || []) as { workspace_id: string; phone: string | null }[]) {
        const d = String(l.phone || '').replace(/\D/g, '');
        if (d.length < 10) continue;
        if (!knownDigitsByWs.has(l.workspace_id)) knownDigitsByWs.set(l.workspace_id, new Set());
        knownDigitsByWs.get(l.workspace_id)!.add(d.slice(-10));
      }
    }

    // ==== 1. FIRST MESSAGES ==================================================
    for (const [ws, rule] of leadRuleByWs) {
      const out: Record<string, unknown> = { workspace: ws, key: rule.key, sent: 0, skipped: [] as string[] };
      report.push(out);
      const skipped = out.skipped as string[];

      if (!rule.activated_at) { out.note = 'Rule has no activation time — switch it off and on once.'; continue; }
      if (!isConfigured() && !dryRun) { out.note = 'INTERAKT_API_KEY is not set.'; continue; }

      const plan = planFirstMessages({
        now,
        rule: { activated_at: rule.activated_at, delay_seconds: rule.delay_seconds },
        leads: recentLeads.filter((l) => l.workspace_id === ws),
        convs: recentConvs.filter((c) => c.workspace_id === ws),
        history: [...historyById.values()].filter((h) => h.workspace_id === ws),
        suppressedPhones: new Set(suppressed.filter((s) => s.workspace_id === ws).map((s) => s.phone_e164)),
        knownLeadDigits: needLeadPhones ? (knownDigitsByWs.get(ws) || new Set()) : new Set(),
      });
      skipped.push(...plan.skipped);

      // Daily cap stays an optional emergency brake: 0 / null = no limit.
      const hardCap = Number(rule.daily_cap) || 0;
      let jobs = plan.jobs;
      if (hardCap > 0 && jobs.length) {
        const { count: sentToday } = await admin.from('relay_automation_sent')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', ws).eq('automation_key', rule.key).eq('ok', true)
          .gte('sent_at', new Date(`${istDate()}T00:00:00+05:30`).toISOString());
        const left = Math.max(0, hardCap - (sentToday ?? 0));
        if (left === 0) { out.note = `Daily cap of ${hardCap} reached.`; continue; }
        jobs = jobs.slice(0, left);
      }

      if (!jobs.length) { out.note = 'No new leads waiting.'; continue; }
      out.waiting = jobs.length;

      if (dryRun) {
        for (const j of jobs) skipped.push(`DRY RUN — would send the first message to ${j.name || j.phoneE164} (${j.phoneE164}, ${j.kind})`);
        continue;
      }

      await forEachLimited(jobs, SEND_CONCURRENCY, () => ctx.hasTime() && ctx.sendsLeft() > 0, async (job) => {
        const outcome = await sendFirstMessage(admin, lockAdmin, ctx, ws, rule, job, convByKey);
        if (outcome === 'sent') out.sent = (out.sent as number) + 1;
        else if (outcome !== 'skip') skipped.push(`${job.name || job.phoneE164}: ${outcome}`);
      });
      const left = jobs.length - (out.sent as number);
      if (left > 0 && !ctx.hasTime()) out.note = `${left} continue on the next run.`;
    }

    // ==== 2. MEETING MESSAGES — PC1 when booked, PC2 when completed ==========
    // Driven by the meetings table, so it fires however a meeting came to
    // exist. One message per meeting per rule (unique index on automation_key,
    // meeting_id), claimed before sending.
    for (const rule of meetingRules) {
      if (!ctx.hasTime()) break;
      const out = await runMeetingRule(admin, ctx, rule, dryRun);
      report.push(out);
    }

    // ==== 3 + 4. SEQUENCES AND CAMPAIGNS =====================================
    let sequences: Awaited<ReturnType<typeof runSequences>> = [];
    let campaigns: Awaited<ReturnType<typeof runCampaigns>> = [];
    if (!dryRun && !fastLane) {
      // Only wake the engine when it has something to do: a sequence with
      // someone due, in sending hours, under its hourly cap — or an enrolment
      // or repair pass is due.
      const busyIds = inHours
        .filter((s, i) => (seqDue[i]?.data?.length ?? 0) > 0 &&
          (!(Number(s.per_hour_cap) > 0) || (seqSentThisHour[i]?.count ?? 0) < Number(s.per_hour_cap)))
        .map((s) => s.id);
      if (running.length && (busyIds.length || enrolDue || repairDue) && ctx.hasTime()) {
        try {
          sequences = await runSequences(admin, ctx, {
            sequenceIds: enrolDue || repairDue ? running.map((s) => s.id) : busyIds,
            enrol: enrolDue,
            repair: repairDue,
          });
        } catch (e) { console.error('[sequences] tick failed', e); }
      }
      const campaignsDue = ((campRes.data || []) as { status: string; scheduled_at: string | null }[])
        .some((c) => c.status === 'sending' || !c.scheduled_at || c.scheduled_at <= nowIso);
      if (campaignsDue && ctx.hasTime()) {
        try { campaigns = await runCampaigns(admin, ctx); }
        catch (e) { console.error('[campaigns] tick failed', e); }
      }
    }

    return NextResponse.json({
      ok: true, dryRun, fastLane,
      ms: ctx.elapsedMs(), sendsUsed: MAX_SENDS_PER_RUN - ctx.sendsLeft(),
      enrolDue, repairDue,
      report, sequences, campaigns,
    });
  } catch (e) {
    const timedOut = isTimeoutError(e);
    console.error('[automation tick] run failed', e);
    return NextResponse.json({
      ok: false,
      error: timedOut ? `A call exceeded its ${CALL_TIMEOUT_MS / 1000}s limit; the next run continues.` : (e instanceof Error ? e.message : String(e)),
      ms: ctx.elapsedMs(), report,
    }, { status: timedOut ? 200 : 500 });
  } finally {
    ctx.dispose();
    if (lockToken) await releaseTickLock(lockAdmin, lockToken).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// One first message: resolve the conversation, claim, send, record.
// Returns 'sent', 'skip' (nothing to do / someone else has it), or a reason.
// ---------------------------------------------------------------------------
async function sendFirstMessage(
  admin: Admin,
  /** Not bound to the run's hard stop: the outcome must be written even if it fires. */
  durable: Admin,
  ctx: RunContext, ws: string,
  rule: Record<string, any>,                                          // eslint-disable-line @typescript-eslint/no-explicit-any
  job: Job,
  convByKey: Map<string, { id: string; last_inbound_at: string }>,
): Promise<string> {
  if (!ctx.takeSend()) return 'skip';
  let spent = false;
  try {
    // ---- which conversation, and is the 24h window open? ------------------
    const recent = convByKey.get(`${ws}|${job.phoneE164}`);
    let conversationId = job.conversationId || recent?.id || null;
    // No inbound in the recent window means the 24h window is closed.
    const lastInbound = recent?.last_inbound_at ?? null;
    if (!conversationId) {
      const { data } = await admin.rpc('relay_get_or_create_conversation', { p_workspace_id: ws, p_phone_e164: job.phoneE164 });
      conversationId = (data as string) || null;
    }
    if (!conversationId) return 'could not open a conversation';

    // ---- a retry after a TIMEOUT: did the first try arrive after all? -----
    // A provider that answers slowly may still have delivered. The webhook
    // stamps our message row when it does, so check before sending again —
    // otherwise the customer gets the message twice.
    if (job.prior?.error?.includes('delivery unknown')) {
      const since = new Date(new Date(job.prior.sent_at).getTime() - 60_000).toISOString();
      const { data: arrived } = await admin.from('relay_messages').select('id')
        .eq('conversation_id', conversationId).eq('direction', 'out')
        .in('status', ['sent', 'delivered', 'read']).gte('created_at', since).limit(1);
      if (arrived?.length) {
        await admin.from('relay_automation_sent').update({ ok: true, error: null }).eq('id', job.prior.id);
        return 'skip';
      }
    }

    const open = windowState(lastInbound).open;
    const method = open ? 'quick_reply' : 'template';
    const detail = open ? rule.quick_reply_shortcut : rule.template_name;

    // ---- claim: the write is the lock ------------------------------------
    // A retry re-arms its own row only while it is still failed; a fresh
    // person gets a new row, and the unique indexes (lead, phone) reject a
    // second claim. Either way only one run can own this person.
    //
    // The claim is written already saying "delivery unknown". If the run is
    // killed between sending and recording, the next attempt therefore checks
    // whether the message actually arrived before sending it again.
    const IN_FLIGHT = `in flight — ${TIMEOUT_NOTE}`;
    let claimId: string | null = null;
    if (job.prior) {
      const { data } = await admin.from('relay_automation_sent')
        .update({ method, detail, ok: false, error: IN_FLIGHT, attempts: (job.prior.attempts ?? 1) + 1, sent_at: new Date().toISOString() })
        .eq('id', job.prior.id).eq('ok', false).select('id');
      claimId = data?.[0]?.id ?? null;
    } else {
      const { data, error } = await admin.from('relay_automation_sent')
        .insert({ workspace_id: ws, automation_key: rule.key, lead_id: job.leadId, phone_e164: job.phoneE164, method, detail, ok: false, error: IN_FLIGHT, attempts: 1 })
        .select('id').single();
      claimId = error ? null : data?.id ?? null;
    }
    if (!claimId) return 'skip';
    spent = true;

    // ---- send ------------------------------------------------------------
    const person = { full_name: job.name, visa_type: job.visaType };
    let ok = false;
    let errText: string | null = null;
    try {
      if (open) {
        const r = await sendQuickReply(admin, ctx, ws, conversationId, job.phoneE164, rule.quick_reply_shortcut, person);
        ok = r.ok;
        errText = r.ok ? null : r.timedOut ? TIMEOUT_NOTE : 'quick reply failed (see message row)';
      } else if (!rule.template_name) {
        errText = 'No template chosen for the closed-window path.';
      } else {
        const r = await sendTemplateToLead(admin, {
          workspaceId: ws, conversationId, phoneE164: job.phoneE164,
          templateName: rule.template_name, language: rule.template_language || 'en', lead: person,
        }, ctx);
        ok = r.ok;
        errText = r.ok ? null : r.timedOut ? TIMEOUT_NOTE : r.error;
      }
    } catch (e) {
      errText = isTimeoutError(e) ? TIMEOUT_NOTE : e instanceof Error ? e.message : String(e);
    }

    // Written on the durable client, so a hard stop that fired mid-send cannot
    // stop the outcome being recorded.
    await durable.from('relay_automation_sent').update({ ok, error: errText }).eq('id', claimId);
    return ok ? 'sent' : errText || 'send failed';
  } finally {
    if (!spent) ctx.giveBackSend();
  }
}

// ---------------------------------------------------------------------------
// Meeting rules — unchanged logic, now inside the run's time and send budget.
// ---------------------------------------------------------------------------
async function runMeetingRule(
  admin: Admin, ctx: RunContext,
  rule: Record<string, any>,                                          // eslint-disable-line @typescript-eslint/no-explicit-any
  dryRun: boolean,
): Promise<Record<string, unknown>> {
  const ws = rule.workspace_id as string;
  const out: Record<string, unknown> = { workspace: ws, key: rule.key, sent: 0, skipped: [] as string[] };
  const skipped = out.skipped as string[];

  if (!rule.activated_at) { out.note = 'Rule has no activation time — switch it off and on once.'; return out; }
  if (!rule.template_name) { out.note = 'No template chosen.'; return out; }
  if (!isConfigured() && !dryRun) { out.note = 'INTERAKT_API_KEY is not set.'; return out; }

  const dayStartIst = new Date(`${istDate()}T00:00:00+05:30`).toISOString();
  const { count: sentToday } = await admin
    .from('relay_automation_sent')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ws).eq('automation_key', rule.key)
    .eq('ok', true).gte('sent_at', dayStartIst);
  let room = Math.max(0, (rule.daily_cap ?? 200) - (sentToday ?? 0));
  if (room === 0) { out.note = `Daily cap of ${rule.daily_cap} reached.`; return out; }

  const cutoff = new Date(Date.now() - (rule.delay_seconds ?? 30) * 1_000).toISOString();
  const booked = rule.key === 'meeting_booked';
  const sortCol = booked ? 'created_at' : 'completed_at';

  // Newest first, in pages, so today's booking is never outside the window.
  const meetings: {
    id: string; lead_id: string | null; client_name: string | null;
    client_email: string | null; client_phone: string | null;
    status: string; starts_at: string; created_at: string; completed_at: string | null;
  }[] = [];
  for (let page = 0; page < 20 && ctx.hasTime(); page++) {
    let q = admin.from('meetings')
      .select('id, lead_id, client_name, client_email, client_phone, status, starts_at, created_at, completed_at')
      .eq('workspace_id', ws);
    q = booked
      ? q.gte('created_at', rule.activated_at).lte('created_at', cutoff).neq('status', 'cancelled')
      : q.eq('status', 'completed').gte('completed_at', rule.activated_at).lte('completed_at', cutoff);
    const { data: pageRows } = await q.order(sortCol, { ascending: false }).range(page * 100, page * 100 + 99);
    if (!pageRows?.length) break;
    meetings.push(...(pageRows as typeof meetings));
    if (pageRows.length < 100) break;
  }
  if (!meetings.length) { out.note = booked ? 'No new bookings waiting.' : 'No newly completed calls waiting.'; return out; }

  // Only the history for THESE meetings — in batches, because up to 2,000 ids
  // in a single request would exceed the URL length limit.
  const [doneParts, { data: supp }] = await Promise.all([
    Promise.all(chunk(meetings.map((m) => m.id), 100).map((ids) =>
      admin.from('relay_automation_sent').select('meeting_id')
        .eq('workspace_id', ws).eq('automation_key', rule.key).in('meeting_id', ids))),
    admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', ws),
  ]);
  const doneMeetings = new Set(doneParts.flatMap((part) => (part.data || []).map((d) => d.meeting_id as string)));
  const stopPhones = new Set((supp || []).map((x) => x.phone_e164 as string));

  for (const m of meetings) {
    if (doneMeetings.has(m.id)) continue;
    if (room <= 0) { skipped.push('daily cap reached mid-run'); break; }
    if (!ctx.hasTime() || ctx.sendsLeft() <= 0) { out.note = 'Continues on the next run.'; break; }
    const who = m.client_name || m.client_email || m.id;

    // A same-day thank-you must not go to a call from weeks ago.
    if (!booked) {
      const startedMs = new Date(m.starts_at).getTime();
      const completedMs = new Date(m.completed_at || m.starts_at).getTime();
      const tooOld = completedMs - startedMs > 3 * 86_400_000;
      const notYet = startedMs > completedMs + 86_400_000;
      if (tooOld || notYet) {
        if (!dryRun) {
          await admin.from('relay_automation_sent').insert({
            workspace_id: ws, automation_key: rule.key, lead_id: m.lead_id, phone_e164: 'n/a',
            meeting_id: m.id, method: 'template', detail: rule.template_name, ok: false,
            error: tooOld ? 'call was more than 3 days before it was marked completed' : 'call is still in the future',
          });
        }
        skipped.push(`${who}: ${tooOld ? 'call too old for a same-day thank-you' : 'call has not happened yet'}`);
        continue;
      }
    }

    // Which number dials: booking form, then linked lead, then lead by email.
    let lead: { id: string; full_name: string | null; phone: string | null; visa_type: string | null } | null = null;
    if (m.lead_id) {
      const { data } = await admin.from('leads').select('id, full_name, phone, visa_type').eq('id', m.lead_id).maybeSingle();
      lead = data;
    }
    if (!lead && m.client_email) {
      const { data } = await admin.from('leads').select('id, full_name, phone, visa_type')
        .eq('workspace_id', ws).ilike('email', m.client_email.trim()).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      lead = data;
    }
    const phoneE164 = toE164(m.client_phone) || (lead ? toE164(lead.phone) : null);

    if (!phoneE164 || stopPhones.has(phoneE164)) {
      if (!dryRun) {
        await admin.from('relay_automation_sent').insert({
          workspace_id: ws, automation_key: rule.key, lead_id: lead?.id ?? m.lead_id ?? null, phone_e164: phoneE164 || 'n/a',
          meeting_id: m.id, method: 'template', detail: rule.template_name, ok: false,
          error: phoneE164 ? 'opted out' : 'no usable phone on the booking or the lead',
        });
      }
      skipped.push(`${who}: ${phoneE164 ? 'opted out' : 'no usable phone number anywhere'}`);
      continue;
    }

    if (dryRun) { skipped.push(`would send ${rule.template_name} to ${who} (${phoneE164})`); room--; continue; }
    if (!ctx.takeSend()) { out.note = 'Continues on the next run.'; break; }

    const { data: claim, error: claimErr } = await admin.from('relay_automation_sent')
      .insert({
        workspace_id: ws, automation_key: rule.key, lead_id: lead?.id ?? m.lead_id ?? null, phone_e164: phoneE164,
        meeting_id: m.id, method: 'template', detail: rule.template_name, ok: false,
      })
      .select('id').maybeSingle();
    if (claimErr || !claim) { ctx.giveBackSend(); continue; }   // another run got here first

    let ok = false; let errText: string | null = null;
    try {
      const { data: convId } = await admin.rpc('relay_get_or_create_conversation', { p_workspace_id: ws, p_phone_e164: phoneE164 });
      if (!convId) throw new Error('could not open a conversation');
      if (lead?.id) {
        await admin.from('relay_conversations').update({ lead_id: lead.id, updated_at: new Date().toISOString() })
          .eq('id', convId as string).is('lead_id', null);
      }
      const r = await sendTemplateToLead(admin, {
        workspaceId: ws, conversationId: convId as string, phoneE164,
        templateName: rule.template_name, language: rule.template_language || 'en',
        lead: { full_name: m.client_name || lead?.full_name || null, visa_type: lead?.visa_type ?? null },
      }, ctx);
      ok = r.ok; errText = r.ok ? null : r.timedOut ? TIMEOUT_NOTE : r.error;
    } catch (e) {
      errText = isTimeoutError(e) ? TIMEOUT_NOTE : e instanceof Error ? e.message : String(e);
    }

    await admin.from('relay_automation_sent').update({ ok, error: errText }).eq('id', claim.id);
    if (ok) { out.sent = (out.sent as number) + 1; room--; }
    else skipped.push(`${who}: ${errText}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The quick reply: text plus any attachments, each a normal message row so it
// appears in the thread exactly like a human send.
// ---------------------------------------------------------------------------
async function sendQuickReply(
  admin: Admin, ctx: RunContext,
  ws: string, conversationId: string, phoneE164: string,
  shortcut: string | null,
  lead: { full_name?: string | null; visa_type?: string | null },
): Promise<{ ok: boolean; timedOut: boolean }> {
  if (!shortcut) return { ok: false, timedOut: false };
  const limits = { timeoutMs: CALL_TIMEOUT_MS, signal: ctx.signal };

  type Qr = { body: string | null; attachments: { path: string; name: string; mime: string; size: number }[] | null } | null;
  const cacheKey = `qr:${ws}:${shortcut}`;
  let qr: Qr;
  if (ctx.cache.has(cacheKey)) qr = ctx.cache.get(cacheKey) as Qr;
  else {
    const { data } = await admin.from('relay_quick_replies').select('body, attachments')
      .eq('workspace_id', ws).eq('shortcut', shortcut).maybeSingle();
    qr = data as Qr;
    ctx.cache.set(cacheKey, qr);
  }
  if (!qr) return { ok: false, timedOut: false };

  let allOk = true;
  let anyTimeout = false;
  // A slow provider may still have delivered: leave the row 'queued' and let
  // the webhook stamp the truth, rather than calling it failed.
  const record = async (id: string, r: { ok: boolean; code?: string; detail?: string; providerMsgId?: string }) => {
    const timedOut = !r.ok && r.code === 'timeout';
    anyTimeout ||= timedOut;
    await admin.from('relay_messages').update({
      status: r.ok ? 'sent' : timedOut ? 'queued' : 'failed',
      provider_msg_id: r.ok ? r.providerMsgId || null : null,
      error_code: r.ok ? null : r.code || 'unknown',
      error_detail: r.ok ? null : (r.detail || '').slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq('id', id);
  };

  const text = personalise(qr.body || '', lead);
  if (text.trim()) {
    const { data: msg } = await admin.from('relay_messages')
      .insert({ workspace_id: ws, conversation_id: conversationId, direction: 'out', body: text, status: 'queued', sent_by: null })
      .select('id').single();
    if (!msg) allOk = false;
    else {
      const r = await sendText({ phoneE164, message: text, callbackData: msg.id, limits });
      await record(msg.id, r);
      allOk &&= r.ok;
    }
  }

  for (const att of qr.attachments || []) {
    const { data: signed } = await admin.storage.from(RELAY_BUCKET).createSignedUrl(att.path, 3600);
    if (!signed?.signedUrl) { allOk = false; continue; }
    const mediaType = mediaTypeFrom(att.mime) || 'document';
    const { data: msg } = await admin.from('relay_messages')
      .insert({
        workspace_id: ws, conversation_id: conversationId, direction: 'out', body: '',
        media_path: att.path, media_name: att.name, media_mime: att.mime, media_size: att.size,
        media_type: mediaType, status: 'queued', sent_by: null,
      }).select('id').single();
    if (!msg) { allOk = false; continue; }
    const r = await sendMedia({
      phoneE164, mediaUrl: signed.signedUrl,
      mediaType: mediaType === 'sticker' ? 'image' : mediaType,
      fileName: att.name, callbackData: msg.id, limits,
    });
    await record(msg.id, r);
    allOk &&= r.ok;
  }
  return { ok: allOk, timedOut: !allOk && anyTimeout };
}
