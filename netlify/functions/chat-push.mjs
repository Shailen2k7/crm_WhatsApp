// A chat message was sent: push it to everyone in that chat who isn't looking
// at it. Called by the sender's app right after the message is saved.
//
// The server decides who gets it: members of the chat (minus the sender),
// minus people the sender's app saw with that chat open (`skip`), minus anyone
// who muted the chat (unless they were @mentioned) and anyone on do-not-disturb.
import { env, restGet, sendToSubs } from '../lib/push-core.mjs'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const UUID = /^[0-9a-f-]{36}$/i

export default async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
  const cfg = env()
  if (!cfg) return json({ ok: false, error: 'not_configured' })

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return json({ ok: false, error: 'unauthorized' }, 401)
  const userRes = await fetch(`${cfg.url}/auth/v1/user`, { headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${token}` } })
  if (!userRes.ok) return json({ ok: false, error: 'unauthorized' }, 401)
  const user = await userRes.json()

  let body
  try {
    body = await req.json()
  } catch {
    return json({ ok: false }, 400)
  }
  const conversationId = String(body?.conversationId ?? '')
  const messageId = String(body?.messageId ?? '')
  const skip = new Set(Array.isArray(body?.skip) ? body.skip.filter((x) => typeof x === 'string').slice(0, 500) : [])
  if (!UUID.test(conversationId) || !UUID.test(messageId)) return json({ ok: false }, 400)

  // the message must exist, be in that chat and be the caller's own
  const [msg] = await restGet(cfg, `messages?select=id,sender_id,body,mentions,attachments,deleted_at&id=eq.${messageId}&conversation_id=eq.${conversationId}`)
  if (!msg || msg.sender_id !== user.id || msg.deleted_at) return json({ ok: false, error: 'not_yours' }, 403)

  const [conv] = await restGet(cfg, `conversations?select=kind,name,company_id&id=eq.${conversationId}`)
  if (!conv) return json({ ok: false }, 404)
  const members = await restGet(cfg, `conversation_members?select=user_id,muted&conversation_id=eq.${conversationId}`)
  const mentions = new Set(Array.isArray(msg.mentions) ? msg.mentions : [])
  let targets = members.filter((m) => m.user_id !== user.id && !skip.has(m.user_id) && (!m.muted || mentions.has(m.user_id)))
  if (!targets.length) return json({ ok: true, sent: 0 })

  // do-not-disturb holds everything (an @mention included — they asked for quiet)
  const ids = targets.map((m) => m.user_id)
  const prefs = await restGet(cfg, `chat_prefs?select=user_id,dnd_until&user_id=in.(${ids.join(',')})`)
  const now = Date.now()
  const quiet = new Set(prefs.filter((p) => p.dnd_until && Date.parse(p.dnd_until) > now).map((p) => p.user_id))
  targets = targets.filter((m) => !quiet.has(m.user_id))
  if (!targets.length) return json({ ok: true, sent: 0 })

  const [sender] = await restGet(cfg, `profiles?select=name,email&user_id=eq.${user.id}`)
  const senderName = (sender?.name || '').trim() || (sender?.email || '').split('@')[0] || 'Someone'
  const where = conv.kind === 'dm' ? '' : conv.kind === 'general' ? ' in #general' : conv.kind === 'team' ? ` in #${String(conv.name || 'team').toLowerCase().replace(/\s+/g, '-')}` : ` in ${conv.name || 'a group'}`
  const subs = await restGet(cfg, `push_subscriptions?select=endpoint,subscription,user_id&user_id=in.(${targets.map((m) => m.user_id).join(',')})`)
  if (!subs.length) return json({ ok: true, sent: 0 })

  // a picture or file with no words: say what was sent
  const files = Array.isArray(msg.attachments) ? msg.attachments : []
  const pics = files.filter((a) => /^image\//i.test(String(a?.type || ''))).length
  const filesLabel = !files.length ? '' : files.length === 1 ? (pics ? '📷 Photo' : `📎 ${files[0]?.name || 'File'}`) : pics === files.length ? `📷 ${pics} photos` : `📎 ${files.length} attachments`
  const text = String(msg.body || '').slice(0, 300)
  const payload = {
    kind: 'chat',
    title: `${senderName}${where}`,
    body: text ? (filesLabel ? `${filesLabel} · ${text}` : text) : filesLabel,
    // one notification per chat on the phone: a newer message replaces the older one
    tag: `chat-${conversationId}`,
    url: `/app?chat=${conversationId}`,
    chat: conversationId
  }
  // people who were @mentioned get their own, so a mention is never hidden behind another message
  const mentionedSubs = subs.filter((s) => mentions.has(s.user_id))
  const otherSubs = subs.filter((s) => !mentions.has(s.user_id))
  let sent = 0
  if (otherSubs.length) sent += await sendToSubs(cfg, otherSubs, payload)
  if (mentionedSubs.length) sent += await sendToSubs(cfg, mentionedSubs, { ...payload, title: `${senderName} mentioned you${where}`, tag: `chat-${conversationId}-${messageId}` })
  return json({ ok: true, sent })
}

export const config = { path: '/api/chat-push' }
