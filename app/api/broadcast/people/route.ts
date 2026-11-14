// =============================================================================
// BROADCAST PEOPLE — everyone a broadcast could go to, in one answer.
// The page filters this list itself, so tapping a chip is instant; the server
// reads it afresh at launch, so what is sent never depends on this copy.
// =============================================================================
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { broadcastCaller } from '@/lib/broadcast/auth';
import { loadBroadcastPeople } from '@/lib/broadcast/people';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const who = await broadcastCaller();
  if ('error' in who) return who.error;
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server is not configured.' }, { status: 500 });
  try {
    const { people, stopPhones } = await loadBroadcastPeople(admin, who.ws);
    return NextResponse.json({ ok: true, people, stopPhones, at: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'Could not load people.' }, { status: 500 });
  }
}
