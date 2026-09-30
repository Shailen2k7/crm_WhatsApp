// =============================================================================
// RETIRED — automation was removed from the WhatsApp app on 30 Sep 2026.
// -----------------------------------------------------------------------------
// This used to be a Netlify scheduled function that ran the automation every
// five minutes. The app is now a plain chat: customers write in, the team
// replies by hand. There is no `schedule` below any more, so Netlify stops
// running it on the next deploy, and if anything calls it directly it does
// nothing at all.
// =============================================================================

export default async (): Promise<Response> =>
  new Response('Automation has been removed — this app is a manual WhatsApp chat.', { status: 410 });
