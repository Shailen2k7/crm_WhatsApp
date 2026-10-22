// =============================================================================
// LINK A CHAT TO ITS LEAD — the side panel's one-click actions.
// -----------------------------------------------------------------------------
// GET  ?conversationId=  → what the enquiry says, and which leads could match:
//                          { parsed, candidates } — the panel renders Link /
//                          Create from this.
// POST {conversationId, leadId}            → link to that lead (human chose)
// POST {conversationId, create:{name?, email?}} → create the lead from the
//                          enquiry (or the typed name for a plain chat) and
//                          link it.
//
// Any active member may do this — connecting a chat to the CRM is everyday
// team work, not an admin switch. Every write re-checks that the conversation
// is still unlinked, so two people clicking at once cannot cross-link.
// =============================================================================
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { parseEnquiry, matchLeads, linkOrCreateLead } from '@/lib/lead-link';
import { isEnquiry } from '@/lib/automation/first-message';
import { toE164 } from '@/lib/phone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function caller() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 }) };
  const { data: member } = await supabase.from('workspace_members')
    .select('workspace_id, status').eq('user_id', user.id).maybeSingle();
  if (!member || member.status !== 'active') {
    return { error: NextResponse.json({ ok: false, error: 'No active workspace membership.' }, { status: 403 }) };
  }
  return { user, ws: member.workspace_id as string };
}

/** The conversation, its first enquiry-looking inbound, and its phone. */
async function conversationFacts(admin: SupabaseClient, ws: string, conversationId: string) {
  const { data: conv } = await admin.from('relay_conversations')
    .select('id, phone_e164, lead_id').eq('id', conversationId).eq('workspace_id', ws).maybeSingle();
  if (!conv) return null;
  const { data: inbound } = await admin.from('relay_messages')
    .select('body').eq('conversation_id', conversationId).eq('direction', 'in')
    .order('created_at', { ascending: true }).limit(10);
  const enquiry = ((inbound || []) as { body: string | null }[]).find((m) => isEnquiry(m.body))?.body ?? null;
  return { conv: conv as { id: string; phone_e164: string | null; lead_id: string | null }, enquiry };
}

export async function GET(req: Request) {
  const who = await caller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  const conversationId = new URL(req.url).searchParams.get('conversationId') || '';
  if (!conversationId) return NextResponse.json({ ok: false, error: 'No conversation.' }, { status: 400 });
  const facts = await conversationFacts(admin, who.ws, conversationId);
  if (!facts) return NextResponse.json({ ok: false, error: 'Conversation not found.' }, { status: 404 });
  if (facts.conv.lead_id) return NextResponse.json({ ok: true, alreadyLinked: facts.conv.lead_id });

  const parsed = parseEnquiry(facts.enquiry);
  const candidates = parsed ? await matchLeads(admin, who.ws, { waPhone: facts.conv.phone_e164, parsed }) : [];
  return NextResponse.json({ ok: true, parsed, candidates });
}

export async function POST(req: Request) {
  const who = await caller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  let body: { conversationId?: string; leadId?: string; create?: { name?: string; email?: string } };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 }); }
  const conversationId = String(body.conversationId || '');
  if (!conversationId) return NextResponse.json({ ok: false, error: 'No conversation.' }, { status: 400 });
  const facts = await conversationFacts(admin, who.ws, conversationId);
  if (!facts) return NextResponse.json({ ok: false, error: 'Conversation not found.' }, { status: 404 });
  if (facts.conv.lead_id) return NextResponse.json({ ok: false, error: 'Already linked — refresh.' }, { status: 409 });

  // ---- a human picked one of the candidates ----------------------------------
  if (body.leadId) {
    const { data: lead } = await admin.from('leads')
      .select('id, full_name').eq('id', body.leadId).eq('workspace_id', who.ws).maybeSingle();
    if (!lead) return NextResponse.json({ ok: false, error: 'That lead no longer exists.' }, { status: 404 });
    const { data: updated } = await admin.from('relay_conversations')
      .update({ lead_id: lead.id }).eq('id', conversationId).is('lead_id', null).select('id');
    if (!updated?.length) return NextResponse.json({ ok: false, error: 'Already linked — refresh.' }, { status: 409 });
    console.info('[link-lead] human linked', { by: who.user.email, conversationId, lead: lead.id });
    return NextResponse.json({ ok: true, action: 'linked', leadId: lead.id, leadName: lead.full_name });
  }

  // ---- create (form chat: from the enquiry; plain chat: from the typed name) --
  if (body.create) {
    const parsed = parseEnquiry(facts.enquiry);
    if (parsed) {
      const out = await linkOrCreateLead(admin, { ws: who.ws, conversationId, waPhone: facts.conv.phone_e164, body: facts.enquiry });
      if (out.action === 'linked' || out.action === 'created') {
        console.info('[link-lead] via enquiry', { by: who.user.email, conversationId, ...out });
        return NextResponse.json({ ok: true, ...out });
      }
      if (out.action === 'ambiguous') return NextResponse.json({ ok: false, error: 'More than one lead matches — pick one from the list.', candidates: out.candidates }, { status: 409 });
      return NextResponse.json({ ok: false, error: 'Could not create the lead.' }, { status: 500 });
    }
    const name = (body.create.name || '').trim();
    const phone = toE164(facts.conv.phone_e164);
    if (!name) return NextResponse.json({ ok: false, error: 'A name is needed.' }, { status: 400 });
    if (!phone) return NextResponse.json({ ok: false, error: 'This chat has no usable phone number.' }, { status: 400 });
    const { data: created, error } = await admin.from('leads')
      .insert({
        workspace_id: who.ws, full_name: name.slice(0, 120), phone,
        email: (body.create.email || '').trim().toLowerCase() || null,
        stage: 'cold', source: 'WhatsApp', tags: ['whatsapp-chat'],
      }).select('id, full_name').single();
    if (error || !created) return NextResponse.json({ ok: false, error: error?.message || 'Could not create the lead.' }, { status: 500 });
    await admin.from('relay_conversations').update({ lead_id: created.id }).eq('id', conversationId).is('lead_id', null);
    console.info('[link-lead] created from chat', { by: who.user.email, conversationId, lead: created.id });
    return NextResponse.json({ ok: true, action: 'created', leadId: created.id, leadName: created.full_name });
  }

  return NextResponse.json({ ok: false, error: 'Nothing to do.' }, { status: 400 });
}
