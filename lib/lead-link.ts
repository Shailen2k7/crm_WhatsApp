// =============================================================================
// LEAD LINKING — the end of "Not in CRM" for people the CRM already knows.
// -----------------------------------------------------------------------------
// People fill the Meta ad form with ONE number and WhatsApp us from ANOTHER
// (their Facebook number vs the phone in their hand). The CRM holds the form
// number; the chat arrives from the other one. Before this file, 164 of 194
// "Not in CRM" chats were exactly that — leads the CRM plainly knew, shown as
// strangers, chased by the automation on a number they never answer.
//
// The enquiry message itself carries the truth. It spells out the form's
// answers ("Full name: … Phone number: … Email: …"), so when it arrives:
//
//   1. PARSE the form fields out of the message.
//   2. MATCH a lead — by either phone (form's or WhatsApp's, last-10 digits,
//      the CRM's own rule) first, then by email.
//   3. Exactly ONE match → LINK the conversation to that lead, silently.
//      Several matches     → do nothing; the side panel offers the candidates
//                            and a human picks (linking the wrong person is
//                            worse than a day of "Not in CRM").
//      No match            → CREATE the lead from the form (Shailen, 22 Oct
//                            2026: "Yes"), with the WhatsApp number as its
//                            phone — the one we know reaches them — and the
//                            form number kept in intake. The new lead then
//                            gets T1 through the normal new-lead rule, as a
//                            free text while their 24h window is open.
//
// Used by the webhook (the moment the enquiry arrives), by the side panel's
// one-click Link/Create buttons, and by the one-time backfill.
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { toE164 } from '@/lib/phone';
import { isEnquiry } from '@/lib/automation/first-message';

export interface ParsedEnquiry {
  fullName: string | null;
  /** The phone typed INTO the form (often not the WhatsApp number). */
  formPhone: string | null;
  email: string | null;
  expertise: string | null;
  /** The "ready to invest £7000?" answer: yes / no / maybe. */
  investmentReadiness: string | null;
}

const last10 = (p: string | null | undefined): string | null => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};

/** Pull the form's answers out of the enquiry message. Pure; forgiving. */
export function parseEnquiry(body: string | null | undefined): ParsedEnquiry | null {
  const b = body || '';
  if (!isEnquiry(b)) return null;
  const line = (re: RegExp): string | null => {
    const m = b.match(re);
    const v = m?.[1]?.split('\n')[0]?.trim();
    return v && v.length > 0 ? v : null;
  };
  const name = line(/full\s*name\s*:\s*(.+)/i);
  const phone = line(/phone\s*(?:number)?\s*:\s*([+\d][\d\s().-]{6,})/i);
  const email = line(/e-?mail\s*:\s*(\S+@\S+)/i);
  const expertise = line(/(?:field of expertise|qualify under)[^:]*:\s*(.+)/i);
  const invest = line(/invest[^:]*\?\s*:\s*(.+)/i);
  return {
    fullName: name,
    formPhone: phone ? phone.replace(/[\s().-]/g, '') : null,
    email: email ? email.replace(/[,;]+$/, '').toLowerCase() : null,
    expertise,
    investmentReadiness: invest ? (/(^|\b)y(es)?\b/i.test(invest) ? 'yes' : /\bno\b/i.test(invest) ? 'no' : 'maybe') : null,
  };
}

export interface LeadLite { id: string; full_name: string | null; phone: string | null; email: string | null; stage: string | null }

/**
 * Every lead this enquiry could belong to, best first: phone matches (either
 * number) are certain enough to act on; an email match joins them.
 */
export async function matchLeads(
  admin: SupabaseClient, ws: string,
  opts: { waPhone: string | null; parsed: ParsedEnquiry },
): Promise<LeadLite[]> {
  const keys = [...new Set([last10(opts.parsed.formPhone), last10(opts.waPhone)].filter(Boolean) as string[])];
  const found = new Map<string, LeadLite>();
  for (const k of keys) {
    const { data } = await admin.from('leads')
      .select('id, full_name, phone, email, stage')
      .eq('workspace_id', ws).eq('is_sample', false).ilike('phone', `%${k}`).limit(5);
    for (const l of (data || []) as LeadLite[]) if (last10(l.phone) === k) found.set(l.id, l);
  }
  if (opts.parsed.email) {
    const { data } = await admin.from('leads')
      .select('id, full_name, phone, email, stage')
      .eq('workspace_id', ws).eq('is_sample', false).ilike('email', opts.parsed.email).limit(5);
    for (const l of (data || []) as LeadLite[]) found.set(l.id, l);
  }
  return [...found.values()];
}

export type LinkOutcome =
  | { action: 'linked'; leadId: string; leadName: string | null }
  | { action: 'created'; leadId: string; leadName: string | null }
  | { action: 'ambiguous'; candidates: LeadLite[] }
  | { action: 'none' };

/**
 * The whole decision for one enquiry, exactly as described at the top.
 * Never throws: a linking failure must never fail the webhook that carries
 * a customer's message.
 */
export async function linkOrCreateLead(
  admin: SupabaseClient,
  opts: { ws: string; conversationId: string; waPhone: string | null; body: string | null },
): Promise<LinkOutcome> {
  try {
    const parsed = parseEnquiry(opts.body);
    if (!parsed) return { action: 'none' };

    const candidates = await matchLeads(admin, opts.ws, { waPhone: opts.waPhone, parsed });

    if (candidates.length === 1) {
      const lead = candidates[0];
      // Last check, then link — only if the conversation is still unlinked.
      const { error } = await admin.from('relay_conversations')
        .update({ lead_id: lead.id }).eq('id', opts.conversationId).is('lead_id', null);
      if (error) { console.error('[lead-link] link failed', error); return { action: 'none' }; }
      console.info('[lead-link] linked', { conversation: opts.conversationId, lead: lead.id, name: lead.full_name });
      return { action: 'linked', leadId: lead.id, leadName: lead.full_name };
    }

    if (candidates.length > 1) return { action: 'ambiguous', candidates };

    // ---- nobody matches: this enquiry IS the lead record ----------------------
    if (!parsed.fullName || (!opts.waPhone && !parsed.formPhone)) return { action: 'none' };
    const phone = toE164(opts.waPhone || parsed.formPhone!);
    if (!phone) return { action: 'none' };
    const { data: created, error: insErr } = await admin.from('leads')
      .insert({
        workspace_id: opts.ws,
        full_name: parsed.fullName.slice(0, 120),
        phone,                                     // the number that provably reaches them
        email: parsed.email,
        stage: 'cold',
        source: 'WhatsApp Form',
        tags: ['whatsapp-form'],
        investment_readiness: parsed.investmentReadiness,
        intake: {
          expertise: parsed.expertise,
          investment_readiness: parsed.investmentReadiness,
          ...(parsed.formPhone && last10(parsed.formPhone) !== last10(phone) ? { form_phone: parsed.formPhone } : {}),
        },
      })
      .select('id, full_name').single();
    if (insErr || !created) { console.error('[lead-link] create failed', insErr); return { action: 'none' }; }
    await admin.from('relay_conversations')
      .update({ lead_id: created.id }).eq('id', opts.conversationId).is('lead_id', null);
    console.info('[lead-link] created', { conversation: opts.conversationId, lead: created.id, name: created.full_name });
    return { action: 'created', leadId: created.id, leadName: created.full_name };
  } catch (e) {
    console.error('[lead-link] failed', e);
    return { action: 'none' };
  }
}
