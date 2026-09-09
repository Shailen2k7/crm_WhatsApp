// =============================================================================
// CV CAPTURE FROM WHATSAPP — a document arrives, the lead gets a profile.
// -----------------------------------------------------------------------------
// Called from the webhook the moment an inbound document has been archived.
// The conversation already knows its lead (relay_conversations.lead_id), so
// there is no matching to do — the only judgement is "is this a CV?", and
// that is held to a STRICT bar here because nobody is watching: an invoice
// written over somebody's CV would be worse than doing nothing.
//
// Never throws. The webhook must acknowledge Interakt no matter what happens
// in here, or the message is retried and duplicated.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { extractCv, kindOf } from '@/lib/cv-extract';

/** Unattended threshold. The CRM's drop page uses 0.4 because a human is looking. */
const AUTO_CV_THRESHOLD = 0.6;

export async function captureCvFromDocument(
  admin: SupabaseClient,
  opts: { workspaceId: string; conversationId: string; messageId: string; buf: Buffer; filename: string; mime: string | null },
): Promise<{ captured: boolean; reason: string }> {
  try {
    if (kindOf(opts.filename, opts.mime) === 'unsupported') return { captured: false, reason: 'not a pdf/docx' };

    const { data: conv } = await admin
      .from('relay_conversations').select('lead_id').eq('id', opts.conversationId).maybeSingle();
    const leadId = conv?.lead_id as string | null;
    if (!leadId) return { captured: false, reason: 'conversation has no lead' };

    const x = await extractCv(opts.buf, opts.filename, opts.mime);
    if (x.cvScore < AUTO_CV_THRESHOLD) return { captured: false, reason: `cv score ${x.cvScore.toFixed(2)} below ${AUTO_CV_THRESHOLD}` };

    const { data: lead } = await admin
      .from('leads').select('id, profile_text, profile_received').eq('id', leadId).maybeSingle();
    if (!lead) return { captured: false, reason: 'lead missing' };

    const profile_received = lead.profile_received === 'both' ? 'both' : 'cv';
    const { error } = await admin.from('leads').update({
      profile_text: x.text,
      profile_received,
      profile_received_at: new Date().toISOString(),
      cv_name: opts.filename,
    }).eq('id', leadId);
    if (error) return { captured: false, reason: error.message };

    // No user_id: this was the machine, and activity.user_id references
    // auth.users, so an invented id would fail the insert.
    try {
      await admin.from('activity').insert({
        workspace_id: opts.workspaceId, user_id: null, lead_id: leadId,
        action: 'cv_profile_saved',
        meta: {
          source: 'whatsapp',
          message_id: opts.messageId,
          filename: opts.filename,
          bytes: Buffer.byteLength(x.text, 'utf8'),
          condensed: x.condensed,
          cv_score: x.cvScore,
          replaced: !!lead.profile_text,
          previous_text: lead.profile_text || null,
        },
      });
    } catch { /* best-effort */ }

    return { captured: true, reason: `saved ${Buffer.byteLength(x.text, 'utf8')} bytes` };
  } catch (e) {
    return { captured: false, reason: e instanceof Error ? e.message : 'extract failed' };
  }
}
