/* Relay service worker — push notifications with the strongest signal the web
   allows when the app is closed: a long unmistakable vibration and renotify.
   (The SOUND of an OS notification is the OS's decision; the in-app ringtone
   covers every open tab and installed window.) */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Relay', body: event.data && event.data.text() }; }
  const title = data.title || 'Relay — WhatsApp';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    requireInteraction: true, // stays on screen until dismissed — this is the business's phone ringing
    data: { url: data.url || '/' },
    vibrate: [180, 80, 180, 80, 300, 120, 300],
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      'setAppBadge' in navigator ? navigator.setAppBadge().catch(() => {}) : Promise.resolve(),
    ])
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) { c.navigate(url); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
