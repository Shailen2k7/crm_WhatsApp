// Who is calling the assistant's endpoints: any active team member may look
// and pause or resume one chat; only an admin may flip the main switch.
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function aiCaller() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 }) };
  const { data: member } = await supabase.from('workspace_members')
    .select('workspace_id, role, status').eq('user_id', user.id).maybeSingle();
  if (!member || member.status !== 'active') {
    return { error: NextResponse.json({ ok: false, error: 'No active workspace membership.' }, { status: 403 }) };
  }
  return { user, ws: member.workspace_id as string, isAdmin: member.role === 'admin' };
}
