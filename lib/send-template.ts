// =============================================================================
// SHARED TEMPLATE SEND — one code path for every automated template message.
// -----------------------------------------------------------------------------
// Used by the new-lead rule and the C1–C8 sequence engine. Inserts a normal
// relay_messages row first (so the send appears in the chat thread with ticks,
// exactly like a human send), then calls Interakt, then records the outcome.
//
// Carries the same self-healing as manual sends:
//   * variable count learned from Interakt's rejection and retried
//   * body rendered from the registered wording so the thread shows real text
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTemplate } from '@/lib/interakt';

export function firstNameOf(fullName: string | null | undefined): string {
  const n = (fullName || '').trim().split(/\s+/)[0];
  return n || 'there';
}

export function visaLabelOf(visaType: string | null | undefined): string {
  const v = (visaType || '').toLowerCase();
  return v.includes('ifv') || v.includes('innovator') ? 'Innovator Founder Visa' : 'Global Talent Visa';
}

export async function sendTemplateToLead(
  admin: SupabaseClient,
  args: {
    workspaceId: string;
    conversationId: string;
    phoneE164: string;
    templateName: string;
    language: string;
    lead: { full_name?: string | null; visa_type?: string | null };
  },
): Promise<{ ok: boolean; messageId: string | null; error: string | null }> {
  const { workspaceId: ws, conversationId, phoneE164, templateName, language, lead } = args;

  const candidates = [firstNameOf(lead.full_name), visaLabelOf(lead.visa_type), 'Migrizo'];
  const pad = (n: number) => Array.from({ length: n }, (_, i) => candidates[i] || candidates[0] || 'Migrizo');

  const { data: tplRow } = await admin
    .from('relay_templates')
    .select('id, body, variable_count')
    .eq('workspace_id', ws)
    .eq('name', templateName)
    .maybeSingle();

  let values = pad(tplRow?.variable_count ?? 0);
  const renderBody = (vals: string[]) =>
    tplRow?.body
      ? tplRow.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m: string, n: string) => vals[Number(n) - 1] || '')
      : `Template “${templateName}”`;

  const { data: msg } = await admin
    .from('relay_messages')
    .insert({
      workspace_id: ws, conversation_id: conversationId, direction: 'out',
      body: renderBody(values), template_name: templateName, template_language: language,
      template_values: { bodyValues: values }, status: 'queued', sent_by: null,
    })
    .select('id')
    .single();
  if (!msg) return { ok: false, messageId: null, error: 'Could not save the message row.' };

  let result = await sendTemplate({ phoneE164, templateName, languageCode: language, bodyValues: values, callbackData: msg.id });

  // Wrong number of values? Interakt names the right one — learn it, retry once.
  if (!result.ok) {
    const m = /expected number of values (?:are|is)\s*(\d+)/i.exec(result.detail || '');
    if (m) {
      values = pad(Number(m[1]));
      if (tplRow?.id) {
        await admin.from('relay_templates')
          .update({ variable_count: Number(m[1]), updated_at: new Date().toISOString() })
          .eq('id', tplRow.id);
      }
      await admin.from('relay_messages')
        .update({ body: renderBody(values), template_values: { bodyValues: values } })
        .eq('id', msg.id);
      result = await sendTemplate({ phoneE164, templateName, languageCode: language, bodyValues: values, callbackData: msg.id });
    }
  }

  await admin.from('relay_messages').update({
    status: result.ok ? 'sent' : 'failed',
    provider_msg_id: result.providerMsgId || null,
    error_code: result.ok ? null : result.code || 'unknown',
    error_detail: result.ok ? null : (result.detail || '').slice(0, 500),
    updated_at: new Date().toISOString(),
  }).eq('id', msg.id);

  return { ok: result.ok, messageId: msg.id, error: result.ok ? null : result.detail || 'send failed' };
}
