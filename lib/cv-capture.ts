// =============================================================================
// CV CAPTURE FROM WHATSAPP — a document arrives, the lead gets a profile.
// -----------------------------------------------------------------------------
// Called from the webhook the moment an inbound document has been archived.
//
// Every document now leaves a record in relay_cv_captures, whatever happens to
// it. Before, only successes were logged, so a CV that was skipped simply
// vanished — on one day 3 real CVs were lost that way, 2 of them because the
// person WhatsApped from a different number than the one on their form.
//
// THE JUDGEMENT, in order:
//   1. Can we read it at all? Photos, old .doc files, scans and garbled PDFs
//      cannot be turned into text — recorded 'unreadable' so a human opens it.
//   2. Is it a CV? The score from cv-extract decides:
//        ≥ 0.6  confident — saved automatically
//        ≥ 0.4  plausible — held for one-click review (the CRM's own drop page
//               accepts 0.4 because a human is looking; so does the popup)
//        < 0.4  something else — recorded 'not_cv'
//   3. Whose is it? The conversation's lead first; otherwise the lead is found
//      by phone number in any format, then by the email or phone typed on
//      their enquiry form, then by the contact details inside the CV itself.
//      A CV with no findable owner is recorded 'unmatched' — never dropped.
//
// Held to a strict bar because nobody is watching: an invoice written over
// somebody's CV would be worse than doing nothing.
//
// Never throws. The webhook must acknowledge Interakt no matter what happens
// in here, or the message is retried and duplicated.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { extractCv, kindOf, type Extracted } from '@/lib/cv-extract';

/** Unattended threshold. */
const AUTO_CV_THRESHOLD = 0.6;
/** Below the automatic bar but worth a human's one click. */
const REVIEW_CV_THRESHOLD = 0.4;

export type CaptureStatus = 'saved' | 'review' | 'unmatched' | 'unreadable' | 'not_cv';

interface CaptureOpts {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  buf: Buffer;
  filename: string;
  mime: string | null;
}

interface CaptureOptions {
  /**
   * Backfill: never replace a CV a lead already has. The live webhook keeps its
   * existing behaviour of replacing it with the newer one.
   */
  keepExisting?: boolean;
}

const last10 = (s: string | null | undefined) => String(s || '').replace(/\D/g, '').slice(-10);

// Words that appear in any real English document. Garbled text from a PDF with
// a broken font contains almost none of them; a real CV contains plenty.
const COMMON_WORDS = new Set((
  'the and for with from that this have has was were are you your our their his her ' +
  'will can not all any one two year years work worked working experience education ' +
  'university college school degree bachelor master skills project projects team management ' +
  'manager engineer engineering software development research data business company limited ' +
  'india email phone mobile address name date role responsible led developed designed ' +
  'present current technical professional summary profile objective certification training ' +
  'course science technology application systems services client clients customer sales ' +
  'marketing finance national international award awards published paper papers conference ' +
  'student member head senior junior lead analyst consultant officer director doctor medical ' +
  'hospital teacher professor department institute pvt ltd inc about also more than into ' +
  'over under within across during after before new high good well key major various'
).split(/\s+/));

function looksGarbled(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]{3,}/g) || [];
  if (words.length < 40) return false;
  const known = words.filter((w) => COMMON_WORDS.has(w)).length;
  return known / words.length < 0.03;
}

/** Why a file could not be read, in words a person understands. */
function unreadableReason(filename: string, mime: string | null): string {
  const m = (mime || '').toLowerCase();
  const f = filename.toLowerCase();
  if (m.startsWith('image/')) return 'photo sent as a file — no text to read';
  if (m === 'application/msword' || f.endsWith('.doc')) return 'old Word (.doc) format — cannot be read';
  return `unsupported file type (${mime || 'unknown'})`;
}

/** The first inbound message that looks like the Meta enquiry form. */
async function formDetails(admin: SupabaseClient, conversationId: string): Promise<{ email: string | null; phone: string | null }> {
  const { data } = await admin
    .from('relay_messages').select('body')
    .eq('conversation_id', conversationId).eq('direction', 'in')
    .ilike('body', '%:%')
    .order('created_at', { ascending: true }).limit(5);
  for (const row of data || []) {
    const body = row.body || '';
    if (!/full\s*name\s*:|filled\s+(in|out)\s+your\s+form/i.test(body)) continue;
    const email = body.match(/email\s*:\s*([^\s]+@[^\s]+)/i)?.[1]?.toLowerCase() || null;
    const phone = body.match(/phone(?:\s*number)?\s*:\s*([+\d][\d\s()-]{7,})/i)?.[1] || null;
    return { email, phone };
  }
  return { email: null, phone: null };
}

/** Leads whose phone matches these digits, however the number was typed. */
async function leadsByPhone(admin: SupabaseClient, ws: string, phone: string | null): Promise<{ id: string; created_at: string }[]> {
  const d = last10(phone);
  if (d.length < 10) return [];
  const { data } = await admin
    .from('leads').select('id, phone, created_at')
    .eq('workspace_id', ws).ilike('phone', `%${d.slice(-4)}%`).limit(100);
  return (data || []).filter((l) => last10(l.phone) === d);
}

async function leadsByEmail(admin: SupabaseClient, ws: string, email: string | null): Promise<{ id: string; created_at: string }[]> {
  if (!email) return [];
  const { data } = await admin
    .from('leads').select('id, created_at')
    .eq('workspace_id', ws).ilike('email', email.trim()).limit(20);
  return data || [];
}

const newest = (rows: { id: string; created_at: string }[]) =>
  [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.id ?? null;

/**
 * Whose document is this? Strongest evidence first; stops at the first hit.
 */
async function resolveLead(
  admin: SupabaseClient, ws: string,
  conv: { lead_id: string | null; phone_e164: string | null },
  conversationId: string,
  cv: Extracted | null,
): Promise<{ leadId: string | null; method: string | null }> {
  if (conv.lead_id) return { leadId: conv.lead_id, method: 'conversation' };

  const byPhone = newest(await leadsByPhone(admin, ws, conv.phone_e164));
  if (byPhone) return { leadId: byPhone, method: 'phone' };

  const form = await formDetails(admin, conversationId);
  const byFormEmail = newest(await leadsByEmail(admin, ws, form.email));
  if (byFormEmail) return { leadId: byFormEmail, method: 'form_email' };
  const byFormPhone = newest(await leadsByPhone(admin, ws, form.phone));
  if (byFormPhone) return { leadId: byFormPhone, method: 'form_phone' };

  for (const email of cv?.contacts.emails || []) {
    const hit = newest(await leadsByEmail(admin, ws, email));
    if (hit) return { leadId: hit, method: 'cv_email' };
  }
  for (const phone of cv?.contacts.phones || []) {
    const hit = newest(await leadsByPhone(admin, ws, phone));
    if (hit) return { leadId: hit, method: 'cv_phone' };
  }
  return { leadId: null, method: null };
}

export async function captureCvFromDocument(
  admin: SupabaseClient,
  opts: CaptureOpts,
  options: CaptureOptions = {},
): Promise<{ captured: boolean; status: CaptureStatus | 'error'; reason: string }> {
  const record = async (row: {
    status: CaptureStatus; reason: string; leadId?: string | null; method?: string | null;
    score?: number | null; text?: string | null; phone?: string | null;
  }) => {
    try {
      await admin.from('relay_cv_captures').upsert({
        workspace_id: opts.workspaceId,
        message_id: opts.messageId,
        conversation_id: opts.conversationId,
        lead_id: row.leadId ?? null,
        phone_e164: row.phone ?? null,
        file_name: opts.filename,
        file_mime: opts.mime,
        status: row.status,
        reason: row.reason,
        cv_score: row.score ?? null,
        match_method: row.method ?? null,
        extracted_text: row.status === 'review' || row.status === 'unmatched' ? row.text ?? null : null,
      }, { onConflict: 'message_id', ignoreDuplicates: true });
    } catch { /* the record is best-effort; the capture itself must not fail */ }
  };

  try {
    const { data: conv } = await admin
      .from('relay_conversations').select('lead_id, phone_e164').eq('id', opts.conversationId).maybeSingle();
    const convInfo = { lead_id: (conv?.lead_id as string | null) ?? null, phone_e164: (conv?.phone_e164 as string | null) ?? null };

    // ---- 1. can it be read? ------------------------------------------------
    if (kindOf(opts.filename, opts.mime) === 'unsupported') {
      const who = await resolveLead(admin, opts.workspaceId, convInfo, opts.conversationId, null);
      const reason = unreadableReason(opts.filename, opts.mime);
      await record({ status: 'unreadable', reason, leadId: who.leadId, method: who.method, phone: convInfo.phone_e164 });
      return { captured: false, status: 'unreadable', reason };
    }

    let x: Extracted;
    try {
      x = await extractCv(opts.buf, opts.filename, opts.mime);
    } catch {
      const who = await resolveLead(admin, opts.workspaceId, convInfo, opts.conversationId, null);
      const reason = 'could not open the file (damaged or password-protected)';
      await record({ status: 'unreadable', reason, leadId: who.leadId, method: who.method, phone: convInfo.phone_e164 });
      return { captured: false, status: 'unreadable', reason };
    }

    if (x.rawBytes < 300 || x.text.trim().length < 300) {
      const who = await resolveLead(admin, opts.workspaceId, convInfo, opts.conversationId, null);
      const reason = 'scanned or image-only PDF — no text inside';
      await record({ status: 'unreadable', reason, leadId: who.leadId, method: who.method, phone: convInfo.phone_e164, score: 0 });
      return { captured: false, status: 'unreadable', reason };
    }
    if (looksGarbled(x.text)) {
      const who = await resolveLead(admin, opts.workspaceId, convInfo, opts.conversationId, null);
      const reason = 'text inside is garbled (unusual font) — open the file';
      await record({ status: 'unreadable', reason, leadId: who.leadId, method: who.method, phone: convInfo.phone_e164, score: 0 });
      return { captured: false, status: 'unreadable', reason };
    }

    // ---- 2. is it a CV? ----------------------------------------------------
    const score = x.cvScore;
    if (score < REVIEW_CV_THRESHOLD) {
      const reason = `not a CV (score ${score.toFixed(2)})`;
      const who = await resolveLead(admin, opts.workspaceId, convInfo, opts.conversationId, null);
      await record({ status: 'not_cv', reason, leadId: who.leadId, method: who.method, phone: convInfo.phone_e164, score });
      return { captured: false, status: 'not_cv', reason };
    }

    // ---- 3. whose is it? ---------------------------------------------------
    const who = await resolveLead(admin, opts.workspaceId, convInfo, opts.conversationId, x);
    if (!who.leadId) {
      const reason = 'looks like a CV, but no lead matches this number, form or CV';
      await record({ status: 'unmatched', reason, phone: convInfo.phone_e164, score, text: x.text });
      return { captured: false, status: 'unmatched', reason };
    }

    if (score < AUTO_CV_THRESHOLD) {
      const reason = `probably a CV (score ${score.toFixed(2)}) — confirm to save`;
      await record({ status: 'review', reason, leadId: who.leadId, method: who.method, phone: convInfo.phone_e164, score, text: x.text });
      return { captured: false, status: 'review', reason };
    }

    // ---- confident: save it ------------------------------------------------
    const { data: lead } = await admin
      .from('leads').select('id, profile_text, profile_received').eq('id', who.leadId).maybeSingle();
    if (!lead) {
      const reason = 'matched lead no longer exists';
      await record({ status: 'unmatched', reason, phone: convInfo.phone_e164, score, text: x.text });
      return { captured: false, status: 'unmatched', reason };
    }

    if (options.keepExisting && lead.profile_text) {
      const reason = 'lead already has a CV on record';
      await record({ status: 'saved', reason, leadId: lead.id, method: who.method, phone: convInfo.phone_e164, score });
      return { captured: false, status: 'saved', reason };
    }

    const profile_received = lead.profile_received === 'both' ? 'both' : 'cv';
    const { error } = await admin.from('leads').update({
      profile_text: x.text,
      profile_received,
      profile_received_at: new Date().toISOString(),
      cv_name: opts.filename,
    }).eq('id', lead.id);
    if (error) {
      await record({ status: 'review', reason: `save failed: ${error.message}`, leadId: lead.id, method: who.method, phone: convInfo.phone_e164, score, text: x.text });
      return { captured: false, status: 'review', reason: error.message };
    }

    // No user_id: this was the machine, and activity.user_id references
    // auth.users, so an invented id would fail the insert.
    try {
      await admin.from('activity').insert({
        workspace_id: opts.workspaceId, user_id: null, lead_id: lead.id,
        action: 'cv_profile_saved',
        meta: {
          source: 'whatsapp',
          message_id: opts.messageId,
          filename: opts.filename,
          bytes: Buffer.byteLength(x.text, 'utf8'),
          condensed: x.condensed,
          cv_score: score,
          match_method: who.method,
          replaced: !!lead.profile_text,
          previous_text: lead.profile_text || null,
        },
      });
    } catch { /* best-effort */ }

    const reason = `saved ${Buffer.byteLength(x.text, 'utf8')} bytes`;
    await record({ status: 'saved', reason, leadId: lead.id, method: who.method, phone: convInfo.phone_e164, score });
    return { captured: true, status: 'saved', reason };
  } catch (e) {
    return { captured: false, status: 'error', reason: e instanceof Error ? e.message : 'extract failed' };
  }
}
