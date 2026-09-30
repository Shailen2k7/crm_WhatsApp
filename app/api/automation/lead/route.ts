// =============================================================================
// RETIRED — automation was removed from the WhatsApp app on 30 Sep 2026.
// -----------------------------------------------------------------------------
// The app is now a plain chat: customers write in, the team replies by hand.
// Nothing here sends, schedules, enrols or checks anything any more. Every call
// is refused with 410 Gone, so an old browser tab, a bookmark or a stray cron
// can never set a message off.
// =============================================================================
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gone() {
  return NextResponse.json(
    { ok: false, error: 'Automation has been removed — this app is a manual WhatsApp chat.' },
    { status: 410 },
  );
}

export const GET = gone;
export const POST = gone;
export const PATCH = gone;
export const PUT = gone;
export const DELETE = gone;
