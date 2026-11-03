// Shared helpers for the push notification functions.
// Uses the Supabase REST API with the service-role key (server-side only).
import webpush from 'web-push'

export const env = () => {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const vapidPublic = process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY
  if (!url || !serviceKey || !vapidPublic || !vapidPrivate) return null
  // the sender contact every push service (Apple, Google, Mozilla) checks:
  // must be a real https URL or mailto — the site's own address is always valid
  const subject =
    process.env.VAPID_SUBJECT ||
    (process.env.URL && process.env.URL.startsWith('https://') ? process.env.URL : 'https://meetingauth.netlify.app')
  webpush.setVapidDetails(subject, vapidPublic, vapidPrivate)
  return { url, serviceKey }
}

export const rest = async (cfg, path, init = {}) => {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: cfg.serviceKey,
      Authorization: `Bearer ${cfg.serviceKey}`,
      'content-type': 'application/json',
      Prefer: 'return=minimal',
      ...(init.headers ?? {})
    }
  })
  if (!res.ok) throw new Error(`Supabase ${path} → ${res.status}: ${await res.text()}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export const restGet = (cfg, path) =>
  rest(cfg, path, { headers: { Prefer: 'return=representation' } })

/**
 * How long a push service keeps an alert for a phone that is offline (flight,
 * no signal, switched off), and how urgently it delivers it. 'high' wakes
 * Android Doze / iPhone Low Power Mode immediately instead of batching.
 */
const DELIVERY = {
  reminder: { TTL: 12 * 3600, urgency: 'high' },
  meeting: { TTL: 3600, urgency: 'high' },
  booking: { TTL: 6 * 3600, urgency: 'high' },
  task: { TTL: 6 * 3600, urgency: 'normal' },
  // a chat message: wanted now, pointless by tomorrow
  chat: { TTL: 3600, urgency: 'high' }
}
const DEFAULT_DELIVERY = { TTL: 6 * 3600, urgency: 'normal' }

// push messages are capped at ~4 KB by every push service — long notes must never break delivery
const clip = (s, n) => {
  const t = String(s ?? '')
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

/** Send one payload to every subscription; prune the dead ones. */
export const sendToSubs = async (cfg, subs, payload) => {
  const body = JSON.stringify({ ...payload, title: clip(payload.title, 120), body: clip(payload.body, 600) })
  const delivery = DELIVERY[payload.kind] ?? DEFAULT_DELIVERY
  let sent = 0
  await Promise.all(
    subs.map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription, body, delivery)
        sent++
      } catch (err) {
        const code = err?.statusCode
        if (code === 404 || code === 410) {
          // subscription expired or revoked → remove it
          try {
            await rest(cfg, `push_subscriptions?endpoint=eq.${encodeURIComponent(row.endpoint)}`, {
              method: 'DELETE'
            })
          } catch {
            /* best effort */
          }
        } else {
          console.error('push send failed:', code, err?.body ?? err?.message)
        }
      }
    })
  )
  return sent
}

const pad = (n) => String(n).padStart(2, '0')

/** host-local wall time (date key + minutes) → UTC ms, honouring the host timezone */
export const wallToUtc = (tz, dateKey, minutes) => {
  const [y, m, d] = dateKey.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, 0, minutes)
  const offsetAt = (utcMs) => {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        })
          .formatToParts(new Date(utcMs))
          .map((p) => [p.type, p.value])
      )
      const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        parts.hour === '24' ? 0 : Number(parts.hour),
        Number(parts.minute),
        Number(parts.second)
      )
      return asUtc - utcMs
    } catch {
      return 0
    }
  }
  const off1 = offsetAt(guess)
  let utc = guess - off1
  const off2 = offsetAt(utc)
  if (off2 !== off1) utc = guess - off2
  return utc
}

/** "Tue 6 Oct, 3:00 PM" from host-local wall time */
export const wallLabel = (dateKey, minutes) => {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60))
  const day = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  const h24 = dt.getUTCHours()
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${day}, ${h12}:${pad(dt.getUTCMinutes())} ${h24 < 12 ? 'AM' : 'PM'}`
}
