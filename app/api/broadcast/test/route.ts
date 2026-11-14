// =============================================================================
// BROADCAST TEST — the exact message, to one number, before it goes to many.
// Sent as the person pressing the button (it IS a person writing), through the
// same code the broadcast itself uses, so what arrives is what everyone gets.
// =============================================================================
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isConfigured } from '@/lib/interakt';
import { toE164 } from '@/lib/phone';
import { broadcastCaller } from '@/lib/broadcast/auth';
import { fetchLiveTemplates } from '@/lib/broadcast/templates';
import { countVars, missingVariables, resolveValues, type VarSpec } from '@/lib/broadcast/model';
import { friendlyFailure, resolveHeader, sendBroadcastMessage } from '@/lib/broadcast/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const who = await broadcastCaller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });
  if (!isConfigured()) return NextResponse.json({ ok: false, error: 'WhatsApp is not connected — INTERAKT_API_KEY is not set.' }, { status: 503 });

  const body = await req.json().catch(() => ({})) as {
    templateName?: string; language?: string; variables?: VarSpec[]; phone?: string; name?: string;
  };
  const phone = toE164(body.phone);
  if (!phone) return NextResponse.json({ ok: false, error: 'That does not look like a phone number.' }, { status: 400 });
  const templateName = String(body.templateName || '').trim();
  if (!templateName) return NextResponse.json({ ok: false, error: 'Choose a template first.' }, { status: 400 });

  const live = await fetchLiveTemplates();
  if (!live.ok) return NextResponse.json({ ok: false, error: live.error }, { status: 502 });
  const tpl = live.templates.find((t) => t.name === templateName && (!body.language || t.language === body.language))
    || live.templates.find((t) => t.name === templateName);
  if (!tpl) return NextResponse.json({ ok: false, error: `Interakt has no approved template called “${templateName}”.` }, { status: 400 });
  if (tpl.blocked) return NextResponse.json({ ok: false, error: tpl.blocked }, { status: 400 });

  const variables = Array.isArray(body.variables) ? body.variables : [];
  const varCount = countVars(tpl.body);
  const missing = missingVariables(variables, varCount);
  if (missing.length) return NextResponse.json({ ok: false, error: `Fill in {{${missing[0]}}} first.` }, { status: 400 });

  const { header, missing: headerMissing } = await resolveHeader(admin, tpl.name, tpl.header);
  if (headerMissing) {
    return NextResponse.json({ ok: false, error: `“${tpl.name}” needs its file (PDF or image) and none is set up. Add it in Files → template headers.` }, { status: 400 });
  }

  const { data: conv, error: convErr } = await admin.rpc('relay_get_or_create_conversation', {
    p_workspace_id: who.ws, p_phone_e164: phone,
  });
  if (convErr || !conv) return NextResponse.json({ ok: false, error: convErr?.message || 'Could not open a chat for that number.' }, { status: 500 });

  const result = await sendBroadcastMessage(admin, {
    workspaceId: who.ws, conversationId: conv as string, phoneE164: phone,
    templateName: tpl.name, language: tpl.language, body: tpl.body,
    values: resolveValues(variables, varCount, { full_name: (body.name || '').trim() || who.name, visa_type: null }),
    header, sentBy: who.user.id, failOwner: who.user.id,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: friendlyFailure(result.code, result.detail) }, { status: 502 });
  }
  return NextResponse.json({ ok: true, phone });
}
