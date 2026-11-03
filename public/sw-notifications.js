// Push + notification handlers (imported into the generated service worker).

// Server push — works with the app fully closed.
//  'reminder' → one normal notification with a double buzz, on screen until dismissed.
//  'meeting'  → stays on screen, one strong buzz, Join button.
//  others     → a short buzz.
const SNOOZE_MIN = 10

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const isReminder = data.kind === 'reminder'
  const isMeeting = data.kind === 'meeting'
  const isChat = data.kind === 'chat'
  const actions = []
  if (data.url && isMeeting) actions.push({ action: 'join', title: 'Join' })
  event.waitUntil(
    (async () => {
      // a chat message for a chat the person is looking at right now needs no banner
      if (isChat && data.chat) {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        for (const w of wins) w.postMessage({ type: 'chat-new', id: data.chat })
        if (wins.some((w) => w.focused && w.visibilityState === 'visible')) return
      }
      await self.registration.showNotification(data.title || 'Taskorra', {
        body: data.body || '',
        tag: data.tag || undefined,
        renotify: true,
        requireInteraction: isReminder || isMeeting,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        // reminders: long alarm-like pattern; everything else: one short buzz
        vibrate: isReminder ? [250, 120, 250] : [180],
        data: { url: data.url, ack: data.ack, kind: data.kind, chat: data.chat },
        actions
      })
      // If the app is open anywhere (even in a background tab, where its timers
      // are frozen), wake it NOW: the full-screen alarm opens and starts ringing.
      if (isReminder) {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        for (const w of wins) {
          w.postMessage({
            type: 'ring-alarm',
            alarm: { title: data.title, body: data.body, tag: data.tag, ack: data.ack }
          })
        }
      }
    })()
  )
})

// Tell the server to stop re-ringing this reminder on every device (and, for
// Snooze, to ring it again later).
const sendAck = (ack, snooze) =>
  ack && ack.id
    ? fetch('/api/notify-ack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snooze ? { ...ack, snooze } : ack),
        keepalive: true
      }).catch(() => {})
    : Promise.resolve()

const windows = () => clients.matchAll({ type: 'window', includeUncontrolled: true })

// Let an open app silence its own ring / show the alarm screen.
const tellApp = (msg) =>
  windows().then((wins) => {
    for (const w of wins) w.postMessage(msg)
  })

// The browser renewed this device's push address (it can happen any time, even
// with the app closed): subscribe again and tell the server old → new, so
// notifications never silently stop. Open windows also re-save it.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const oldEndpoint = event.oldSubscription && event.oldSubscription.endpoint
      let sub = event.newSubscription
      if (!sub) {
        const key =
          (event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey) || null
        if (key) sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      }
      if (sub && oldEndpoint) {
        await fetch('/api/push-resubscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ oldEndpoint, subscription: sub.toJSON() }),
          keepalive: true
        })
      }
      const wins = await self.clients.matchAll({ type: 'window' })
      for (const w of wins) w.postMessage({ type: 'resubscribe-push' })
    })().catch(() => {})
  )
})

self.addEventListener('notificationclick', (event) => {
  const n = event.notification
  n.close()
  const { url, ack, kind, chat } = n.data || {}
  const alarm = { title: n.title, body: n.body, tag: n.tag, ack }

  // a chat message: open that chat in the app that is already open, or open the app on it
  if (kind === 'chat' && chat) {
    event.waitUntil(
      windows().then((wins) => {
        for (const w of wins) {
          if ('focus' in w) {
            w.postMessage({ type: 'open-chat', id: chat })
            return w.focus()
          }
        }
        return clients.openWindow(url || `/app?chat=${chat}`)
      })
    )
    return
  }

  if (event.action === 'stop' || event.action === 'snooze') {
    const snooze = event.action === 'snooze' ? SNOOZE_MIN : 0
    event.waitUntil(
      Promise.all([sendAck(ack, snooze), tellApp({ type: 'alarm-handled', alarm, snooze })])
    )
    return
  }
  if (event.action === 'join' && url) {
    event.waitUntil(Promise.all([sendAck(ack), clients.openWindow(url)]))
    return
  }

  // Default tap on a reminder: open the app onto the full-screen alarm
  // (Stop / Snooze live there). Everything else: just focus or open the app.
  const isReminder = kind === 'reminder' || (!kind && ack)
  event.waitUntil(
    windows().then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          if (isReminder) w.postMessage({ type: 'show-alarm', alarm })
          return w.focus()
        }
      }
      if (isReminder && ack && ack.id) {
        const q = `alarm=${encodeURIComponent(ack.id)}${ack.occ ? `&occ=${ack.occ}` : ''}`
        return clients.openWindow(`/app?${q}`)
      }
      return clients.openWindow('/app')
    })
  )
})

// Swiping a reminder away also stops the re-ringing.
self.addEventListener('notificationclose', (event) => {
  const { ack } = event.notification.data || {}
  if (ack) {
    event.waitUntil(
      Promise.all([
        sendAck(ack),
        tellApp({ type: 'alarm-handled', alarm: { tag: event.notification.tag, ack }, snooze: 0 })
      ])
    )
  }
})
