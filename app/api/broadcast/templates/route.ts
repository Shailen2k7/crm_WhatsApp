// =============================================================================
// BROADCAST TEMPLATES — the approved list, live from Interakt.
// A template approved a minute ago appears here on the next Refresh. If
// Interakt cannot be reached, the app's saved list is returned instead (with a
// note), so a broadcast can still be written.
// =============================================================================
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { broadcastCaller } from '@/lib/broadcast/auth';
import { fetchLiveTemplates, rememberTemplates, savedTemplates } from '@/lib/broadcast/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const who = await broadcastCaller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });

  const live = await fetchLiveTemplates();
  if (live.ok) {
    await rememberTemplates(admin, who.ws, live.templates);
    return NextResponse.json({ ok: true, live: true, templates: live.templates });
  }
  const saved = await savedTemplates(admin, who.ws);
  return NextResponse.json({ ok: true, live: false, note: live.error, templates: saved });
}
