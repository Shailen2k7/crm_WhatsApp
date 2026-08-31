/* Relay service worker.
   Phase 1: registers and claims clients so the app is installable.
   Push handling lands in Phase 5 — deliberately not stubbed here, because a
   half-working notification is harder to debug than an absent one. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
