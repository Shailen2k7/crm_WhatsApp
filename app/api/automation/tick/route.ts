import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
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

  // ---- the rule ------------------------------------------------------------
  let q = admin.from('relay_automations').select('*').eq('key', 'new_lead_first').eq('enabled', true);
  if (workspaceId) q = q.eq('workspace_id', workspaceId);
  const { data: rules, error: ruleErr } = await q;
  if (ruleErr) return NextResponse.json({ ok: false, error: ruleErr.message }, { status: 500 });
  if (!rules?.length) return NextResponse.json({ ok: true, ran: 0, note: 'Rule is off.' });

  const report: Record<string, unknown>[] = [];

  for (const rule of rules) {
    const ws = rule.workspace_id as string;
    const out: Record<string, unknown> = { workspace: ws, key: rule.key, sent: 0, skipped: [] as string[] };
    report.push(out);

    if (!rule.activated_at) { out.note = 'Rule has no activation time — switch it off and on once.'; continue; }
    if (!isConfigured() && !dryRun) { out.note = 'INTERAKT_API_KEY is not set.'; continue; }

    // ---- daily cap (counted from the audit log, IST day) -------------------
    const dayStartIst = new Date(`${istDate()}T00:00:00+05:30`).toISOString();
    const { count: sentToday } = await admin
      .from('relay_automation_sent')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws).eq('automation_key', rule.key)
      .eq('ok', true).gte('sent_at', dayStartIst);
    const room = Math.max(0, (rule.daily_cap ?? 50) - (sentToday ?? 0));
    if (room === 0) { out.note = `Daily cap of ${rule.daily_cap} reached.`; continue; }

    // ---- eligible leads: created after activation, older than the delay ----
    const cutoff = new Date(Date.now() - (rule.delay_seconds ?? 60) * 1_000).toISOString();
    const { data: leads } = await admin
      .from('leads')
      .select('id, full_name, phone, visa_type, created_at, is_sample')
      .eq('workspace_id', ws)
      .gte('created_at', rule.activated_at)
      .lte('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(200);

    const candidates = (leads || []).filter((l) => !l.is_sample && (l.phone || '').trim());
    if (!candidates.length) { out.note = 'No new leads waiting.'; continue; }

    // ---- already handled / suppressed --------------------------------------
    const [{ data: done }, { data: suppressed }] = await Promise.all([
      admin.from('relay_automation_sent').select('lead_id, phone_e164').eq('workspace_id', ws).eq('automation_key', rule.key),
      admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', ws),
    ]);
    const doneLeads = new Set((done || []).map((d) => d.lead_id).filter(Boolean));
    const donePhones = new Set((done || []).map((d) => d.phone_e164));
    const stopPhones = new Set((suppressed || []).map((s) => s.phone_e164));

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

      // claim the lead FIRST (ok=false). The unique indexes make this the
      // atomic lock: a concurrent tick loses the insert and skips.
      const { data: claim, error: claimErr } = await admin
        .from('relay_automation_sent')
        .insert({ workspace_id: ws, automation_key: rule.key, lead_id: lead.id, phone_e164: phoneE164, method, detail, ok: false })
        .select('id').single();
      if (claimErr || !claim) continue; // someone else claimed it

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

      await admin.from('relay_automation_sent').update({ ok, error: errText }).eq('id', claim.id);
      if (ok) out.sent = (out.sent as number) + 1;
      else (out.skipped as string[]).push(`${lead.full_name}: ${errText}`);
    }

    // ---- people who message us from a number that is not in the CRM -------
    // They fill the form with one number and then WhatsApp from another. The
    // reply belongs on the number they actually used, so an unknown inbound
    // gets the same first message without waiting for a lead record.
    const { data: inbound } = await admin
      .from('relay_conversations')
      .select('id, phone_e164, last_inbound_at')
      .eq('workspace_id', ws)
      .not('last_inbound_at', 'is', null)
      .gte('last_inbound_at', rule.activated_at)
      .lte('last_inbound_at', cutoff)
      .order('last_inbound_at', { ascending: true })
      .limit(100);

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

      // A number that already has a lead row was handled by the pass above, or
      // belongs to an older contact this rule deliberately leaves alone.
      if (knownDigits.has(phoneE164.replace(/\D/g, '').slice(-10))) continue;

      // Greet them by the name in their enquiry when it carries one.
      const { data: firstMsg } = await admin
        .from('relay_messages')
        .select('body').eq('conversation_id', conv.id).eq('direction', 'in')
        .order('created_at', { ascending: true }).limit(1).maybeSingle();
      const stranger = { full_name: nameFromEnquiry(firstMsg?.body), visa_type: null };

      if (dryRun) {
        (out.skipped as string[]).push(`DRY RUN — would send the first message to ${phoneE164} (not in CRM)`);
        continue;
      }

      const { data: claim, error: claimErr } = await admin
        .from('relay_automation_sent')
        .insert({
          workspace_id: ws, automation_key: rule.key, lead_id: null, phone_e164: phoneE164,
          method: 'quick_reply', detail: rule.quick_reply_shortcut, ok: false,
        })
        .select('id').single();
      if (claimErr || !claim) continue;   // another tick got there first

      let ok = false; let errText: string | null = null;
      try {
        // They have just messaged us, so the 24-hour window is open and the
        // free-form quick reply is the right thing to send.
        ok = await sendQuickReply(admin, ws, conv.id, phoneE164, rule.quick_reply_shortcut, stranger);
        if (!ok) errText = 'quick reply failed (see message row)';
      } catch (e) {
        errText = e instanceof Error ? e.message : String(e);
      }

      await admin.from('relay_automation_sent').update({ ok, error: errText }).eq('id', claim.id);
      if (ok) { out.sent = (out.sent as number) + 1; donePhones.add(phoneE164); }
      else (out.skipped as string[]).push(`${phoneE164}: ${errText}`);
    }
  }

  // The C1–C8 follow-up machine rides the same tick. Dry runs skip it —
  // its own page has live counters, and a dry run must never send.
  let sequences: Awaited<ReturnType<typeof runSequences>> = [];
  let campaigns: Awaited<ReturnType<typeof runCampaigns>> = [];
  if (!dryRun) {
    try { sequences = await runSequences(admin); }
    catch (e) { console.error('[sequences] tick failed', e); }
    // One-time blasts ride the same tick, in their own try so a bad campaign
    // can never stop the follow-up machine.
    try { campaigns = await runCampaigns(admin); }
    catch (e) { console.error('[campaigns] tick failed', e); }
  }

  return NextResponse.json({ ok: true, dryRun, report, sequences, campaigns });
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
