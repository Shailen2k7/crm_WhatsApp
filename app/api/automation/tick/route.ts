import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { sendTemplateToLead } from '@/lib/send-template';
import { sendText, sendMedia, windowState, isConfigured, mediaTypeFrom } from '@/lib/interakt';
import { toE164 } from '@/lib/phone';
import { RELAY_BUCKET } from '@/lib/files';
import {
  CALL_TIMEOUT_MS, MAX_SENDS_PER_RUN, createAutomationAdminClient, createRunContext, forEachLimited, isTimeoutError,
  type RunContext,
} from '@/lib/automation/run-context';
import { acquireTickLock, releaseTickLock } from '@/lib/automation/lock';
import {
  planFirstMessages, RECENT_WINDOW_HOURS, MAX_ATTEMPTS,
  type HistoryRow, type Job, type LeadRow,
} from '@/lib/automation/first-message';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// =============================================================================
// T1 — THE FIRST MESSAGE TO EVERY NEW LEAD. Nothing else.
//
// On 30 Sep 2026 every automation was removed and the app became a manual
// chat. On 1 Oct exactly ONE came back, at Shailen's request: the first
// message (T1, asking for the CV and LinkedIn) to every fresh lead that enters
// the CRM — the leads the Daily tracker lists. There are no follow-ups
// (T2/T3/T4), no meeting messages, no campaigns, and nothing here can start
// any of them. This route does one thing.
//
// Who gets T1: a lead CREATED after the rule was switched on, within the last
// 72 hours, with a usable phone, not a sample, not opted out (STOP) — and not
// already messaged, by this rule OR by a person on the team.
//
// Called by the Netlify Scheduled Function `automation-tick` every 5 minutes
// with `Authorization: Bearer <CRON_SECRET>`; a signed-in user can also call
// it (add ?dry=1 to see who WOULD be messaged, without sending).
//
// Safety it keeps from the old worker:
//   * a lock — two runs never overlap
//   * every call times out at 5s; nothing new starts after 6s; at most 20 sends
//     per run, the rest continue on the next run
//   * a claim row is written BEFORE sending, and unique indexes (per lead AND
//     per phone) mean nobody can ever get T1 twice
//   * a send that times out is checked for delivery before it is ever retried
// =============================================================================

const IST = 'Asia/Kolkata';
const SEND_CONCURRENCY = 4;
/** Marks a send whose outcome is unknown because the provider did not answer in time. */
const TIMEOUT_NOTE = 'timeout — delivery unknown';
/** Recorded instead of sending when the team has already written to the person. */
const ALREADY_CONTACTED = 'not sent — the team had already messaged this person';

type Admin = SupabaseClient;

function istDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(d); // YYYY-MM-DD
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
  // The schedule presents CRON_SECRET; this check touches no database, so a
  // caller with a wrong secret costs a few milliseconds, not a run.
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

  const ctx = createRunContext();
  const admin = createAutomationAdminClient(ctx);
  // Releasing the lock must still work after the run's hard stop has fired.
  const lockAdmin = createAutomationAdminClient();
  if (!admin || !lockAdmin) {
    ctx.dispose();
    return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });
  }

  const now = Date.now();
  const sinceIso = new Date(now - RECENT_WINDOW_HOURS * 3_600_000).toISOString();
  const report: Record<string, unknown>[] = [];

  let lockToken: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scope = <Q,>(q: Q): Q => (workspaceId ? (q as any).eq('workspace_id', workspaceId) : q);

    // ---- round 1: the lock, the rule, recent leads, opt-outs — in parallel ---
    const lockPromise = dryRun ? Promise.resolve({ acquired: true as const, token: '' }) : acquireTickLock(admin);
    const readsPromise = Promise.all([
      scope(admin.from('relay_automations').select('*').eq('key', 'new_lead_first').eq('enabled', true)),
      scope(admin.from('leads')
        .select('id, workspace_id, full_name, phone, visa_type, created_at, is_sample')
        .gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(1000)),
      scope(admin.from('relay_suppressions').select('workspace_id, phone_e164')),
    ]);
    readsPromise.catch(() => {});   // observed below; never an unhandled rejection

    const lock = await lockPromise;
    if (!lock.acquired) {
      return NextResponse.json({ ok: true, skipped: 'locked', reason: lock.reason, ms: ctx.elapsedMs() });
    }
    lockToken = lock.token || null;
    const [rulesRes, leadsRes, suppRes] = await readsPromise;
    if (rulesRes.error) throw new Error(`rule: ${rulesRes.error.message}`);

    const rules = (rulesRes.data || []) as Record<string, any>[];   // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!rules.length) {
      return NextResponse.json({ ok: true, note: 'The T1 rule is switched off — nothing to do.', ms: ctx.elapsedMs() });
    }
    const recentLeads = (leadsRes.data || []) as (LeadRow & { workspace_id: string })[];
    const suppressed = (suppRes.data || []) as { workspace_id: string; phone_e164: string }[];

    // ---- round 2: T1 history for exactly these people -----------------------
    const leadIds = recentLeads.map((l) => l.id);
    const phones = [...new Set(recentLeads.map((l) => toE164(l.phone)).filter(Boolean) as string[])];
    const histCols = 'id, workspace_id, lead_id, phone_e164, ok, attempts, sent_at, error';
    const histParts = await Promise.all([
      ...chunk(leadIds, 100).map((ids) => admin.from('relay_automation_sent').select(histCols)
        .eq('automation_key', 'new_lead_first').in('lead_id', ids)),
      ...chunk(phones, 100).map((ps) => admin.from('relay_automation_sent').select(histCols)
        .eq('automation_key', 'new_lead_first').in('phone_e164', ps)),
    ]);
    const historyById = new Map<string, HistoryRow & { workspace_id: string }>();
    for (const part of histParts) {
      if (part.error) throw new Error(`history: ${part.error.message}`);
      for (const h of (part.data || []) as (HistoryRow & { workspace_id: string })[]) historyById.set(h.id, h);
    }

    for (const rule of rules) {
      const ws = rule.workspace_id as string;
      const out: Record<string, unknown> = { workspace: ws, key: rule.key, sent: 0, skipped: [] as string[] };
      report.push(out);
      const skipped = out.skipped as string[];

      if (!rule.activated_at) { out.note = 'Rule has no activation time — switch it off and on once.'; continue; }
      if (!isConfigured() && !dryRun) { out.note = 'INTERAKT_API_KEY is not set.'; continue; }

      // Leads only. People who WhatsApp us from a number with no lead are left
      // to the team — this rule is for leads in the CRM and nothing else, so
      // no conversations are passed to the planner.
      const plan = planFirstMessages({
        now,
        rule: { activated_at: rule.activated_at, delay_seconds: rule.delay_seconds },
        leads: recentLeads.filter((l) => l.workspace_id === ws),
        convs: [],
        history: [...historyById.values()].filter((h) => h.workspace_id === ws),
        suppressedPhones: new Set(suppressed.filter((s) => s.workspace_id === ws).map((s) => s.phone_e164)),
        knownLeadDigits: new Set(),
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

      // ---- the conversation for each person, and has the team already written?
      const jobPhones = jobs.map((j) => j.phoneE164);
      const convs: { id: string; phone_e164: string; last_inbound_at: string | null }[] = [];
      for (const ps of chunk(jobPhones, 100)) {
        const { data } = await admin.from('relay_conversations').select('id, phone_e164, last_inbound_at')
          .eq('workspace_id', ws).in('phone_e164', ps);
        convs.push(...((data || []) as typeof convs));
      }
      const convByPhone = new Map(convs.map((c) => [c.phone_e164, c]));
      const contacted = new Set<string>();
      for (const ids of chunk(convs.map((c) => c.id), 100)) {
        // A failed attempt is not contact; anything that went (or may have) is.
        const { data } = await admin.from('relay_messages').select('conversation_id')
          .in('conversation_id', ids).eq('direction', 'out').eq('is_internal', false).neq('status', 'failed');
        for (const m of (data || []) as { conversation_id: string }[]) contacted.add(m.conversation_id);
      }

      // Someone the team has already written to by hand gets no T1 — a canned
      // "please send your CV" after a real conversation reads as a robot. They
      // are recorded as settled (never retried), with the reason on the row.
      const fresh: Job[] = [];
      for (const j of jobs) {
        const conv = convByPhone.get(j.phoneE164);
        if (!j.prior && conv && contacted.has(conv.id)) {
          skipped.push(`${j.name || j.phoneE164}: already messaged by the team`);
          if (!dryRun) {
            await admin.from('relay_automation_sent').insert({
              workspace_id: ws, automation_key: rule.key, lead_id: j.leadId, phone_e164: j.phoneE164,
              method: 'skipped', ok: false, error: ALREADY_CONTACTED, attempts: MAX_ATTEMPTS,
            });
          }
          continue;
        }
        fresh.push(j);
      }
      jobs = fresh;
      if (!jobs.length) { out.note = 'No new leads waiting.'; continue; }
      out.waiting = jobs.length;

      if (dryRun) {
        for (const j of jobs) skipped.push(`DRY RUN — would send T1 to ${j.name || j.phoneE164} (${j.phoneE164})`);
        continue;
      }

      await forEachLimited(jobs, SEND_CONCURRENCY, () => ctx.hasTime() && ctx.sendsLeft() > 0, async (job) => {
        const outcome = await sendFirstMessage(admin, lockAdmin, ctx, ws, rule, job, convByPhone.get(job.phoneE164) ?? null);
        if (outcome === 'sent') out.sent = (out.sent as number) + 1;
        else if (outcome !== 'skip') skipped.push(`${job.name || job.phoneE164}: ${outcome}`);
      });
      const left = jobs.length - (out.sent as number);
      if (left > 0 && !ctx.hasTime()) out.note = `${left} continue on the next run.`;
    }

    return NextResponse.json({
      ok: true, dryRun,
      ms: ctx.elapsedMs(), sendsUsed: MAX_SENDS_PER_RUN - ctx.sendsLeft(),
      report,
    });
  } catch (e) {
    const timedOut = isTimeoutError(e);
    console.error('[t1] run failed', e);
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
  conv: { id: string; last_inbound_at: string | null } | null,
): Promise<string> {
  if (!ctx.takeSend()) return 'skip';
  let spent = false;
  try {
    // ---- which conversation, and is the 24h window open? ------------------
    let conversationId = conv?.id ?? null;
    const lastInbound = conv?.last_inbound_at ?? null;
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

    // If they have written to us in the last 24h, WhatsApp allows a free-text
    // message, so the "newlead" quick reply goes; otherwise the approved t1
    // template — the only thing WhatsApp permits to a person who has not
    // written first.
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
