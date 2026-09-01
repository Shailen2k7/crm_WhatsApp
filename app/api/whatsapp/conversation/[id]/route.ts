// =============================================================================
// CONVERSATION DELETE — "full flexibility to remove all data".
// -----------------------------------------------------------------------------
// DELETE /api/whatsapp/conversation/<id>            -> whole thread + its files
// DELETE /api/whatsapp/conversation/<id>?messageId= -> one message + its file
//
// Admin only — the same rule the CRM applies to deleting leads. Deleting a
// conversation removes its messages (FK cascade), and its storage folder is
// emptied FIRST, so no orphaned passports sit in the bucket afterwards.
//
// The CRM lead is NEVER touched. Chat data and lead data are different things.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { RELAY_BUCKET } from '@/lib/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 });

  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id, role')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!member) return NextResponse.json({ ok: false, error: 'No membership.' }, { status: 403 });
  if (member.role !== 'admin') {
    return NextResponse.json({ ok: false, error: 'Only an admin can delete chat data.' }, { status: 403 });
  }

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Not configured.' }, { status: 500 });

  const { data: conv } = await admin
    .from('relay_conversations')
    .select('id, workspace_id')
    .eq('id', id)
    .maybeSingle();
  if (!conv || conv.workspace_id !== member.workspace_id) {
    return NextResponse.json({ ok: false, error: 'Conversation not found.' }, { status: 404 });
  }

  const messageId = new URL(req.url).searchParams.get('messageId');

  // ---- single message ------------------------------------------------------
  if (messageId) {
    const { data: msg } = await admin
      .from('relay_messages')
      .select('id, conversation_id, media_path')
      .eq('id', messageId)
      .maybeSingle();
    if (!msg || msg.conversation_id !== id) {
      return NextResponse.json({ ok: false, error: 'Message not found in this conversation.' }, { status: 404 });
    }
    if (msg.media_path) {
      await admin.storage.from(RELAY_BUCKET).remove([msg.media_path]);
    }
    await admin.from('relay_messages').delete().eq('id', msg.id);
    return NextResponse.json({ ok: true, deleted: 'message' });
  }

  // ---- whole conversation --------------------------------------------------
  // Files first: everything under workspace/conversation/, paginated because
  // list() caps at 100 per call.
  const prefix = `${conv.workspace_id}/${conv.id}`;
  let removedFiles = 0;
  for (let page = 0; page < 50; page++) {
    const { data: objs } = await admin.storage.from(RELAY_BUCKET).list(prefix, { limit: 100 });
    if (!objs || objs.length === 0) break;
    const paths = objs.map((o) => `${prefix}/${o.name}`);
    await admin.storage.from(RELAY_BUCKET).remove(paths);
    removedFiles += paths.length;
    if (objs.length < 100) break;
  }

  const { error } = await admin.from('relay_conversations').delete().eq('id', conv.id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, deleted: 'conversation', removedFiles });
}
