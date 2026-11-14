// Who is calling a Broadcast route. Broadcasts cost money and reach customers,
// so every route that changes or sends anything is for admins only.
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function broadcastCaller() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 }) };
  const { data: member } = await supabase.from('workspace_members')
    .select('workspace_id, role, status').eq('user_id', user.id).maybeSingle();
  if (!member || member.status !== 'active') {
    return { error: NextResponse.json({ ok: false, error: 'No active workspace membership.' }, { status: 403 }) };
  }
  if (member.role !== 'admin') {
    return { error: NextResponse.json({ ok: false, error: 'Only an admin can use Broadcasts.' }, { status: 403 }) };
  }
  const meta = (user.user_metadata || {}) as { full_name?: string; name?: string };
  const name = (meta.full_name || meta.name || user.email || '').trim() || null;
  return { user, ws: member.workspace_id as string, name };
}
