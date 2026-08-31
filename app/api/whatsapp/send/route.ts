// =============================================================================
// SEND — the agent presses Send in the composer and lands here.
// -----------------------------------------------------------------------------
// Order of operations matters, and it is deliberate:
//
//   1. Authenticate the USER (session), not a secret. Only a signed-in member
//      of the workspace may message a lead.
//   2. Resolve the conversation, creating it if this is the first message.
//   3. Enforce the 24-hour window BEFORE calling Interakt. A free-form message
//      outside the window is not a provider error to recover from, it is a
//      thing we must not attempt.
//   4. Write the message row as 'queued' FIRST, then send. If the process dies
//      mid-send, an agent sees a queued message rather than a reply that
//      silently never existed.
//   5. Record the outcome — provider id on success, error code and detail on
//      failure — so a failed send is visible in the thread, not swallowed.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendText, sendTemplate, windowState, isConfigured } from '@/lib/interakt';
import { toE164 } from '@/lib/phone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // ---- 1. who is calling ---------------------------------------------------
  const supabase = await createClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 });
  }

  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id, status')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!member || member.status !== 'active') {
    return NextResponse.json({ ok: false, error: 'No active workspace membership.' }, { status: 403 });
  }
  const workspaceId = member.workspace_id as string;

  // ---- parse ---------------------------------------------------------------
  let body: {
    phone?: string;
    leadId?: string;
    conversationId?: string;
    message?: string;
    templateName?: string;
    templateLanguage?: string;
    templateValues?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Bad JSON.' }, { status: 400 });
  }

  const isTemplate = !!body.templateName;
  const text = (body.message || '').trim();
  if (!isTemplate && !text) {
    return NextResponse.json({ ok: false, error: 'Message is empty.' }, { status: 400 });
  }
  if (text.length > 4096) {
    return NextResponse.json({ ok: false, error: 'Message is too long (max 4096 characters).' }, { status: 400 });
  }

  const phoneE164 = toE164(body.phone);
  if (!phoneE164) {
    return NextResponse.json({ ok: false, error: 'That contact has no usable phone number.' }, { status: 400 });
  }

  if (!isConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'WhatsApp is not connected — INTERAKT_API_KEY is not set.' },
      { status: 503 }
    );
  }

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });
  }

  // ---- 2. conversation -----------------------------------------------------
  let conversationId = body.conversationId;
  if (!conversationId) {
    const { data, error } = await admin.rpc('relay_get_or_create_conversation', {
      p_workspace_id: workspaceId,
      p_phone_e164: phoneE164,
    });
    if (error || !data) {
      return NextResponse.json({ ok: false, error: error?.message || 'Could not open conversation.' }, { status: 500 });
    }
    conversationId = data as string;
  }

  const { data: conv } = await admin
    .from('relay_conversations')
    .select('id, workspace_id, last_inbound_at')
    .eq('id', conversationId)
    .maybeSingle();

  if (!conv || conv.workspace_id !== workspaceId) {
    return NextResponse.json({ ok: false, error: 'Conversation not found.' }, { status: 404 });
  }

  // ---- 3. the 24-hour rule -------------------------------------------------
  const win = windowState(conv.last_inbound_at);
  if (!isTemplate && !win.open) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'The 24-hour window is closed. WhatsApp only allows an approved template until they message you again.',
        code: 'window_closed',
        windowOpen: false,
      },
      { status: 409 }
    );
  }

  // ---- 4. optimistic row ---------------------------------------------------
  const { data: msg, error: insErr } = await admin
    .from('relay_messages')
    .insert({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      direction: 'out',
      body: isTemplate ? text || `[template: ${body.templateName}]` : text,
      template_name: body.templateName || null,
      template_language: body.templateLanguage || null,
      template_values: body.templateValues ? { bodyValues: body.templateValues } : null,
      status: 'queued',
      sent_by: user.id,
    })
    .select('id')
    .single();

  if (insErr || !msg) {
    return NextResponse.json({ ok: false, error: insErr?.message || 'Could not save message.' }, { status: 500 });
  }

  // ---- 5. send and record the outcome --------------------------------------
  const result = isTemplate
    ? await sendTemplate({
        phoneE164,
        templateName: body.templateName as string,
        languageCode: body.templateLanguage,
        bodyValues: body.templateValues,
        callbackData: msg.id,
      })
    : await sendText({ phoneE164, message: text, callbackData: msg.id });

  await admin
    .from('relay_messages')
    .update({
      status: result.ok ? 'sent' : 'failed',
      provider_msg_id: result.providerMsgId || null,
      error_code: result.ok ? null : result.code || 'unknown',
      error_detail: result.ok ? null : (result.detail || '').slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq('id', msg.id);

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, messageId: msg.id, error: result.detail || 'Interakt rejected the message.', code: result.code, raw: result.raw },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    messageId: msg.id,
    conversationId,
    providerMsgId: result.providerMsgId,
  });
}
