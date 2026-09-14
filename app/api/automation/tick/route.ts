import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendTemplateToLead } from '@/lib/send-template';
import { sendText, sendTemplate, sendMedia, windowState, isConfigured, mediaTypeFrom } from '@/lib/interakt';
import { toE164 } from '@/lib/phone';
import { runSequences } from '@/lib/sequence-engine';
import { runCampaigns } from '@/lib/campaign-engine';
import { RELAY_BUCKET } from '@/lib/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// =============================================================================
// AUTOMATION TICK — the worker behind the workflow module.
//
// Called two ways, both idempotent:
//   * pg_cron every 2 minutes (header  x-cron-secret: AUTOMATION_CRON_SECRET)
//   * the Automation panel's "Run now" / dry-run button (signed-in user)
//
// Rule 'new_lead_first': every NEW lead (created after the rule was switched
// on) gets exactly one first message asking for CV + LinkedIn.
//   window OPEN  -> the quick reply (free-form, with attachments if any)
//   window CLOSED-> the approved template
//
// A lead is only ever messaged ONCE by this rule — enforced by two unique
// indexes (per lead id AND per phone), so even duplicate CRM rows for the
// same person cannot cause a second send.
// =============================================================================

const IST = 'Asia/Kolkata';

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
/**
 * The Meta lead form arrives as a message that spells the name out. When the
 * number is not in the CRM that line is all we have to greet them by.
 */
function nameFromEnquiry(body: string | null | undefined): string | null {
  const m = (body || '').match(/full\s*name\s*:\s*(.+)/i);
  const n = m?.[1]?.split('\n')[0]?.trim();
  return n || null;
}
/** {{name}} / {{first_name}} / {{visa}} tokens in quick-reply bodies. */
function personalise(body: string, lead: { full_name?: string | null; visa_type?: string | null }): string {
  return body
    .replace(/\{\{\s*(?:name|first_name|firstname)\s*\}\}/gi, firstNameOf(lead.full_name))
    .replace(/\{\{\s*visa\s*\}\}/gi, visaLabelOf(lead.visa_type));
}

export async function POST(req: NextRequest) {
  // ---- who is calling? -----------------------------------------------------
  const cronSecret = process.env.AUTOMATION_CRON_SECRET || '';
  const viaCron = !!cronSecret && req.headers.get('x-cron-secret') === cronSecret;

  // A caller that PRESENTED a cron secret but failed the check must be told
  // exactly why, or a missing environment variable looks identical to a
  // logged-out browser and the automation dies silently every 2 minutes.
  const presented = req.headers.get('x-cron-secret');
  if (presented && !viaCron) {
    return NextResponse.json({
      ok: false,
      error: cronSecret
        ? 'The x-cron-secret header does not match AUTOMATION_CRON_SECRET on the server.'
        : 'AUTOMATION_CRON_SECRET is not set on the server. Add it in Netlify and redeploy.',
    }, { status: 401 });
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

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  const dryRun = req.nextUrl.searchParams.get('dry') === '1';

  // ?scope=new_leads — the fast lane. A new enquiry must be answered in
  // seconds, but the C1–C8 chase and the campaigns are hourly-paced work that
  // would be wasteful to repeat every few seconds. A second cron job hits this
  // scope on a short interval and skips straight past them.
  const fastLane = req.nextUrl.searchParams.get('scope') === 'new_leads';

  // ---- the rule ------------------------------------------------------------
  let q = admin.from('relay_automations').select('*').eq('key', 'new_lead_first').eq('enabled', true);
  if (workspaceId) q = q.eq('workspace_id', workspaceId);
  const { data: rules, error: ruleErr } = await q;
  if (ruleErr) return NextResponse.json({ ok: false, error: ruleErr.message }, { status: 500 });
  // The new-lead rule being off no longer ends the tick: the meeting rules
  // below and the sequence engine still need their turn.

  const report: Record<string, unknown>[] = [];

  for (const rule of rules) {
    const ws = rule.workspace_id as string;
    const out: Record<string, unknown> = { workspace: ws, key: rule.key, sent: 0, skipped: [] as string[] };
    report.push(out);

    if (!rule.activated_at) { out.note = 'Rule has no activation time — switch it off and on once.'; continue; }
    if (!isConfigured() && !dryRun) { out.note = 'INTERAKT_API_KEY is not set.'; continue; }

    // ---- how many may go out on this pass ----------------------------------
    // Every fresh lead gets answered, full stop — this is not the backlog
    // chase and it has no daily quota. The only ceiling is how many sends fit
    // in one serverless invocation; the tick runs every 2 minutes, so a
    // backlog drains within minutes rather than being dropped.
    //
    // daily_cap stays honoured when it is deliberately set above zero, as an
    // emergency brake. Null or 0 means what it says: no limit.
    const BATCH_PER_TICK = 25;
    let room = BATCH_PER_TICK;
    const hardCap = Number(rule.daily_cap) || 0;
    if (hardCap > 0) {
      const dayStartIst = new Date(`${istDate()}T00:00:00+05:30`).toISOString();
      const { count: sentToday } = await admin
        .from('relay_automation_sent')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', ws).eq('automation_key', rule.key)
        .eq('ok', true).gte('sent_at', dayStartIst);
      const left = Math.max(0, hardCap - (sentToday ?? 0));
      if (left === 0) { out.note = `Daily cap of ${hardCap} reached.`; continue; }
      room = Math.min(room, left);
    }

    // ---- already handled / suppressed --------------------------------------
    // "Handled" means the message actually went, or we have tried enough times.
    // A rejected send left on this list is a person who silently never hears
    // from us, so those rows come back as retries instead.
    const MAX_ATTEMPTS = 3;
    const [{ data: done }, { data: suppressed }] = await Promise.all([
      admin.from('relay_automation_sent')
        .select('id, lead_id, phone_e164, ok, attempts, sent_at').eq('workspace_id', ws).eq('automation_key', rule.key),
      admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', ws),
    ]);
    // A retry must WAIT. When 65 backlogged leads went out at once on 13 Sep
    // the provider rate-limited the burst, and because a failed row was
    // re-armed on the very next tick all three attempts were spent inside
    // thirty seconds — against the same closed door. 31 people were written
    // off for a problem that had cleared minutes later. So each attempt now
    // stands off longer than the last.
    const RETRY_BACKOFF_MS = [0, 15 * 60_000, 2 * 3_600_000];   // after attempt 1, 2, 3
    const retryDue = (d: { attempts?: number; sent_at?: string }) => {
      const waited = Date.now() - new Date(d.sent_at || 0).getTime();
      return waited >= (RETRY_BACKOFF_MS[Math.min(d.attempts ?? 1, RETRY_BACKOFF_MS.length) - 1] ?? 0);
    };
    // "Leave alone" = delivered, out of attempts, OR still cooling off between
    // attempts. Without the last one the lead looks untouched and gets claimed
    // again immediately, which is the very hammering this backoff prevents.
    const settled = (done || []).filter((d) => d.ok || (d.attempts ?? 1) >= MAX_ATTEMPTS || !retryDue(d));
    const doneLeads = new Set(settled.map((d) => d.lead_id).filter(Boolean));
    const donePhones = new Set(settled.map((d) => d.phone_e164));
    const stopPhones = new Set((suppressed || []).map((s) => s.phone_e164));

    const retryable = (done || [])
      .filter((d) => !d.ok && (d.attempts ?? 1) < MAX_ATTEMPTS && retryDue(d));
    const retryByLead = new Map(retryable.filter((d) => d.lead_id).map((d) => [d.lead_id as string, d]));
    const retryByPhone = new Map(retryable.map((d) => [d.phone_e164 as string, d]));

    /**
     * Take ownership of one person's first message.
     *
     * A fresh person gets a new row; someone whose earlier attempt failed has
     * theirs re-armed. Either way the write is the lock: the `ok = false`
     * condition means a parallel tick that got there first wins and this one
     * steps away, exactly as the unique indexes do for the insert.
     */
    const claimSend = async (
      leadId: string | null, phone: string, method: string, detail: string | null,
    ): Promise<string | null> => {
      const prior = (leadId && retryByLead.get(leadId)) || retryByPhone.get(phone);
      if (prior) {
        const { data } = await admin.from('relay_automation_sent')
          .update({
            method, detail, ok: false, error: null,
            attempts: (prior.attempts ?? 1) + 1, sent_at: new Date().toISOString(),
          })
          .eq('id', prior.id).eq('ok', false).select('id');
        return data?.[0]?.id ?? null;
      }
      const { data, error } = await admin.from('relay_automation_sent')
        .insert({ workspace_id: ws, automation_key: rule.key, lead_id: leadId, phone_e164: phone, method, detail, ok: false, attempts: 1 })
        .select('id').single();
      return error ? null : data?.id ?? null;
    };

    // ---- eligible leads: created after activation, older than the delay ----
    // NEWEST FIRST. Someone filling the form right now is the whole point of
    // this rule, so they are answered on this pass and never queue behind a
    // backlog. Reading newest-first also means the unanswered leads are on the
    // first page, so a pass normally costs one query.
    //
    // This is deliberately NOT the oldest-first walk the C1–C8 chase uses:
    // that rationing exists to work through a cold database at a safe rate.
    // Here there is nothing to ration — every fresh lead gets its message.
    const cutoff = new Date(Date.now() - (rule.delay_seconds ?? 60) * 1_000).toISOString();
    const LEAD_PAGE = 200;
    const LEAD_MAX_PAGES = 50;   // 10,000 leads deep, so a backlog is reachable
    const candidates: { id: string; full_name: string | null; phone: string | null; visa_type: string | null }[] = [];

    for (let page = 0; candidates.length < room && page < LEAD_MAX_PAGES; page++) {
      const { data: leads } = await admin
        .from('leads')
        .select('id, full_name, phone, visa_type, created_at, is_sample')
        .eq('workspace_id', ws)
        .gte('created_at', rule.activated_at)
        .lte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .range(page * LEAD_PAGE, page * LEAD_PAGE + LEAD_PAGE - 1);
      if (!leads?.length) break;

      for (const l of leads) {
        if (candidates.length >= room) break;
        if (l.is_sample || !(l.phone || '').trim()) continue;
        if (doneLeads.has(l.id)) continue;
        candidates.push(l);
      }
      if (leads.length < LEAD_PAGE) break;   // that was the last page
    }

    if (!candidates.length) { out.note = 'No new leads waiting.'; continue; }
    // Oldest of the batch goes out first, so a queue still clears in order.
    candidates.reverse();

    for (const lead of candidates) {
      if ((out.sent as number) >= room) { (out.skipped as string[]).push('daily cap reached mid-run'); break; }

      const phoneE164 = toE164(lead.phone);
      if (!phoneE164) { (out.skipped as string[]).push(`${lead.full_name}: unusable phone`); continue; }
      if (doneLeads.has(lead.id) || donePhones.has(phoneE164)) continue;   // dedup
      if (stopPhones.has(phoneE164)) { (out.skipped as string[]).push(`${lead.full_name}: opted out (STOP)`); continue; }

      // ---- window open or closed? ------------------------------------------
      const { data: convId } = await admin.rpc('relay_get_or_create_conversation', { p_workspace_id: ws, p_phone_e164: phoneE164 });
      const { data: conv } = await admin.from('relay_conversations').select('id, last_inbound_at').eq('id', convId as string).maybeSingle();
      const win = windowState(conv?.last_inbound_at);
      const method = win.open ? 'quick_reply' : 'template';
      const detail = win.open ? rule.quick_reply_shortcut : rule.template_name;

      if (dryRun) {
        (out.skipped as string[]).push(`DRY RUN — would send ${method} "${detail}" to ${lead.full_name} (${phoneE164})`);
        continue;
      }

      const claimId = await claimSend(lead.id, phoneE164, method, detail);
      if (!claimId) continue; // someone else claimed it

      let ok = false; let errText: string | null = null;

      try {
        if (win.open) {
          ok = await sendQuickReply(admin, ws, conv!.id, phoneE164, rule.quick_reply_shortcut, lead);
          if (!ok) errText = 'quick reply failed (see message row)';
        } else {
          const r = await sendFirstTemplate(admin, ws, conv!.id, phoneE164, rule.template_name, rule.template_language || 'en', lead);
          ok = r.ok; errText = r.error;
        }
      } catch (e) {
        errText = e instanceof Error ? e.message : String(e);
      }

      await admin.from('relay_automation_sent').update({ ok, error: errText }).eq('id', claimId);
      if (ok) out.sent = (out.sent as number) + 1;
      else (out.skipped as string[]).push(`${lead.full_name}: ${errText}`);
    }

    // ---- people who message us from a number that is not in the CRM -------
    // They fill the form with one number and then WhatsApp from another. The
    // reply belongs on the number they actually used, so an unknown inbound
    // gets the same first message without waiting for a lead record.
    //
    // NEWEST FIRST, in pages — the third home of the fixed-window bug. This
    // used to read the OLDEST 100 conversations since activation; once more
    // than 100 people had ever written in, a brand-new enquiry sat beyond the
    // window and was never even looked at. Newest-first puts tonight's
    // enquiry on page one; the pages behind it are walked for stragglers.
    const inbound: { id: string; phone_e164: string; last_inbound_at: string }[] = [];
    for (let page = 0; page < 20; page++) {
      const { data: convPage } = await admin
        .from('relay_conversations')
        .select('id, phone_e164, last_inbound_at')
        .eq('workspace_id', ws)
        .not('last_inbound_at', 'is', null)
        .gte('last_inbound_at', rule.activated_at)
        .lte('last_inbound_at', cutoff)
        .order('last_inbound_at', { ascending: false })
        .range(page * 100, page * 100 + 99);
      if (!convPage?.length) break;
      inbound.push(...(convPage as typeof inbound));
      if (convPage.length < 100) break;
    }

    // Lead phones are stored however they arrived — "+91 98108 27787",
    // "9810827787", "+919810827787" — so "is this number in the CRM?" can only
    // be answered on digits. A LIKE against the raw column silently misses the
    // spaced ones and would message people who are already customers.
    const knownDigits = new Set<string>();
    if ((inbound || []).length) {
      for (let page = 0; page < 10; page++) {
        const { data: phones } = await admin
          .from('leads').select('phone').eq('workspace_id', ws)
          .range(page * 1000, page * 1000 + 999);
        if (!phones?.length) break;
        for (const p of phones) {
          const d = String(p.phone || '').replace(/\D/g, '');
          if (d.length >= 10) knownDigits.add(d.slice(-10));
        }
        if (phones.length < 1000) break;
      }
    }

    for (const conv of inbound || []) {
      if ((out.sent as number) >= room) { (out.skipped as string[]).push('daily cap reached mid-run'); break; }
      const phoneE164 = conv.phone_e164 as string;
      if (!phoneE164 || donePhones.has(phoneE164) || stopPhones.has(phoneE164)) continue;

      const { data: firstMsg } = await admin
        .from('relay_messages')
        .select('body').eq('conversation_id', conv.id).eq('direction', 'in')
        .order('created_at', { ascending: true }).limit(1).maybeSingle();

      // The MESSAGE decides, not the CRM. A form enquiry gets the first
      // message on the number it came from, full stop — even if some lead row
      // with another number, from another year, happens to exist. The only
      // people the lead-exists check may hold back are old contacts writing
      // ordinary texts, who belong to the sequences, not to this rule.
      const isEnquiry =
        /filled\s+(in|out)\s+your\s+form/i.test(firstMsg?.body || '') ||
        /full\s*name\s*:/i.test(firstMsg?.body || '');
      if (!isEnquiry && knownDigits.has(phoneE164.replace(/\D/g, '').slice(-10))) continue;

      // Greet them by the name in their enquiry when it carries one.
      const stranger = { full_name: nameFromEnquiry(firstMsg?.body), visa_type: null };

      if (dryRun) {
        (out.skipped as string[]).push(`DRY RUN — would send the first message to ${phoneE164} (not in CRM)`);
        continue;
      }

      // Which form may this message legally take? The same question the pass
      // above asks. Assuming the window is open because they wrote to us at
      // some point is wrong the moment this rule runs late or catches up on a
      // backlog: WhatsApp rejects the free-form send and the person gets
      // nothing at all.
      const strangerWin = windowState(conv.last_inbound_at);
      const strangerMethod = strangerWin.open ? 'quick_reply' : 'template';

      const claimId = await claimSend(
        null, phoneE164, strangerMethod,
        strangerWin.open ? rule.quick_reply_shortcut : rule.template_name);
      if (!claimId) continue;   // another tick got there first

      let ok = false; let errText: string | null = null;
      try {
        if (strangerWin.open) {
          ok = await sendQuickReply(admin, ws, conv.id, phoneE164, rule.quick_reply_shortcut, stranger);
          if (!ok) errText = 'quick reply failed (see message row)';
        } else {
          const r = await sendFirstTemplate(admin, ws, conv.id, phoneE164, rule.template_name, rule.template_language || 'en', stranger);
          ok = r.ok; errText = r.error;
        }
      } catch (e) {
        errText = e instanceof Error ? e.message : String(e);
      }

      await admin.from('relay_automation_sent').update({ ok, error: errText }).eq('id', claimId);
      if (ok) { out.sent = (out.sent as number) + 1; donePhones.add(phoneE164); }
      else (out.skipped as string[]).push(`${phoneE164}: ${errText}`);
    }
  }

  // ==========================================================================
  // MEETING MESSAGES — PC1 when a call is booked, PC2 when it is completed.
  // --------------------------------------------------------------------------
  // Driven by the meetings table, not by the CRM UI, so it fires however a
  // meeting came to exist or be completed: the public booking page, a staff
  // booking, the drawer, a bulk edit. The CRM does not need to know this code
  // exists.
  //
  // PHONE RESOLUTION, in order — "ensure you send WhatsApp to everyone":
  //   1. the number typed on the booking form (client_phone), if it dials
  //   2. the linked lead's number (lead_id)
  //   3. a lead found by the booking email, then that lead's number
  // Only when all three fail is the meeting recorded as unreachable, by name,
  // so it shows up on the Meetings tab instead of silently not happening.
  //
  // One message per meeting per rule, enforced by a unique index on
  // (automation_key, meeting_id). The claim row is written BEFORE the send, so
  // two overlapping ticks cannot both message the same person.
  // ==========================================================================
  {
    let mq = admin.from('relay_automations').select('*')
      .in('key', ['meeting_booked', 'meeting_completed']).eq('enabled', true);
    if (workspaceId) mq = mq.eq('workspace_id', workspaceId);
    const { data: meetingRules } = await mq;

    for (const rule of meetingRules || []) {
      const ws = rule.workspace_id as string;
      const out: Record<string, unknown> = { workspace: ws, key: rule.key, sent: 0, skipped: [] as string[] };
      report.push(out);

      if (!rule.activated_at) { out.note = 'Rule has no activation time — switch it off and on once.'; continue; }
      if (!rule.template_name) { out.note = 'No template chosen.'; continue; }
      if (!isConfigured() && !dryRun) { out.note = 'INTERAKT_API_KEY is not set.'; continue; }

      const dayStartIst = new Date(`${istDate()}T00:00:00+05:30`).toISOString();
      const { count: sentToday } = await admin
        .from('relay_automation_sent')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', ws).eq('automation_key', rule.key)
        .eq('ok', true).gte('sent_at', dayStartIst);
      let room = Math.max(0, (rule.daily_cap ?? 200) - (sentToday ?? 0));
      if (room === 0) { out.note = `Daily cap of ${rule.daily_cap} reached.`; continue; }

      const cutoff = new Date(Date.now() - (rule.delay_seconds ?? 30) * 1_000).toISOString();
      const booked = rule.key === 'meeting_booked';

      let q = admin.from('meetings')
        .select('id, lead_id, client_name, client_email, client_phone, status, starts_at, created_at, completed_at')
        .eq('workspace_id', ws);
      q = booked
        ? q.gte('created_at', rule.activated_at).lte('created_at', cutoff).neq('status', 'cancelled')
            .order('created_at', { ascending: true })
        : q.eq('status', 'completed').gte('completed_at', rule.activated_at).lte('completed_at', cutoff)
            .order('completed_at', { ascending: true });
      const { data: meetings } = await q.limit(100);
      if (!meetings?.length) { out.note = booked ? 'No new bookings waiting.' : 'No newly completed calls waiting.'; continue; }

      const [{ data: done }, { data: suppressed }] = await Promise.all([
        admin.from('relay_automation_sent').select('meeting_id')
          .eq('workspace_id', ws).eq('automation_key', rule.key).not('meeting_id', 'is', null),
        admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', ws),
      ]);
      const doneMeetings = new Set((done || []).map((d) => d.meeting_id as string));
      const stopPhones = new Set((suppressed || []).map((x) => x.phone_e164 as string));

      for (const m of meetings) {
        if (doneMeetings.has(m.id)) continue;
        if (room <= 0) { (out.skipped as string[]).push('daily cap reached mid-run'); break; }
        const who = m.client_name || m.client_email || m.id;

        // A thank-you that says "today" must not go to someone whose call was
        // three weeks ago and got marked completed during a tidy-up.
        if (!booked) {
          const startedMs = new Date(m.starts_at).getTime();
          const completedMs = new Date(m.completed_at).getTime();
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
            (out.skipped as string[]).push(`${who}: ${tooOld ? 'call too old for a same-day thank-you' : 'call has not happened yet'}`);
            continue;
          }
        }

        // ---- who are they, and which number actually dials? ----------------
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

        if (!phoneE164) {
          if (!dryRun) {
            await admin.from('relay_automation_sent').insert({
              workspace_id: ws, automation_key: rule.key, lead_id: lead?.id ?? m.lead_id ?? null, phone_e164: 'n/a',
              meeting_id: m.id, method: 'template', detail: rule.template_name, ok: false,
              error: 'no usable phone on the booking or the lead',
            });
          }
          (out.skipped as string[]).push(`${who}: no usable phone number anywhere`);
          continue;
        }
        if (stopPhones.has(phoneE164)) {
          if (!dryRun) {
            await admin.from('relay_automation_sent').insert({
              workspace_id: ws, automation_key: rule.key, lead_id: lead?.id ?? m.lead_id ?? null, phone_e164: phoneE164,
              meeting_id: m.id, method: 'template', detail: rule.template_name, ok: false, error: 'opted out',
            });
          }
          (out.skipped as string[]).push(`${who}: opted out`);
          continue;
        }

        if (dryRun) {
          (out.skipped as string[]).push(`would send ${rule.template_name} to ${who} (${phoneE164})`);
          room--;
          continue;
        }

        // ---- claim first, send second -------------------------------------
        const { data: claim, error: claimErr } = await admin.from('relay_automation_sent')
          .insert({
            workspace_id: ws, automation_key: rule.key, lead_id: lead?.id ?? m.lead_id ?? null, phone_e164: phoneE164,
            meeting_id: m.id, method: 'template', detail: rule.template_name, ok: false,
          })
          .select('id').maybeSingle();
        if (claimErr || !claim) continue;   // another tick got here first

        let ok = false; let errText: string | null = null;
        try {
          const { data: convId } = await admin.rpc('relay_get_or_create_conversation', {
            p_workspace_id: ws, p_phone_e164: phoneE164,
          });
          if (!convId) throw new Error('could not open a conversation');
          // The booking form's name is what they typed to us; that is the
          // name the message should use.
          if (lead?.id) {
            await admin.from('relay_conversations').update({ lead_id: lead.id, updated_at: new Date().toISOString() })
              .eq('id', convId as string).is('lead_id', null);
          }
          const r = await sendTemplateToLead(admin, {
            workspaceId: ws, conversationId: convId as string, phoneE164,
            templateName: rule.template_name, language: rule.template_language || 'en',
            lead: { full_name: m.client_name || lead?.full_name || null, visa_type: lead?.visa_type ?? null },
          });
          ok = r.ok; errText = r.error;
        } catch (e) {
          errText = e instanceof Error ? e.message : String(e);
        }

        await admin.from('relay_automation_sent').update({ ok, error: errText }).eq('id', claim.id);
        if (ok) { out.sent = (out.sent as number) + 1; room--; }
        else (out.skipped as string[]).push(`${who}: ${errText}`);
      }
    }
  }

  // The C1–C8 follow-up machine rides the same tick. Dry runs skip it —
  // its own page has live counters, and a dry run must never send.
  let sequences: Awaited<ReturnType<typeof runSequences>> = [];
  let campaigns: Awaited<ReturnType<typeof runCampaigns>> = [];
  if (!dryRun && !fastLane) {
    try { sequences = await runSequences(admin); }
    catch (e) { console.error('[sequences] tick failed', e); }
    // One-time blasts ride the same tick, in their own try so a bad campaign
    // can never stop the follow-up machine.
    try { campaigns = await runCampaigns(admin); }
    catch (e) { console.error('[campaigns] tick failed', e); }
  }

  return NextResponse.json({ ok: true, dryRun, fastLane, report, sequences, campaigns });
}

// ---------------------------------------------------------------------------
// The two send paths. Both write normal relay_messages rows, so the sends
// appear in the chat thread exactly like a human send (ticks, retries, all).
// ---------------------------------------------------------------------------

async function sendQuickReply(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  ws: string, conversationId: string, phoneE164: string,
  shortcut: string | null,
  lead: { full_name?: string | null; visa_type?: string | null },
): Promise<boolean> {
  if (!shortcut) return false;
  const { data: qr } = await admin
    .from('relay_quick_replies')
    .select('body, attachments')
    .eq('workspace_id', ws).eq('shortcut', shortcut).maybeSingle();
  if (!qr) return false;

  const text = personalise(qr.body || '', lead);
  let allOk = true;

  if (text.trim()) {
    const { data: msg } = await admin.from('relay_messages')
      .insert({ workspace_id: ws, conversation_id: conversationId, direction: 'out', body: text, status: 'queued', sent_by: null })
      .select('id').single();
    const r = msg ? await sendText({ phoneE164, message: text, callbackData: msg.id }) : { ok: false, detail: 'insert failed', code: 'db' };
    if (msg) await admin.from('relay_messages').update({
      status: r.ok ? 'sent' : 'failed', provider_msg_id: r.ok ? r.providerMsgId || null : null,
      error_code: r.ok ? null : r.code || 'unknown', error_detail: r.ok ? null : (r.detail || '').slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq('id', msg.id);
    allOk = allOk && !!msg && r.ok;
  }

  for (const att of (qr.attachments || []) as { path: string; name: string; mime: string; size: number }[]) {
    const { data: signed } = await admin.storage.from(RELAY_BUCKET).createSignedUrl(att.path, 3600);
    if (!signed?.signedUrl) { allOk = false; continue; }
    const mediaType = mediaTypeFrom(att.mime) || 'document';
    const { data: msg } = await admin.from('relay_messages')
      .insert({
        workspace_id: ws, conversation_id: conversationId, direction: 'out', body: '',
        media_path: att.path, media_name: att.name, media_mime: att.mime, media_size: att.size,
        media_type: mediaType, status: 'queued', sent_by: null,
      }).select('id').single();
    const r = msg ? await sendMedia({
      phoneE164, mediaUrl: signed.signedUrl,
      mediaType: mediaType === 'sticker' ? 'image' : mediaType,
      fileName: att.name, callbackData: msg.id,
    }) : { ok: false, detail: 'insert failed', code: 'db' };
    if (msg) await admin.from('relay_messages').update({
      status: r.ok ? 'sent' : 'failed', provider_msg_id: r.ok ? r.providerMsgId || null : null,
      error_code: r.ok ? null : r.code || 'unknown', error_detail: r.ok ? null : (r.detail || '').slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq('id', msg.id);
    allOk = allOk && !!msg && r.ok;
  }
  return allOk;
}

async function sendFirstTemplate(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  ws: string, conversationId: string, phoneE164: string,
  templateName: string | null, language: string,
  lead: { full_name?: string | null; visa_type?: string | null },
): Promise<{ ok: boolean; error: string | null }> {
  if (!templateName) return { ok: false, error: 'No template chosen for the closed-window path.' };

  const candidates = [firstNameOf(lead.full_name), visaLabelOf(lead.visa_type), 'Migrizo'];
  const pad = (n: number) => Array.from({ length: n }, (_, i) => candidates[i] || candidates[0] || 'Migrizo');

  const { data: tplRow } = await admin.from('relay_templates')
    .select('id, body, variable_count')
    .eq('workspace_id', ws).eq('name', templateName).maybeSingle();

  let values = pad(tplRow?.variable_count ?? 0);
  const renderBody = (vals: string[]) =>
    tplRow?.body
      ? tplRow.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m: string, n: string) => vals[Number(n) - 1] || '')
      : `Template “${templateName}”`;

  const { data: msg } = await admin.from('relay_messages')
    .insert({
      workspace_id: ws, conversation_id: conversationId, direction: 'out',
      body: renderBody(values), template_name: templateName, template_language: language,
      template_values: { bodyValues: values }, status: 'queued', sent_by: null,
    }).select('id').single();
  if (!msg) return { ok: false, error: 'Could not save message.' };

  let result = await sendTemplate({ phoneE164, templateName, languageCode: language, bodyValues: values, callbackData: msg.id });

  // learn the variable count from Interakt's rejection, exactly like manual sends
  if (!result.ok) {
    const m = /expected number of values (?:are|is)\s*(\d+)/i.exec(result.detail || '');
    if (m) {
      values = pad(Number(m[1]));
      if (tplRow?.id) await admin.from('relay_templates').update({ variable_count: Number(m[1]), updated_at: new Date().toISOString() }).eq('id', tplRow.id);
      await admin.from('relay_messages').update({ body: renderBody(values), template_values: { bodyValues: values } }).eq('id', msg.id);
      result = await sendTemplate({ phoneE164, templateName, languageCode: language, bodyValues: values, callbackData: msg.id });
    }
  }

  await admin.from('relay_messages').update({
    status: result.ok ? 'sent' : 'failed', provider_msg_id: result.providerMsgId || null,
    error_code: result.ok ? null : result.code || 'unknown',
    error_detail: result.ok ? null : (result.detail || '').slice(0, 500),
    updated_at: new Date().toISOString(),
  }).eq('id', msg.id);

  return { ok: result.ok, error: result.ok ? null : result.detail || 'send failed' };
}
