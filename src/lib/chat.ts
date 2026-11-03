import { create } from 'zustand'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { isSupabaseEnabled, supabase } from './supabase'
import { useWorkspace } from './workspace'
import { useStore } from '../store/useStore'
import { showToast } from './notify'
import { playBeep } from './sound'
import { meetingStart, toDateKey } from './time'
import { isPicture, prepareFile, type PreparedFile } from './chatFiles'
import type { ChatAttachment, ChatMessage, Conversation, Presence, PresenceStatus } from '../types'

/**
 * Workspace chat (cloud mode; the ?team=demo preview runs it in memory).
 *
 * How a message travels: it shows on the sender's screen at once, is saved to
 * the database and, at the same time, broadcast over a live channel to
 * everyone in the chat — so it arrives without anyone asking the server. The
 * database is the record: whenever the live connection was away (sleep, a
 * tunnel), the next refresh fetches what was missed. Nothing is ever sent
 * twice: every message gets its id on the device that wrote it.
 *
 * Channels (private — the database checks who may join, see chat.sql):
 *   chat:ws:<company>        presence (online · away · in a meeting · which chat
 *                            is open) and "a chat you are in was created"
 *   chat:conv:<conversation> messages, edits, removals, reactions, read
 *                            markers and typing
 *
 * Who may see what is enforced by the database: only a chat's members can read
 * it. Admins have no way into DMs or groups they are not part of.
 */

const PAGE = 50
/** messages kept on the device per chat, so a chat opens before the network answers */
const CACHE_PER_CHAT = 40
const TYPING_MS = 4000
const AWAY_AFTER_MS = 5 * 60_000
const SEEN_EVERY_MS = 5 * 60_000

interface Outbox {
  id: string
  conversationId: string
  body: string
  replyTo?: string
  mentions: string[]
  attachments: ChatAttachment[]
  createdAt: number
}

interface ChatState {
  companyId: string | null
  me: string | null
  /** the chat list is known (from the device cache or the server) */
  ready: boolean
  /** the live connection is up */
  connected: boolean
  conversations: Conversation[]
  /** by chat id, oldest first */
  messages: Record<string, ChatMessage[]>
  hasMore: Record<string, boolean>
  loading: Record<string, boolean>
  /** workspace-mates' live state, by user id */
  presence: Record<string, Presence>
  /** when people were last in the app, by user id (ms) */
  lastSeen: Record<string, number>
  /** others' do-not-disturb end times, by user id (ms) */
  dnd: Record<string, number>
  /** chat id → user id → typing until (ms) */
  typing: Record<string, Record<string, number>>
  openId: string | null
  /** my read marker when the open chat was opened — where "New messages" sits */
  openedAt: number
  drafts: Record<string, string>
  outbox: Outbox[]
  dndUntil: number | null
  /** a chat to open as soon as the Chat page shows (a link or a tapped notification) */
  pendingOpen: string | null
  /** where to load each picture or file from (short-lived links, or local previews while sending) */
  urls: Record<string, string>

  conversation: (id: string | null) => Conversation | undefined
  unreadTotal: () => number
}

export const useChat = create<ChatState>()((_set, get) => ({
  companyId: null,
  me: null,
  ready: false,
  connected: false,
  conversations: [],
  messages: {},
  hasMore: {},
  loading: {},
  presence: {},
  lastSeen: {},
  dnd: {},
  typing: {},
  openId: null,
  openedAt: 0,
  drafts: {},
  outbox: [],
  dndUntil: null,
  pendingOpen: null,
  urls: {},

  conversation: (id) => (id ? get().conversations.find((c) => c.id === id) : undefined),
  unreadTotal: () => get().conversations.reduce((n, c) => n + (c.muted ? 0 : c.unread), 0)
}))

/* ---------- names and helpers used by the screens ---------- */

/** the other person in a DM */
export const dmPartner = (c: Conversation, me: string | null) => c.memberIds.find((u) => u !== me) ?? c.memberIds[0]

/** what a chat is called: a person's name, a group's name or "#team" */
export const conversationTitle = (c: Conversation, me: string | null): string => {
  const ws = useWorkspace.getState()
  if (c.kind === 'dm') return ws.memberName(dmPartner(c, me)).replace(/^You$/, 'You (notes)')
  if (c.kind === 'general') return '#general'
  if (c.kind === 'team') return `#${c.name.toLowerCase().replace(/\s+/g, '-')}`
  if (c.name) return c.name
  const others = c.memberIds.filter((u) => u !== me).map((u) => ws.memberName(u).split(' ')[0])
  return others.length ? others.slice(0, 3).join(', ') + (others.length > 3 ? ` +${others.length - 3}` : '') : 'Group'
}

/** a workspace-mate's state right now, from presence and their settings */
export const statusOf = (userId: string): { status: PresenceStatus | 'offline'; meetingUntil?: number; lastSeen?: number } => {
  const s = useChat.getState()
  const p = s.presence[userId]
  const dnd = s.dnd[userId]
  if (p) return { status: dnd && dnd > Date.now() ? 'dnd' : p.status, meetingUntil: p.meetingUntil && p.meetingUntil > Date.now() ? p.meetingUntil : undefined }
  return { status: 'offline', lastSeen: s.lastSeen[userId] }
}

/** "9:40 PM" in someone's time zone (empty when unknown or the same as mine) */
export const localTimeFor = (timezone: string | undefined, mine = useStore.getState().settings.timezone): { time: string; hour: number } | null => {
  if (!timezone || timezone === mine) return null
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: false }).formatToParts(new Date())
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
    const time = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date())
    return { time, hour: h }
  } catch {
    return null
  }
}

/** the chat list order: pinned first, then by the latest message */
const sortConversations = (list: Conversation[]) =>
  [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt))

const sortMessages = (list: ChatMessage[]) => list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))

const mergeMessages = (into: ChatMessage[] | undefined, add: ChatMessage[]) => {
  const map = new Map((into ?? []).map((m) => [m.id, m]))
  for (const m of add) {
    const old = map.get(m.id)
    map.set(m.id, old ? { ...old, ...m, reactions: m.reactions.length || !old.reactions.length ? m.reactions : old.reactions } : m)
  }
  return sortMessages([...map.values()])
}

/* ---------- row mappers ---------- */

type ConvRow = {
  id: string
  kind: Conversation['kind']
  name: string
  team_id: string | null
  created_by: string | null
  created_at: string
  last_message_at: string | null
  last_read_at: string
  muted: boolean
  pinned: boolean
  members: { u: string; r: string }[]
  unread: number
  last: { id: string; sender_id: string; body: string; created_at: string; deleted: boolean; files?: number } | null
}
type MsgRow = {
  id: string
  conversation_id: string
  sender_id: string
  body: string
  reply_to: string | null
  mentions: string[] | null
  attachments: ChatAttachment[] | null
  edited_at: string | null
  deleted_at: string | null
  created_at: string
}
type ReactRow = { message_id: string; user_id: string; emoji: string }

const rowToConversation = (r: ConvRow, cid: string): Conversation => ({
  id: r.id,
  companyId: cid,
  kind: r.kind,
  name: r.name ?? '',
  teamId: r.team_id ?? undefined,
  createdBy: r.created_by ?? undefined,
  createdAt: Date.parse(r.created_at),
  memberIds: (r.members ?? []).map((m) => m.u),
  reads: Object.fromEntries((r.members ?? []).map((m) => [m.u, Date.parse(m.r)])),
  lastMessageAt: r.last_message_at ? Date.parse(r.last_message_at) : undefined,
  lastMessage: r.last ? { id: r.last.id, senderId: r.last.sender_id, body: r.last.body ?? '', createdAt: Date.parse(r.last.created_at), deleted: !!r.last.deleted, files: Number(r.last.files) || 0 } : undefined,
  lastReadAt: Date.parse(r.last_read_at),
  unread: Number(r.unread) || 0,
  muted: !!r.muted,
  pinned: !!r.pinned
})

const rowToMessage = (r: MsgRow, reactions: ReactRow[] = []): ChatMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  senderId: r.sender_id,
  body: r.deleted_at ? '' : (r.body ?? ''),
  replyTo: r.reply_to ?? undefined,
  mentions: r.mentions ?? [],
  attachments: r.deleted_at ? [] : (Array.isArray(r.attachments) ? r.attachments : []),
  editedAt: r.edited_at ? Date.parse(r.edited_at) : undefined,
  deletedAt: r.deleted_at ? Date.parse(r.deleted_at) : undefined,
  createdAt: Date.parse(r.created_at),
  reactions: groupReactions(reactions.filter((x) => x.message_id === r.id))
})

const groupReactions = (rows: ReactRow[]) => {
  const by = new Map<string, string[]>()
  for (const r of rows) by.set(r.emoji, [...(by.get(r.emoji) ?? []), r.user_id])
  return [...by].map(([emoji, userIds]) => ({ emoji, userIds }))
}

/* ---------- device cache (so Chat opens before the network answers) ---------- */

const cacheKey = (me: string, cid: string) => `msos-chat-${me}-${cid}`
const outboxKey = (me: string) => `msos-chat-outbox-${me}`

let saveTimer: ReturnType<typeof setTimeout> | null = null
const saveCache = () => {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const s = useChat.getState()
    if (!s.me || !s.companyId) return
    const messages: Record<string, ChatMessage[]> = {}
    for (const c of s.conversations) {
      const list = s.messages[c.id]
      if (list?.length) messages[c.id] = list.slice(-CACHE_PER_CHAT)
    }
    try {
      localStorage.setItem(cacheKey(s.me, s.companyId), JSON.stringify({ conversations: s.conversations, messages, drafts: s.drafts, dndUntil: s.dndUntil }))
    } catch {
      /* full or blocked: the cloud still has everything */
    }
  }, 800)
}

const loadCache = (me: string, cid: string) => {
  try {
    const raw = localStorage.getItem(cacheKey(me, cid))
    if (!raw) return false
    const c = JSON.parse(raw) as { conversations: Conversation[]; messages: Record<string, ChatMessage[]>; drafts: Record<string, string>; dndUntil: number | null }
    // cached messages are a window onto each chat: older ones load on scroll
    const hasMore: Record<string, boolean> = {}
    for (const id of Object.keys(c.messages)) hasMore[id] = true
    const messages: Record<string, ChatMessage[]> = {}
    for (const [id, list] of Object.entries(c.messages ?? {})) messages[id] = list.map((m) => ({ ...m, attachments: m.attachments ?? [], reactions: m.reactions ?? [] }))
    useChat.setState({
      conversations: Array.isArray(c.conversations) ? c.conversations : [],
      messages,
      hasMore,
      drafts: c.drafts ?? {},
      dndUntil: c.dndUntil && c.dndUntil > Date.now() ? c.dndUntil : null,
      ready: true
    })
    return true
  } catch {
    return false
  }
}

const saveOutbox = () => {
  const s = useChat.getState()
  if (!s.me) return
  try {
    localStorage.setItem(outboxKey(s.me), JSON.stringify(s.outbox))
  } catch {
    /* ignore */
  }
}
const loadOutbox = (me: string) => {
  try {
    const raw = localStorage.getItem(outboxKey(me))
    useChat.setState({ outbox: raw ? (JSON.parse(raw) as Outbox[]) : [] })
  } catch {
    useChat.setState({ outbox: [] })
  }
}

/* ---------- start / stop ---------- */

let wsChannel: RealtimeChannel | null = null
const convChannels = new Map<string, RealtimeChannel>()
let timers: ReturnType<typeof setInterval>[] = []
let listeners: (() => void)[] = []
let wasConnected = false
let hiddenSince: number | null = null

/** Opens chat for the workspace that is open. Safe to call again (e.g. after switching workspace). */
export const startChat = (companyId: string, me: string) => {
  const s = useChat.getState()
  if (s.companyId === companyId && s.me === me && (s.ready || !isSupabaseEnabled)) return
  stopChat()
  useChat.setState({ companyId, me, ready: false, openId: null, messages: {}, hasMore: {}, loading: {}, presence: {}, typing: {} })
  if (!isSupabaseEnabled) {
    // the ?team=demo preview: whatever the demo put in the store stays
    useChat.setState({ ready: true, connected: true })
    return
  }
  loadCache(me, companyId)
  loadOutbox(me)
  void refreshChat()
  openWorkspaceChannel(companyId, me)
  void heartbeat()

  timers.push(setInterval(() => void refreshChat(), 60_000))
  timers.push(setInterval(() => void heartbeat(), SEEN_EVERY_MS))
  timers.push(setInterval(() => trackPresence(), 60_000)) // keeps "in a meeting until" true
  timers.push(
    setInterval(() => {
      // typing indicators fade on their own
      const t = useChat.getState().typing
      const now = Date.now()
      let changed = false
      const next: typeof t = {}
      for (const [cid, by] of Object.entries(t)) {
        const kept = Object.fromEntries(Object.entries(by).filter(([, until]) => until > now))
        if (Object.keys(kept).length !== Object.keys(by).length) changed = true
        if (Object.keys(kept).length) next[cid] = kept
      }
      if (changed) useChat.setState({ typing: next })
    }, 1000)
  )

  const onVisible = () => {
    if (document.hidden) {
      hiddenSince = Date.now()
      const t = setTimeout(() => trackPresence(), AWAY_AFTER_MS + 500)
      listeners.push(() => clearTimeout(t))
    } else {
      hiddenSince = null
      trackPresence()
      void refreshChat()
      void heartbeat()
      const open = useChat.getState().openId
      if (open) void markRead(open)
    }
  }
  const onOnline = () => void flushOutbox()
  const onHide = () => beaconSeen()
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', onOnline)
  window.addEventListener('pagehide', onHide)
  listeners.push(() => document.removeEventListener('visibilitychange', onVisible))
  listeners.push(() => window.removeEventListener('online', onOnline))
  listeners.push(() => window.removeEventListener('pagehide', onHide))
}

export const stopChat = () => {
  timers.forEach(clearInterval)
  timers = []
  listeners.forEach((fn) => fn())
  listeners = []
  if (wsChannel) {
    void supabase.removeChannel(wsChannel)
    wsChannel = null
  }
  for (const ch of convChannels.values()) void supabase.removeChannel(ch)
  convChannels.clear()
  wasConnected = false
  useChat.setState({ connected: false, ready: false, companyId: null, openId: null, conversations: [], messages: {}, presence: {}, typing: {} })
}

/* ---------- the chat list ---------- */

let refreshing: Promise<void> | null = null

/** the server's view of my chats; what the live connection missed is fetched after */
export const refreshChat = async (): Promise<void> => {
  const { companyId, me } = useChat.getState()
  if (!isSupabaseEnabled || !companyId || !me) return
  if (refreshing) return refreshing
  refreshing = (async () => {
    const { data, error } = await supabase.rpc('chat_overview', { p_company: companyId })
    if (error || !data) {
      if (error && !/does not exist|not find|schema cache|42883/i.test(error.message)) console.error('[chat] refresh failed:', error.message)
      useChat.setState({ ready: true })
      return
    }
    const res = data as { conversations: ConvRow[]; people: { u: string; seen: string | null; dnd: string | null }[] }
    const s = useChat.getState()
    if (s.companyId !== companyId) return
    const fresh = (res.conversations ?? []).map((r) => rowToConversation(r, companyId))
    // my own unsent messages still count as the latest thing in a chat
    const list = fresh.map((c) => {
      const old = s.conversations.find((x) => x.id === c.id)
      if (!old) return c
      const pend = (s.messages[c.id] ?? []).filter((m) => m.pending || m.failed).slice(-1)[0]
      return pend && (!c.lastMessageAt || pend.createdAt > c.lastMessageAt)
        ? { ...c, lastMessageAt: pend.createdAt, lastMessage: { id: pend.id, senderId: pend.senderId, body: pend.body, createdAt: pend.createdAt, deleted: false } }
        : c
    })
    const lastSeen: Record<string, number> = {}
    const dnd: Record<string, number> = {}
    for (const p of res.people ?? []) {
      if (p.seen) lastSeen[p.u] = Date.parse(p.seen)
      if (p.dnd && Date.parse(p.dnd) > Date.now()) dnd[p.u] = Date.parse(p.dnd)
    }
    // chats that went away (left, removed) lose their messages
    const ids = new Set(list.map((c) => c.id))
    const messages = Object.fromEntries(Object.entries(s.messages).filter(([id]) => ids.has(id)))
    useChat.setState({ conversations: sortConversations(list), lastSeen, dnd, messages, ready: true })
    for (const c of list) joinConversation(c.id)
    for (const id of convChannels.keys()) if (!ids.has(id)) leaveConversation(id)
    // the live connection may have missed something: the open chat and any
    // chat whose latest message we do not have get their newest messages
    for (const c of list) {
      const have = messages[c.id]
      if (!have) continue
      const missing = c.lastMessage && !have.some((m) => m.id === c.lastMessage!.id)
      if (missing || c.id === s.openId) void fetchNewer(c.id)
    }
    saveCache()
    void flushOutbox()
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

/* ---------- messages ---------- */

const reactionsFor = async (ids: string[]): Promise<ReactRow[]> => {
  if (!ids.length) return []
  const { data } = await supabase.from('message_reactions').select('message_id, user_id, emoji').in('message_id', ids)
  return (data ?? []) as ReactRow[]
}

/** the latest page of a chat (or the page before `before`) */
export const fetchMessages = async (conversationId: string, before?: number) => {
  if (!isSupabaseEnabled) return
  const s = useChat.getState()
  if (s.loading[conversationId]) return
  useChat.setState({ loading: { ...s.loading, [conversationId]: true } })
  try {
    let q = supabase.from('messages').select('*').eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(PAGE)
    if (before) q = q.lt('created_at', new Date(before).toISOString())
    const { data, error } = await q
    if (error) return
    const rows = (data ?? []) as MsgRow[]
    const reacts = await reactionsFor(rows.map((r) => r.id))
    const got = rows.map((r) => rowToMessage(r, reacts))
    const cur = useChat.getState()
    const existing = cur.messages[conversationId] ?? []
    // a fresh first page replaces the cached window (the cache was only a preview)
    const base = before ? existing : existing.filter((m) => m.pending || m.failed || got.some((g) => g.id === m.id) || m.createdAt > (got[0]?.createdAt ?? 0))
    useChat.setState({
      messages: { ...cur.messages, [conversationId]: mergeMessages(base, got) },
      hasMore: { ...cur.hasMore, [conversationId]: rows.length === PAGE }
    })
    void ensurePictureUrls(got)
    saveCache()
  } finally {
    const cur = useChat.getState()
    useChat.setState({ loading: { ...cur.loading, [conversationId]: false } })
  }
}

/** anything newer than what we have (after a reconnect) */
const fetchNewer = async (conversationId: string) => {
  const list = useChat.getState().messages[conversationId]
  const newest = list?.filter((m) => !m.pending && !m.failed).slice(-1)[0]
  if (!newest) return fetchMessages(conversationId)
  const { data } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .gt('created_at', new Date(newest.createdAt).toISOString())
    .order('created_at', { ascending: true })
    .limit(200)
  const rows = (data ?? []) as MsgRow[]
  if (!rows.length) return
  const reacts = await reactionsFor(rows.map((r) => r.id))
  const cur = useChat.getState()
  const got = rows.map((r) => rowToMessage(r, reacts))
  useChat.setState({ messages: { ...cur.messages, [conversationId]: mergeMessages(cur.messages[conversationId], got) } })
  void ensurePictureUrls(got)
  if (cur.openId === conversationId && !document.hidden) void markRead(conversationId)
  saveCache()
}

/** show a chat: its messages, the "New messages" line, and tell others I'm here */
export const openConversation = (id: string | null) => {
  const s = useChat.getState()
  const conv = s.conversation(id)
  useChat.setState({ openId: id, openedAt: conv?.lastReadAt ?? 0, pendingOpen: null })
  if (id) {
    joinConversation(id)
    void fetchMessages(id).then(() => markRead(id))
    if (!s.messages[id]?.length) void markRead(id)
  }
  trackPresence()
}

const putMessage = (m: ChatMessage) => {
  const s = useChat.getState()
  const list = mergeMessages(s.messages[m.conversationId], [m])
  const conversations = sortConversations(
    s.conversations.map((c) =>
      c.id !== m.conversationId
        ? c
        : {
            ...c,
            lastMessageAt: Math.max(c.lastMessageAt ?? 0, m.createdAt),
            lastMessage: !c.lastMessage || m.createdAt >= c.lastMessage.createdAt ? { id: m.id, senderId: m.senderId, body: m.deletedAt ? '' : m.body, createdAt: m.createdAt, deleted: !!m.deletedAt, files: m.deletedAt ? 0 : m.attachments.length } : c.lastMessage
          }
    )
  )
  useChat.setState({ messages: { ...s.messages, [m.conversationId]: list }, conversations })
  saveCache()
}

const patchMessage = (conversationId: string, id: string, patch: Partial<ChatMessage>) => {
  const s = useChat.getState()
  const list = s.messages[conversationId]
  if (!list?.some((m) => m.id === id)) return
  const next = list.map((m) => (m.id === id ? { ...m, ...patch } : m))
  const conversations = s.conversations.map((c) =>
    c.id === conversationId && c.lastMessage?.id === id
      ? { ...c, lastMessage: { ...c.lastMessage, body: patch.deletedAt ? '' : (patch.body ?? c.lastMessage.body), deleted: !!patch.deletedAt || c.lastMessage.deleted } }
      : c
  )
  useChat.setState({ messages: { ...s.messages, [conversationId]: next }, conversations })
  saveCache()
}

/** files waiting to go up for a message (kept in memory for Retry) */
const filesToSend = new Map<string, PreparedFile[]>()

/** Sends a message: on screen now, saved and delivered in the background. */
export const sendMessage = async (conversationId: string, body: string, opts: { replyTo?: string; mentions?: string[]; files?: File[] } = {}) => {
  const s = useChat.getState()
  const me = s.me
  const text = body.trim()
  const files = opts.files ?? []
  if (!me || !s.companyId || (!text && !files.length)) return
  const id = crypto.randomUUID()
  // pictures are made send-ready first (resized if big), so the preview is what the others will get
  let prepared: PreparedFile[] = []
  try {
    prepared = await Promise.all(files.slice(0, 10).map((f, i) => prepareFile(f, `${s.companyId}/${conversationId}/${id}`, i + 1)))
  } catch (e) {
    throw e instanceof Error ? e : new Error('That file could not be sent.')
  }
  const urls: Record<string, string> = {}
  for (const p of prepared) urls[p.att.path] = URL.createObjectURL(p.blob)
  const msg: ChatMessage = {
    id,
    conversationId,
    senderId: me,
    body: text,
    replyTo: opts.replyTo,
    mentions: opts.mentions ?? [],
    attachments: prepared.map((p) => p.att),
    createdAt: Date.now(),
    reactions: [],
    pending: isSupabaseEnabled
  }
  useChat.setState({ urls: { ...useChat.getState().urls, ...urls } })
  putMessage(msg)
  const cur = useChat.getState()
  useChat.setState({
    conversations: cur.conversations.map((c) => (c.id === conversationId ? { ...c, lastReadAt: msg.createdAt, unread: 0, reads: { ...c.reads, [me]: msg.createdAt } } : c)),
    drafts: { ...cur.drafts, [conversationId]: '' }
  })
  if (!isSupabaseEnabled) return
  if (prepared.length) {
    filesToSend.set(id, prepared)
    if (!(await uploadFiles(id, conversationId))) return
  }
  queueMessage({ id, conversationId, body: text, replyTo: opts.replyTo, mentions: msg.mentions, attachments: msg.attachments, createdAt: msg.createdAt })
}

const queueMessage = (item: Outbox) => {
  const s = useChat.getState()
  if (!s.outbox.some((o) => o.id === item.id)) useChat.setState({ outbox: [...s.outbox, item] })
  saveOutbox()
  void flushOutbox()
}

/** puts a message's pictures and files in the bucket; false (and the message marked failed) if it couldn't */
const uploadFiles = async (id: string, conversationId: string): Promise<boolean> => {
  const list = filesToSend.get(id)
  if (!list?.length) return true
  for (const p of list) {
    const { error } = await supabase.storage.from('chat-files').upload(p.att.path, p.blob, { contentType: p.att.type, upsert: true })
    if (error && !/already exists|duplicate/i.test(error.message)) {
      console.warn('[chat] upload failed:', error.message)
      patchMessage(conversationId, id, { pending: false, failed: true })
      return false
    }
  }
  filesToSend.delete(id)
  return true
}

export const retryMessage = async (conversationId: string, id: string) => {
  const s = useChat.getState()
  const m = s.messages[conversationId]?.find((x) => x.id === id)
  if (!m) return
  patchMessage(conversationId, id, { failed: false, pending: true })
  if (filesToSend.has(id) && !(await uploadFiles(id, conversationId))) return
  if (m.attachments.length && !filesToSend.has(id) && !s.outbox.some((o) => o.id === id)) {
    // the files were lost with the page (they only live in memory): the words still go
    patchMessage(conversationId, id, { attachments: [] })
  }
  queueMessage({ id, conversationId, body: m.body, replyTo: m.replyTo, mentions: m.mentions, attachments: filesToSend.has(id) ? [] : m.attachments, createdAt: m.createdAt })
}

let flushing = false
/** Saves queued messages in order; stops at the first network problem and tries again later. */
const flushOutbox = async () => {
  if (flushing || !isSupabaseEnabled) return
  flushing = true
  try {
    for (;;) {
      const s = useChat.getState()
      const item = s.outbox[0]
      if (!item || !s.me) break
      const { error } = await supabase.from('messages').upsert(
        {
          id: item.id,
          conversation_id: item.conversationId,
          company_id: s.companyId,
          sender_id: s.me,
          body: item.body,
          reply_to: item.replyTo ?? null,
          mentions: item.mentions,
          attachments: item.attachments ?? [],
          created_at: new Date(item.createdAt).toISOString()
        },
        { onConflict: 'id', ignoreDuplicates: true }
      )
      if (error) {
        // a rule said no (not a member any more, too long…) → the message stays on screen as failed;
        // a network hiccup → keep it queued and try again when we're back online
        const permanent = Boolean((error as { code?: string }).code)
        if (!permanent) break
        console.warn('[chat] message not saved:', error.message)
        useChat.setState({ outbox: s.outbox.filter((o) => o.id !== item.id) })
        saveOutbox()
        patchMessage(item.conversationId, item.id, { pending: false, failed: true })
        continue
      }
      useChat.setState({ outbox: useChat.getState().outbox.filter((o) => o.id !== item.id) })
      saveOutbox()
      patchMessage(item.conversationId, item.id, { pending: false, failed: false })
      void broadcast(item.conversationId, 'msg', {
        id: item.id,
        conversationId: item.conversationId,
        senderId: s.me,
        body: item.body,
        replyTo: item.replyTo,
        mentions: item.mentions,
        attachments: item.attachments ?? [],
        createdAt: item.createdAt
      })
      void pushFor(item)
    }
  } finally {
    flushing = false
  }
}

/** phone/desktop alerts for everyone in the chat who isn't looking at it (the server checks mutes and DND) */
const pushFor = async (item: Outbox) => {
  try {
    const { data } = await supabase.auth.getSession()
    const jwt = data.session?.access_token
    if (!jwt) return
    const s = useChat.getState()
    const skip = Object.entries(s.presence)
      .filter(([, p]) => p.viewing === item.conversationId && p.status !== 'away')
      .map(([u]) => u)
    await fetch('/api/chat-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ conversationId: item.conversationId, messageId: item.id, skip }),
      keepalive: true
    })
  } catch {
    /* best effort */
  }
}

export const editMessage = async (conversationId: string, id: string, body: string) => {
  const text = body.trim()
  if (!text) return
  patchMessage(conversationId, id, { body: text, editedAt: Date.now() })
  if (!isSupabaseEnabled) return
  const { error } = await supabase.from('messages').update({ body: text }).eq('id', id)
  if (!error) void broadcast(conversationId, 'edit', { id, body: text, editedAt: Date.now() })
}

export const deleteMessage = async (conversationId: string, id: string) => {
  patchMessage(conversationId, id, { body: '', deletedAt: Date.now(), reactions: [], attachments: [] })
  if (!isSupabaseEnabled) return
  const { error } = await supabase.from('messages').update({ deleted_at: new Date().toISOString() }).eq('id', id)
  if (!error) void broadcast(conversationId, 'del', { id })
}

export const toggleReaction = async (conversationId: string, id: string, emoji: string) => {
  const s = useChat.getState()
  const me = s.me
  const m = s.messages[conversationId]?.find((x) => x.id === id)
  if (!me || !m) return
  const mine = m.reactions.find((r) => r.emoji === emoji)?.userIds.includes(me) ?? false
  patchMessage(conversationId, id, { reactions: applyReaction(m.reactions, emoji, me, !mine) })
  if (!isSupabaseEnabled) return
  const { error } = mine
    ? await supabase.from('message_reactions').delete().eq('message_id', id).eq('user_id', me).eq('emoji', emoji)
    : await supabase.from('message_reactions').insert({ message_id: id, user_id: me, emoji })
  if (!error) void broadcast(conversationId, 'react', { id, u: me, emoji, on: !mine })
}

const applyReaction = (list: ChatMessage['reactions'], emoji: string, u: string, on: boolean) => {
  const out = list.map((r) => ({ ...r, userIds: r.userIds.filter((x) => x !== u) }))
  if (on) {
    const r = out.find((x) => x.emoji === emoji)
    if (r) r.userIds.push(u)
    else out.push({ emoji, userIds: [u] })
  }
  return out.filter((r) => r.userIds.length)
}

/* ---------- read markers ---------- */

const readTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** everything in this chat is read (my marker moves to the latest message) */
export const markRead = async (conversationId: string) => {
  const s = useChat.getState()
  const me = s.me
  const c = s.conversation(conversationId)
  if (!me || !c) return
  const latest = Math.max(c.lastMessageAt ?? 0, ...(s.messages[conversationId] ?? []).map((m) => m.createdAt))
  if (!latest || (latest <= c.lastReadAt && !c.unread)) return
  useChat.setState({
    conversations: s.conversations.map((x) => (x.id === conversationId ? { ...x, lastReadAt: latest, unread: 0, reads: { ...x.reads, [me]: latest } } : x))
  })
  saveCache()
  if (!isSupabaseEnabled) return
  // one save per second at most, however fast messages arrive
  if (readTimers.has(conversationId)) return
  readTimers.set(
    conversationId,
    setTimeout(async () => {
      readTimers.delete(conversationId)
      const at = useChat.getState().conversation(conversationId)?.lastReadAt ?? latest
      await supabase.from('conversation_members').update({ last_read_at: new Date(at).toISOString() }).eq('conversation_id', conversationId).eq('user_id', me)
      void broadcast(conversationId, 'read', { u: me, r: at })
    }, 1000)
  )
}

/* ---------- chats: create, settings, members ---------- */

const localId = () => `local-${crypto.randomUUID()}`

/** the DM with a workspace-mate (created the first time) → its id */
export const openDm = async (userId: string): Promise<string | null> => {
  const s = useChat.getState()
  const me = s.me
  const cid = s.companyId
  if (!me || !cid) return null
  const existing = s.conversations.find((c) => c.kind === 'dm' && c.memberIds.includes(userId) && c.memberIds.includes(me))
  if (existing) return existing.id
  if (!isSupabaseEnabled) {
    const c: Conversation = { id: localId(), companyId: cid, kind: 'dm', name: '', createdAt: Date.now(), memberIds: [me, userId], reads: {}, lastReadAt: Date.now(), unread: 0, muted: false, pinned: false }
    useChat.setState({ conversations: sortConversations([c, ...s.conversations]) })
    return c.id
  }
  const { data, error } = await supabase.rpc('chat_open_dm', { p_company: cid, p_user: userId })
  if (error) throw new Error(error.message)
  await refreshChat()
  void announceConversation(data as string, [me, userId])
  return data as string
}

export const createGroup = async (name: string, userIds: string[]): Promise<string | null> => {
  const s = useChat.getState()
  const me = s.me
  const cid = s.companyId
  if (!me || !cid) return null
  if (!isSupabaseEnabled) {
    const c: Conversation = { id: localId(), companyId: cid, kind: 'group', name: name.trim(), createdBy: me, createdAt: Date.now(), memberIds: [me, ...userIds], reads: {}, lastReadAt: Date.now(), unread: 0, muted: false, pinned: false }
    useChat.setState({ conversations: sortConversations([c, ...s.conversations]) })
    return c.id
  }
  const { data, error } = await supabase.rpc('chat_create_group', { p_company: cid, p_name: name.trim(), p_users: userIds })
  if (error) throw new Error(error.message)
  await refreshChat()
  void announceConversation(data as string, [me, ...userIds])
  return data as string
}

export const addToGroup = async (conversationId: string, userIds: string[]) => {
  const s = useChat.getState()
  const c = s.conversation(conversationId)
  if (!c || !s.companyId) return
  const add = userIds.filter((u) => !c.memberIds.includes(u))
  if (!add.length) return
  useChat.setState({ conversations: s.conversations.map((x) => (x.id === conversationId ? { ...x, memberIds: [...x.memberIds, ...add] } : x)) })
  if (!isSupabaseEnabled) return
  const { error } = await supabase.from('conversation_members').insert(add.map((u) => ({ conversation_id: conversationId, user_id: u, company_id: s.companyId })))
  if (error) throw new Error(error.message)
  void announceConversation(conversationId, add)
}

export const leaveGroup = async (conversationId: string) => {
  const s = useChat.getState()
  const me = s.me
  if (!me) return
  leaveConversation(conversationId)
  useChat.setState({
    conversations: s.conversations.filter((c) => c.id !== conversationId),
    messages: Object.fromEntries(Object.entries(s.messages).filter(([id]) => id !== conversationId)),
    openId: s.openId === conversationId ? null : s.openId
  })
  saveCache()
  if (!isSupabaseEnabled) return
  await supabase.from('conversation_members').delete().eq('conversation_id', conversationId).eq('user_id', me)
}

export const renameGroup = async (conversationId: string, name: string) => {
  const s = useChat.getState()
  useChat.setState({ conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, name: name.trim() } : c)) })
  saveCache()
  if (!isSupabaseEnabled) return
  await supabase.from('conversations').update({ name: name.trim() }).eq('id', conversationId)
  void announceConversation(conversationId, s.conversation(conversationId)?.memberIds ?? [])
}

export const setMuted = async (conversationId: string, muted: boolean) => {
  const s = useChat.getState()
  useChat.setState({ conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, muted } : c)) })
  saveCache()
  if (!isSupabaseEnabled || !s.me) return
  await supabase.from('conversation_members').update({ muted }).eq('conversation_id', conversationId).eq('user_id', s.me)
}

export const setPinned = async (conversationId: string, pinned: boolean) => {
  const s = useChat.getState()
  useChat.setState({ conversations: sortConversations(s.conversations.map((c) => (c.id === conversationId ? { ...c, pinned } : c))) })
  saveCache()
  if (!isSupabaseEnabled || !s.me) return
  await supabase.from('conversation_members').update({ pinned }).eq('conversation_id', conversationId).eq('user_id', s.me)
}

export const setDraft = (conversationId: string, text: string) => {
  const s = useChat.getState()
  if ((s.drafts[conversationId] ?? '') === text) return
  useChat.setState({ drafts: { ...s.drafts, [conversationId]: text } })
  saveCache()
}

/** do not disturb until a time (null = off) — notifications wait, others see ⛔ */
export const setDnd = async (until: number | null) => {
  useChat.setState({ dndUntil: until })
  saveCache()
  trackPresence()
  const me = useChat.getState().me
  if (!isSupabaseEnabled || !me) return
  await supabase.from('chat_prefs').upsert({ user_id: me, dnd_until: until ? new Date(until).toISOString() : null, updated_at: new Date().toISOString() })
}

/* ---------- pictures and files: where to load them from ---------- */

const URL_TTL_MS = 6 * 3600_000
const urlExpiry = new Map<string, number>()
let urlsWanted = new Set<string>()
let urlTimer: ReturnType<typeof setTimeout> | null = null

/** short-lived links for these paths (batched; pictures on screen come first) */
export const ensureUrls = (paths: string[]) => {
  if (!isSupabaseEnabled) return
  const s = useChat.getState()
  const now = Date.now()
  for (const p of paths) {
    const exp = urlExpiry.get(p)
    if (s.urls[p] && (!exp || exp > now + 60_000)) continue
    urlsWanted.add(p)
  }
  if (!urlsWanted.size || urlTimer) return
  urlTimer = setTimeout(async () => {
    urlTimer = null
    const want = [...urlsWanted]
    urlsWanted = new Set()
    const { data } = await supabase.storage.from('chat-files').createSignedUrls(want, URL_TTL_MS / 1000)
    const urls: Record<string, string> = {}
    for (const row of data ?? []) {
      if (row.signedUrl && row.path) {
        urls[row.path] = row.signedUrl
        urlExpiry.set(row.path, Date.now() + URL_TTL_MS)
      }
    }
    if (Object.keys(urls).length) useChat.setState({ urls: { ...useChat.getState().urls, ...urls } })
  }, 60)
}

const ensurePictureUrls = (list: ChatMessage[]) => ensureUrls(list.flatMap((m) => m.attachments.filter((a) => isPicture(a.type)).map((a) => a.path)))

/** opens a file (a fresh link, in a new tab) */
export const openAttachment = async (att: ChatAttachment) => {
  const known = useChat.getState().urls[att.path]
  if (known && (!isSupabaseEnabled || (urlExpiry.get(att.path) ?? 0) > Date.now() + 60_000)) {
    window.open(known, '_blank', 'noopener')
    return
  }
  if (!isSupabaseEnabled) return
  const { data } = await supabase.storage.from('chat-files').createSignedUrl(att.path, 600, { download: !isPicture(att.type) ? att.name : undefined })
  if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener')
}

/* ---------- live: channels ---------- */

const broadcast = async (conversationId: string, event: string, payload: Record<string, unknown>) => {
  const ch = convChannels.get(conversationId)
  if (!ch) return
  try {
    await ch.send({ type: 'broadcast', event, payload })
  } catch {
    /* the refresh covers it */
  }
}

/** tell people a chat they're in appeared or changed (they then load it) */
const announceConversation = (id: string, memberIds: string[]) =>
  wsChannel?.send({ type: 'broadcast', event: 'conv', payload: { id, members: memberIds } }).catch(() => {})

const joinConversation = (id: string) => {
  if (!isSupabaseEnabled || convChannels.has(id)) return
  const ch = supabase
    .channel(`chat:conv:${id}`, { config: { private: true, broadcast: { self: false } } })
    .on('broadcast', { event: 'msg' }, ({ payload }) => onRemoteMessage(payload as RemoteMsg))
    .on('broadcast', { event: 'edit' }, ({ payload }) => {
      const p = payload as { id: string; body: string; editedAt: number }
      patchMessage(id, p.id, { body: p.body, editedAt: p.editedAt })
    })
    .on('broadcast', { event: 'del' }, ({ payload }) => patchMessage(id, (payload as { id: string }).id, { body: '', deletedAt: Date.now(), reactions: [], attachments: [] }))
    .on('broadcast', { event: 'react' }, ({ payload }) => {
      const p = payload as { id: string; u: string; emoji: string; on: boolean }
      const m = useChat.getState().messages[id]?.find((x) => x.id === p.id)
      if (m) patchMessage(id, p.id, { reactions: applyReaction(m.reactions, p.emoji, p.u, p.on) })
    })
    .on('broadcast', { event: 'read' }, ({ payload }) => {
      const p = payload as { u: string; r: number }
      const s = useChat.getState()
      useChat.setState({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, reads: { ...c.reads, [p.u]: Math.max(c.reads[p.u] ?? 0, p.r) } } : c)) })
    })
    .on('broadcast', { event: 'typing' }, ({ payload }) => {
      const p = payload as { u: string }
      const s = useChat.getState()
      if (p.u === s.me) return
      useChat.setState({ typing: { ...s.typing, [id]: { ...(s.typing[id] ?? {}), [p.u]: Date.now() + TYPING_MS } } })
    })
    .subscribe()
  convChannels.set(id, ch)
}

const leaveConversation = (id: string) => {
  const ch = convChannels.get(id)
  if (!ch) return
  convChannels.delete(id)
  void supabase.removeChannel(ch)
}

type RemoteMsg = { id: string; conversationId: string; senderId: string; body: string; replyTo?: string; mentions?: string[]; attachments?: ChatAttachment[]; createdAt: number }

const onRemoteMessage = (p: RemoteMsg) => {
  const s = useChat.getState()
  const me = s.me
  if (!me || p.senderId === me) return
  const c = s.conversation(p.conversationId)
  if (!c) {
    void refreshChat()
    return
  }
  const known = s.messages[p.conversationId]?.some((m) => m.id === p.id)
  if (known) return
  const msg: ChatMessage = { id: p.id, conversationId: p.conversationId, senderId: p.senderId, body: p.body, replyTo: p.replyTo, mentions: p.mentions ?? [], attachments: Array.isArray(p.attachments) ? p.attachments : [], createdAt: p.createdAt, reactions: [] }
  // a chat whose messages were never loaded only updates its preview; the rest loads when opened
  if (s.messages[p.conversationId]) {
    putMessage(msg)
    void ensurePictureUrls([msg])
  }
  else {
    useChat.setState({
      conversations: sortConversations(
        s.conversations.map((x) =>
          x.id === c.id ? { ...x, lastMessageAt: Math.max(x.lastMessageAt ?? 0, msg.createdAt), lastMessage: { id: msg.id, senderId: msg.senderId, body: msg.body, createdAt: msg.createdAt, deleted: false, files: msg.attachments.length } } : x
        )
      )
    })
  }
  const viewing = s.openId === c.id && !document.hidden
  if (viewing) {
    void markRead(c.id)
    return
  }
  const cur = useChat.getState()
  useChat.setState({
    conversations: cur.conversations.map((x) => (x.id === c.id ? { ...x, unread: x.unread + 1 } : x)),
    typing: { ...cur.typing, [c.id]: Object.fromEntries(Object.entries(cur.typing[c.id] ?? {}).filter(([u]) => u !== p.senderId)) }
  })
  saveCache()
  // a quiet heads-up for DMs and @mentions only; channels just count up
  const dnd = cur.dndUntil && cur.dndUntil > Date.now()
  const mentioned = (p.mentions ?? []).includes(me)
  if (!c.muted && !dnd && !document.hidden && (c.kind === 'dm' || mentioned)) {
    const ws = useWorkspace.getState()
    showToast({ kind: 'task', title: c.kind === 'dm' ? ws.memberName(p.senderId) : `${ws.memberName(p.senderId)} in ${conversationTitle(c, me)}`, body: (p.body || (msg.attachments.length ? 'Sent an attachment' : '')).slice(0, 140), tag: `chat-${c.id}` })
    playBeep()
  }
}

let lastTyping = 0
/** "…is typing" for the others, at most every 2.5 s */
export const sendTyping = (conversationId: string) => {
  const now = Date.now()
  if (now - lastTyping < 2500) return
  lastTyping = now
  const me = useChat.getState().me
  if (me) void broadcast(conversationId, 'typing', { u: me })
}

/* ---------- live: presence ---------- */

const openWorkspaceChannel = (companyId: string, me: string) => {
  wsChannel = supabase
    .channel(`chat:ws:${companyId}`, { config: { private: true, presence: { key: me, enabled: true } } })
    .on('presence', { event: 'sync' }, () => {
      const state = (wsChannel?.presenceState() ?? {}) as Record<string, (Presence & { user?: string })[]>
      const presence: Record<string, Presence> = {}
      for (const [key, list] of Object.entries(state)) {
        // several devices: the most awake one wins
        const rank = (p: Presence) => (p.status === 'online' ? 2 : p.status === 'dnd' ? 1 : 0)
        const best = [...list].sort((a, b) => rank(b) - rank(a))[0]
        if (best) presence[key] = { status: best.status, meetingUntil: best.meetingUntil, viewing: list.find((p) => p.viewing)?.viewing ?? null, at: best.at }
      }
      useChat.setState({ presence })
    })
    .on('broadcast', { event: 'conv' }, ({ payload }) => {
      const p = payload as { id: string; members: string[] }
      if (p.members?.includes(me)) void refreshChat()
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        useChat.setState({ connected: true })
        trackPresence()
        if (wasConnected) void refreshChat() // back after a gap: catch up
        wasConnected = true
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        useChat.setState({ connected: false })
      }
    })
}

/** the meeting I'm in right now (from my calendar), if any → when it ends */
const meetingUntil = (): number | undefined => {
  const now = Date.now()
  const today = toDateKey(new Date(now))
  for (const m of useStore.getState().meetings) {
    if (m.date !== today) continue
    const start = meetingStart(m.date, m.startMin).getTime()
    const end = start + m.durationMin * 60_000
    if (start <= now && now < end) return end
  }
  return undefined
}

const myPresence = (): Presence => {
  const s = useChat.getState()
  const dnd = s.dndUntil && s.dndUntil > Date.now()
  const away = document.hidden && hiddenSince !== null && Date.now() - hiddenSince >= AWAY_AFTER_MS
  return { status: dnd ? 'dnd' : away ? 'away' : 'online', meetingUntil: meetingUntil(), viewing: document.hidden ? null : s.openId, at: Date.now() }
}

const trackPresence = () => {
  if (!wsChannel || !useChat.getState().connected) return
  void wsChannel.track(myPresence()).catch(() => {})
}

/** "last seen": a light touch every few minutes while the app is open */
const heartbeat = async () => {
  const me = useChat.getState().me
  if (!isSupabaseEnabled || !me || document.hidden) return
  await supabase.from('chat_prefs').upsert({ user_id: me, last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() })
}

/** the same, in the last moment before the page goes away */
const beaconSeen = () => {
  const me = useChat.getState().me
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  if (!isSupabaseEnabled || !me || !url || !key) return
  void supabase.auth.getSession().then(({ data }) => {
    const jwt = data.session?.access_token
    if (!jwt) return
    return fetch(`${url}/rest/v1/chat_prefs?on_conflict=user_id`, {
      method: 'POST',
      keepalive: true,
      headers: { apikey: key, Authorization: `Bearer ${jwt}`, 'content-type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: me, last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    })
  }).catch(() => {})
}

/* ---------- small hooks for the rest of the app ---------- */

/** unread messages across chats that aren't muted (sidebar badge, home button, tab title) */
export const useChatUnread = () => useChat((s) => s.conversations.reduce((n, c) => n + (c.muted ? 0 : c.unread), 0))

/** open the Chat page on a chat (from a notification, a link or a person's card) */
export const goToConversation = (id: string) => {
  useChat.setState({ pendingOpen: id })
  useStore.getState().setView('chat')
}

/** "Message" from a person's card: their DM, opened */
export const messagePerson = async (userId: string) => {
  const id = await openDm(userId)
  if (id) goToConversation(id)
}
