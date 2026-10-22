// =============================================================================
// AUTOMATION OVERVIEW — GET ?key=<step>. What one step on Settings →
// Automation shows (see lib/automation/overview.ts). Any active member may
// look; nothing here writes.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { buildOverview, OVERVIEW_KEYS } from '@/lib/automation/overview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 });
  const { data: member } = await supabase.from('workspace_members')
    .select('workspace_id, role, status').eq('user_id', user.id).maybeSingle();
  if (!member || member.status !== 'active') return NextResponse.json({ ok: false, error: 'No active workspace membership.' }, { status: 403 });

  const key = new URL(req.url).searchParams.get('key') || '';
  if (!OVERVIEW_KEYS.includes(key)) return NextResponse.json({ ok: false, error: 'Unknown automation.' }, { status: 400 });

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  try {
    const started = Date.now();
    const ov = await buildOverview(admin, member.workspace_id as string, key);
    if (!ov) return NextResponse.json({ ok: false, error: 'This automation is not set up.' }, { status: 404 });
    return NextResponse.json({ ok: true, isAdmin: member.role === 'admin', ms: Date.now() - started, ...ov });
  } catch (e) {
    console.error('[automation overview]', e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
