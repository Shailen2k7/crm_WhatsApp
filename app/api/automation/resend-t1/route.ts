// =============================================================================
// RESEND T1 — the button on Settings → Automation → T1 → "Never arrived".
// -----------------------------------------------------------------------------
// POST {phone}. ADMINS ONLY (checked here, on the server).
//
// The screen may be minutes old, so nothing it showed is trusted: the person
// is re-examined from live data with the same function that built the list.
// They must still be someone nothing has reached, who has not replied, whom the
// team has not taken over, not Hot/Won/Junk/Lost, not opted out — and whose
// failure is one a resend can actually fix.
//
// The T1 record itself is the lock: it is moved forward with a conditional
// update on its old timestamp, so two clicks (or two admins) can never send
// twice. If WhatsApp accepts the message, the record says so and the lead
// enters the normal T2 → T4 chase from today. If Meta refuses it again later,
// the chase's T1-retry step applies the 4-day / 10-day / stop rule.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { findUndeliveredT1 } from '@/lib/automation/undelivered';
import { sendTemplateToLead } from '@/lib/send-template';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 });
  const { data: member } = await supabase.from('workspace_members')
    .select('workspace_id, role, status').eq('user_id', user.id).maybeSingle();
  if (!member || member.status !== 'active') return NextResponse.json({ ok: false, error: 'No active workspace membership.' }, { status: 403 });
  if (member.role !== 'admin') return NextResponse.json({ ok: false, error: 'Only an admin can resend.' }, { status: 403 });
  const ws = member.workspace_id as string;

  let phone = '';
  try { phone = String((await req.json()).phone || ''); } catch { /* handled below */ }
  if (!/^\+\d{8,15}$/.test(phone)) return NextResponse.json({ ok: false, error: 'Bad phone.' }, { status: 400 });

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  // ---- re-check from live data, right now ----------------------------------------
  const [person] = await findUndeliveredT1(admin, ws, Date.now(), phone);
  if (!person) {
    return NextResponse.json({ ok: false, error: 'Not sent: this person has since been reached, replied, been taken over by the team, or changed stage.' }, { status: 409 });
  }
  if (!person.canResend) return NextResponse.json({ ok: false, error: `Not sent: ${person.note || person.reason}.` }, { status: 409 });

  const { data: rule } = await admin.from('relay_automations')
    .select('template_name, template_language').eq('workspace_id', ws).eq('key', 'new_lead_first').maybeSingle();
  if (!rule?.template_name) return NextResponse.json({ ok: false, error: 'No T1 template is set.' }, { status: 500 });

  // ---- claim: move the T1 record forward only if nobody else has ---------------------
  const { data: claimed } = await admin.from('relay_automation_sent')
    .update({ ok: false, error: 'in flight — resend by admin — delivery unknown', sent_at: new Date().toISOString() })
    .eq('id', person.rowId).eq('sent_at', person.rowSentAt).select('id, attempts');
  if (!claimed?.length) return NextResponse.json({ ok: false, error: 'Someone else is already resending this — refresh.' }, { status: 409 });

  const { data: convId } = await admin.rpc('relay_get_or_create_conversation', { p_workspace_id: ws, p_phone_e164: phone });
  if (!convId) {
    await admin.from('relay_automation_sent').update({ error: 'resend failed — could not open a conversation' }).eq('id', person.rowId);
    return NextResponse.json({ ok: false, error: 'Could not open the conversation.' }, { status: 500 });
  }
  const { data: lead } = person.leadId
    ? await admin.from('leads').select('full_name, visa_type').eq('id', person.leadId).maybeSingle()
    : { data: null };

  const r = await sendTemplateToLead(admin, {
    workspaceId: ws, conversationId: convId as string, phoneE164: phone,
    templateName: rule.template_name, language: rule.template_language || 'en',
    lead: { full_name: (lead as { full_name?: string } | null)?.full_name ?? person.name, visa_type: (lead as { visa_type?: string } | null)?.visa_type ?? null },
  });

  await admin.from('relay_automation_sent').update({
    ok: r.ok,
    method: 'template',
    detail: rule.template_name,
    error: r.ok ? null : r.timedOut ? 'resend — timeout — delivery unknown' : `resend failed — ${r.error || 'unknown'}`,
    attempts: ((claimed[0] as { attempts?: number }).attempts ?? 1) + 1,
  }).eq('id', person.rowId);

  console.info('[resend t1]', { by: user.email, phone, ok: r.ok, error: r.error });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.timedOut ? 'WhatsApp did not answer in time — check the chat in a minute before trying again.' : `WhatsApp refused it: ${r.error}` }, { status: 502 });
  return NextResponse.json({ ok: true, messageId: r.messageId });
}
