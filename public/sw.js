/* =============================================================================
   Relay service worker.
   -----------------------------------------------------------------------------
   THE SOUND PROBLEM, and how far this goes.

   The Web Notification API has no "sound" property. When a push arrives and the
   app is fully closed, the OPERATING SYSTEM chooses the sound — iOS and Android
   both. No website can override it. That is a platform rule.

   But "closed" and "in the background" are different things, and the background
   case is the common one on a phone: you switched to another app, you did not
   quit Relay. In that state the page is still alive, so the service worker can
   message it and the page plays Relay's own bird call.

   So the order below is deliberate:
     1. tell EVERY client (visible or hidden) to play the call;
     2. if none of them is visible, ALSO raise the OS banner, so a message is
        never missed just because the sound was the only signal.
   ============================================================================= */
const VERSION = 'relay-sw-4';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'Migrizo', body: event.data && event.data.text() };
  }

  const title = data.title || 'Migrizo — WhatsApp';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'relay',
    renotify: true,
    requireInteraction: true,
    data: { url: data.url || '/' },
    // The one part of the alert the web DOES let us choose. Long and irregular
    // so a Relay message feels different from every other buzz in a pocket.
    vibrate: [220, 90, 220, 90, 380, 130, 380],
    actions: [{ action: 'open', title: 'Open chat' }],
  };

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // 1. Ask every live page — foreground OR background — to play the call.
      let anyVisible = false;
      for (const c of clientList) {
        if (c.visibilityState === 'visible') anyVisible = true;
        try { c.postMessage({ type: 'relay-push', play: true, data }); } catch (_) { /* gone */ }
      }

      // 2. A visible page has already alerted the user on screen; anything else
      //    still needs the banner.
      if (!anyVisible) {
        await self.registration.showNotification(title, options);
        if ('setAppBadge' in navigator) {
          try { await navigator.setAppBadge(); } catch (_) { /* unsupported */ }
        }
      }
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      if ('clearAppBadge' in navigator) {
        try { await navigator.clearAppBadge(); } catch (_) { /* unsupported */ }
      }
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) {
        if ('focus' in c) {
          try { await c.navigate(url); } catch (_) { /* cross-origin guard */ }
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })()
  );
});
