// =============================================================================
// TEST PUSH — fires a real notification at this workspace's registered devices.
// -----------------------------------------------------------------------------
// Notifications are the one feature you cannot verify by looking at the screen:
// the whole point is that they arrive when you are NOT looking. So this exists
// to make them testable on demand rather than by asking a client to message you.
//
// It reports how many devices it actually reached, which is the number that
// matters — "0 devices" is the real answer when nothing arrives, and no amount
// of staring at a phone reveals it.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { pushToWorkspace } from '@/lib/push-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 });

  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id, status')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!member || member.status !== 'active') {
    return NextResponse.json({ ok: false, error: 'No active membership.' }, { status: 403 });
  }

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server not configured.' }, { status: 500 });

  if (!process.env.VAPID_PRIVATE_KEY || !process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) {
    return NextResponse.json({
      ok: false,
      error: 'Push is not configured — VAPID keys are missing on this deployment.',
    }, { status: 503 });
  }

  const { count } = await admin
    .from('push_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', member.workspace_id);

  const sent = await pushToWorkspace(admin, member.workspace_id, {
    title: 'Migrizo · test notification',
    body: 'If you can see this, notifications are working on this device.',
    url: '/',
    tag: 'relay-test',
  });

  return NextResponse.json({
    ok: true,
    registeredDevices: count ?? 0,
    delivered: sent,
    note: sent === 0
      ? 'No device accepted the push. Register this device with "Turn on notifications" first.'
      : `Sent to ${sent} device${sent === 1 ? '' : 's'}.`,
  });
}
