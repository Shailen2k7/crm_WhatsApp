/**
 * Pieces of the Chat page: a message, the typing box (with @mentions and
 * emoji), the people picker, my status menu and the small helpers they share.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { format, isToday, isYesterday } from 'date-fns'
import { AlertCircle, Check, CheckCheck, CornerUpLeft, Download, File as FileIcon, FileArchive, FileSpreadsheet, FileText, Film, Music, Paperclip, Pencil, Presentation, Search, SendHorizontal, Smile, SmilePlus, Trash2, X } from 'lucide-react'
import Modal from './Modal'
import { Avatar } from './HomeParts'
import { initialsOf, useWorkspace } from '../lib/workspace'
import { editMessage, ensureUrls, localTimeFor, openAttachment, sendMessage, sendTyping, setDnd, setDraft, statusOf, toggleReaction, useChat } from '../lib/chat'
import { fileKind, fmtSize, isPicture, MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE } from '../lib/chatFiles'
import { isCompactDevice } from '../lib/device'
import type { ChatAttachment, ChatMessage, Conversation, Member } from '../types'

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅']

const EMOJI: { label: string; list: string }[] = [
  { label: 'Smileys', list: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😍 🥰 😘 😋 😛 😜 🤪 🤔 🤫 🤭 😐 😑 😶 🙄 😏 😣 😥 😮 🤐 😯 😪 😫 🥱 😴 😌 😔 😕 🙁 ☹️ 😖 😞 😟 😤 😢 😭 😱 😳 🥺 😬 🤯 😎 🤓 🧐 🥳 🤩 😷 🤒 🤕 🤠 😈' },
  { label: 'Gestures', list: '👍 👎 👏 🙌 🤝 🙏 👋 🤙 💪 ✌️ 🤞 🤟 👌 🤌 👈 👉 👆 👇 ☝️ ✋ 🖐️ 🤚 🖖 👀 👁️ 🧠 🫶 🫡' },
  { label: 'Hearts', list: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 ✨ ⭐ 🌟 💫 🔥 💯 🎉 🎊 🎈 🎁 🏆 🥇' },
  { label: 'Work', list: '✅ ❌ ⚠️ ❓ ❗ 💡 📌 📎 📅 🗓️ ⏰ ⏳ 📈 📉 📊 💼 📝 ✏️ 📣 🔔 🔕 🔒 🔑 🚀 🛠️ ⚙️ 🧩 🎯 🏁 🧾 💬 📞 ☕ 🍕 🍰 🎂 🌴 ✈️ 🏠 🚗' }
]

/* ---------- time + text helpers ---------- */

/** "Today", "Yesterday", "Mon 2 Nov" */
export const dayLabel = (t: number) => (isToday(t) ? 'Today' : isYesterday(t) ? 'Yesterday' : format(t, 'EEE d MMM'))

export const clock = (t: number) => format(t, 'h:mm a')

/** chat list: time today, day name this week, else a date */
export const listTime = (t: number) => {
  if (isToday(t)) return clock(t)
  if (Date.now() - t < 6 * 864e5) return format(t, 'EEE')
  return format(t, 'd MMM')
}

/** "2h ago", "3 days ago" for Last seen */
export const agoLabel = (t: number) => {
  const m = Math.max(1, Math.round((Date.now() - t) / 60_000))
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

/** what to say about a person right now, for headers and the members list */
export const presenceText = (userId: string): string => {
  const st = statusOf(userId)
  if (st.meetingUntil) return `In a meeting until ${clock(st.meetingUntil)}`
  if (st.status === 'online') return 'Online'
  if (st.status === 'dnd') return 'Do not disturb'
  if (st.status === 'away') return 'Away'
  return st.lastSeen ? `Last seen ${agoLabel(st.lastSeen)}` : 'Offline'
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const URL_RE = /((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)"'\]])/g

/** message text → links clickable, @mentions highlighted, line breaks kept */
export const renderBody = (text: string, members: Member[], me: string | null): ReactNode => {
  const names = members
    .flatMap((m) => [m.name, m.name.split(/\s+/)[0]])
    .filter((n) => n && n.length > 1)
    .sort((a, b) => b.length - a.length)
  const mentionRe = names.length ? new RegExp(`@(${names.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'gu') : null
  const meNames = new Set(members.filter((m) => m.userId === me).flatMap((m) => [m.name, m.name.split(/\s+/)[0]]))
  const out: ReactNode[] = []
  let k = 0
  const pushText = (s: string) => {
    // links inside plain text
    let last = 0
    for (const m of s.matchAll(URL_RE)) {
      const i = m.index ?? 0
      if (i > last) out.push(s.slice(last, i))
      const href = m[1].startsWith('http') ? m[1] : `https://${m[1]}`
      out.push(
        <a key={k++} href={href} target="_blank" rel="noreferrer noopener" className="ch-link">
          {m[1]}
        </a>
      )
      last = i + m[1].length
    }
    if (last < s.length) out.push(s.slice(last))
  }
  if (!mentionRe) pushText(text)
  else {
    let last = 0
    for (const m of text.matchAll(mentionRe)) {
      const i = m.index ?? 0
      if (i > last) pushText(text.slice(last, i))
      out.push(
        <span key={k++} className={`ch-mention${meNames.has(m[1]) ? ' me' : ''}`}>
          @{m[1]}
        </span>
      )
      last = i + m[0].length
    }
    if (last < text.length) pushText(text.slice(last))
  }
  return out
}

/* ---------- presence dot ---------- */

export function PresenceDot({ userId, size = 10 }: { userId: string; size?: number }) {
  const presence = useChat((s) => s.presence[userId])
  const dnd = useChat((s) => s.dnd[userId])
  void presence
  void dnd
  const st = statusOf(userId)
  const cls = st.meetingUntil ? 'meeting' : st.status
  return <i className={`ch-dot ${cls}`} style={{ width: size, height: size }} title={presenceText(userId)} />
}

/** a person's picture with their live state on it */
export function PersonAvatar({ userId, size = 34 }: { userId: string; size?: number }) {
  const m = useWorkspace((s) => s.member(userId))
  return (
    <span className="ch-pav" style={{ width: size, height: size, ['--s' as string]: `${size}px` }}>
      <Avatar name={m?.name ?? 'Former member'} email={m?.email} size={size} />
      <PresenceDot userId={userId} size={Math.max(9, Math.round(size * 0.3))} />
    </span>
  )
}

/** the little picture of a chat in the list and header */
export function ConversationAvatar({ c, me, size = 40 }: { c: Conversation; me: string | null; size?: number }) {
  const teams = useWorkspace((s) => s.teams)
  const members = useWorkspace((s) => s.members)
  if (c.kind === 'dm') return <PersonAvatar userId={c.memberIds.find((u) => u !== me) ?? c.memberIds[0]} size={size} />
  if (c.kind === 'general') return <span className="ch-tile general" style={{ width: size, height: size, fontSize: size * 0.48 }}>#</span>
  if (c.kind === 'team') {
    const color = teams.find((t) => t.id === c.teamId)?.color
    return <span className="ch-tile team" style={{ width: size, height: size, fontSize: size * 0.48, ...(color ? { ['--c' as string]: color } : {}) }}>#</span>
  }
  const two = c.memberIds.filter((u) => u !== me).slice(0, 2).map((u) => members.find((m) => m.userId === u))
  return (
    <span className="ch-tile group" style={{ width: size, height: size }}>
      {two.map((m, i) => (
        <span key={i} className="ch-tile-half" style={{ fontSize: size * 0.28 }}>
          {initialsOf(m?.name ?? '', m?.email ?? '?')}
        </span>
      ))}
    </span>
  )
}

/* ---------- pictures and files ---------- */

const KIND_ICON = { pdf: FileText, doc: FileText, sheet: FileSpreadsheet, slides: Presentation, zip: FileArchive, video: Film, audio: Music, file: FileIcon }

/** a file chip: icon, name, size — opens in a new tab */
export function FileChip({ att, onRemove }: { att: ChatAttachment; onRemove?: () => void }) {
  const kind = fileKind(att)
  const Icon = KIND_ICON[kind]
  return (
    <span className={`ch-file k-${kind}`}>
      <button className="ch-file-main" onClick={() => void openAttachment(att)} title={att.name}>
        <span className="ch-file-ico">
          <Icon size={18} />
        </span>
        <span className="ch-file-text">
          <b>{att.name}</b>
          <small>{fmtSize(att.size)}</small>
        </span>
      </button>
      {onRemove ? (
        <button className="ch-file-x" onClick={onRemove} aria-label="Remove">
          <X size={13} />
        </button>
      ) : (
        <button className="ch-file-x dl" onClick={() => void openAttachment(att)} aria-label="Download">
          <Download size={14} />
        </button>
      )}
    </span>
  )
}

/** pictures in a grid, files as chips; a picture opens full screen */
export function Attachments({ atts }: { atts: ChatAttachment[] }) {
  const urls = useChat((s) => s.urls)
  const [view, setView] = useState<ChatAttachment | null>(null)
  const pics = atts.filter((a) => isPicture(a.type))
  const files = atts.filter((a) => !isPicture(a.type))
  useEffect(() => {
    ensureUrls(pics.map((p) => p.path))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atts])
  return (
    <>
      {pics.length > 0 && (
        <div className={`ch-pics n${Math.min(pics.length, 4)}`}>
          {pics.map((p) => {
            const url = urls[p.path]
            const ratio = p.w && p.h ? p.w / p.h : 4 / 3
            return (
              <button key={p.path} className="ch-pic" style={pics.length === 1 ? { aspectRatio: String(Math.min(2.2, Math.max(0.6, ratio))) } : undefined} onClick={() => url && setView(p)} aria-label={p.name}>
                {url ? <img src={url} alt={p.name} loading="lazy" decoding="async" /> : <span className="ch-pic-wait" />}
              </button>
            )
          })}
        </div>
      )}
      {files.length > 0 && (
        <div className="ch-files">
          {files.map((f) => (
            <FileChip key={f.path} att={f} />
          ))}
        </div>
      )}
      {view && <Lightbox att={view} all={pics} onChange={setView} onClose={() => setView(null)} />}
    </>
  )
}

function Lightbox({ att, all, onChange, onClose }: { att: ChatAttachment; all: ChatAttachment[]; onChange: (a: ChatAttachment) => void; onClose: () => void }) {
  const url = useChat((s) => s.urls[att.path])
  const i = all.findIndex((a) => a.path === att.path)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight' && i < all.length - 1) onChange(all[i + 1])
      if (e.key === 'ArrowLeft' && i > 0) onChange(all[i - 1])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [i, all, onChange, onClose])
  return (
    <div className="ch-lightbox" onClick={onClose} role="dialog" aria-label={att.name}>
      <div className="ch-lightbox-top" onClick={(e) => e.stopPropagation()}>
        <span>
          <b>{att.name}</b>
          <small>
            {fmtSize(att.size)}
            {all.length > 1 ? ` · ${i + 1} of ${all.length}` : ''}
          </small>
        </span>
        <button className="ch-ico" onClick={() => void openAttachment(att)} aria-label="Open original" title="Open original">
          <Download size={18} />
        </button>
        <button className="ch-ico" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>
      </div>
      {url && <img src={url} alt={att.name} onClick={(e) => e.stopPropagation()} />}
      {all.length > 1 && (
        <div className="ch-lightbox-nav" onClick={(e) => e.stopPropagation()}>
          <button disabled={i <= 0} onClick={() => onChange(all[i - 1])} aria-label="Previous">
            ‹
          </button>
          <button disabled={i >= all.length - 1} onClick={() => onChange(all[i + 1])} aria-label="Next">
            ›
          </button>
        </div>
      )}
    </div>
  )
}

/* ---------- one message ---------- */

interface RowProps {
  m: ChatMessage
  c: Conversation
  me: string
  /** same sender as the message above, close in time */
  cont: boolean
  members: Member[]
  isAdmin: boolean
  replyTarget?: ChatMessage
  onReply: (m: ChatMessage) => void
  onEdit: (m: ChatMessage) => void
  onMenu: (m: ChatMessage) => void
  onDelete: (m: ChatMessage) => void
  onJump: (id: string) => void
}

export function MessageRow({ m, c, me, cont, members, isAdmin, replyTarget, onReply, onEdit, onMenu, onDelete, onJump }: RowProps) {
  const ws = useWorkspace.getState()
  const mine = m.senderId === me
  const [picker, setPicker] = useState(false)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canDelete = mine || (isAdmin && (c.kind === 'team' || c.kind === 'general'))
  const seenBy = mine ? c.memberIds.filter((u) => u !== me && (c.reads[u] ?? 0) >= m.createdAt) : []

  const startPress = () => {
    if (!isCompactDevice() || m.deletedAt) return
    pressTimer.current = setTimeout(() => onMenu(m), 450)
  }
  const endPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current)
    pressTimer.current = null
  }

  return (
    <div
      className={`ch-m${mine ? ' mine' : ''}${cont ? ' cont' : ''}${m.deletedAt ? ' gone' : ''}${m.mentions.includes(me) ? ' at-me' : ''}`}
      data-id={m.id}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onPointerMove={endPress}
      onContextMenu={(e) => {
        if (isCompactDevice()) e.preventDefault()
      }}
    >
      {!mine && <span className="ch-m-av">{!cont && <PersonAvatar userId={m.senderId} size={30} />}</span>}
      <div className="ch-m-body">
        {!cont && !mine && <div className="ch-m-who">{ws.memberName(m.senderId)}</div>}
        <div className={`ch-bubble${m.attachments.length ? ' has-att' : ''}${m.attachments.length && !m.body && !m.deletedAt ? ' media' : ''}`}>
          {m.attachments.length > 0 && !m.deletedAt && <Attachments atts={m.attachments} />}
          {m.replyTo && (
            <button className="ch-quote" onClick={() => replyTarget && onJump(replyTarget.id)}>
              <b>{replyTarget ? ws.memberName(replyTarget.senderId) : 'Message'}</b>
              <span>{replyTarget ? (replyTarget.deletedAt ? 'Message removed' : replyTarget.body) : 'No longer available'}</span>
            </button>
          )}
          {(m.body || m.deletedAt || !m.attachments.length) && (
            <div className="ch-text">
              {m.deletedAt ? <i>Message removed</i> : renderBody(m.body, members, me)}
              {m.editedAt && !m.deletedAt && <small className="ch-edited"> (edited)</small>}
            </div>
          )}
          <span className="ch-m-time">
            {clock(m.createdAt)}
            {mine && !m.deletedAt && (m.failed ? <AlertCircle size={12} className="bad" /> : m.pending ? <Check size={12} /> : <CheckCheck size={12} className={seenBy.length ? 'seen' : ''} />)}
          </span>
        </div>
        {m.reactions.length > 0 && (
          <div className="ch-reacts">
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                className={`ch-react${r.userIds.includes(me) ? ' on' : ''}`}
                onClick={() => void toggleReaction(c.id, m.id, r.emoji)}
                title={r.userIds.map((u) => ws.memberName(u)).join(', ')}
              >
                {r.emoji} <b>{r.userIds.length}</b>
              </button>
            ))}
          </div>
        )}
        {m.failed && (
          <div className="ch-failed">
            Not sent · <button onClick={() => onMenu(m)}>Retry</button>
          </div>
        )}
      </div>
      {!m.deletedAt && !m.failed && (
        <div className="ch-m-acts">
          <button onClick={() => setPicker((v) => !v)} aria-label="React" title="React">
            <SmilePlus size={15} />
          </button>
          <button onClick={() => onReply(m)} aria-label="Reply" title="Reply">
            <CornerUpLeft size={15} />
          </button>
          {mine && (m.body || !m.attachments.length) && (
            <button onClick={() => onEdit(m)} aria-label="Edit" title="Edit">
              <Pencil size={15} />
            </button>
          )}
          {canDelete && (
            <button onClick={() => onDelete(m)} aria-label="Delete" title="Delete">
              <Trash2 size={15} />
            </button>
          )}
          {picker && (
            <div className="ch-quick" onMouseLeave={() => setPicker(false)}>
              {QUICK_REACTIONS.map((e) => (
                <button
                  key={e}
                  onClick={() => {
                    setPicker(false)
                    void toggleReaction(c.id, m.id, e)
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** "Seen" / "Seen by Priya and Wen" under my latest message */
export function SeenLine({ c, m, me }: { c: Conversation; m: ChatMessage; me: string }) {
  const ws = useWorkspace.getState()
  const seen = c.memberIds.filter((u) => u !== me && (c.reads[u] ?? 0) >= m.createdAt)
  if (!seen.length) return null
  if (c.kind === 'dm') return <div className="ch-seen">Seen {clock(c.reads[seen[0]])}</div>
  const names = seen.slice(0, 3).map((u) => ws.memberName(u).split(' ')[0])
  return <div className="ch-seen">Seen by {names.join(', ')}{seen.length > 3 ? ` +${seen.length - 3}` : ''}</div>
}

/* ---------- emoji picker ---------- */

const RECENT_KEY = 'msos-emoji-recent'
const recentEmoji = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}
const rememberEmoji = (e: string) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recentEmoji().filter((x) => x !== e)].slice(0, 16)))
  } catch {
    /* ignore */
  }
}

export function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const recent = useMemo(recentEmoji, [])
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  const pick = (e: string) => {
    rememberEmoji(e)
    onPick(e)
  }
  const groups = recent.length ? [{ label: 'Recent', list: recent.join(' ') }, ...EMOJI] : EMOJI
  return (
    <div className="ch-emoji" ref={ref} role="dialog" aria-label="Emoji">
      {groups.map((g) => (
        <div key={g.label} className="ch-emoji-group">
          <div className="ch-emoji-label">{g.label}</div>
          <div className="ch-emoji-grid">
            {g.list.split(' ').map((e, i) => (
              <button key={`${e}-${i}`} onClick={() => pick(e)}>
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---------- the typing box ---------- */

interface ComposerProps {
  c: Conversation
  me: string
  members: Member[]
  replyTo: ChatMessage | null
  onCancelReply: () => void
  editing: ChatMessage | null
  onDoneEdit: () => void
  onSent: () => void
  /** pictures and files waiting to go with the next message */
  files: File[]
  onFiles: (add: File[]) => void
  onRemoveFile: (index: number) => void
  onClearFiles: () => void
}

/** files from a picker, a paste or a drop → the ones we can send, and why not for the rest */
export const acceptFiles = (list: FileList | File[] | null | undefined, have: number): { ok: File[]; problem?: string } => {
  const all = [...(list ?? [])].filter((f) => f && f.size > 0)
  const room = MAX_FILES_PER_MESSAGE - have
  const tooBig = all.filter((f) => f.size > MAX_FILE_BYTES)
  const ok = all.filter((f) => f.size <= MAX_FILE_BYTES).slice(0, Math.max(0, room))
  let problem: string | undefined
  if (tooBig.length) problem = `${tooBig[0].name} is bigger than 25 MB.`
  else if (all.length > room) problem = `Up to ${MAX_FILES_PER_MESSAGE} files per message.`
  return { ok, problem }
}

/** a thumbnail (pictures) or a chip (files) in the strip above the typing box */
function PendingFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const pic = isPicture(file.type)
  useEffect(() => {
    if (!pic) return
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file, pic])
  if (pic)
    return (
      <span className="ch-pend pic">
        {url && <img src={url} alt={file.name} />}
        <button className="ch-file-x" onClick={onRemove} aria-label="Remove">
          <X size={13} />
        </button>
      </span>
    )
  return <FileChip att={{ path: '', name: file.name, size: file.size, type: file.type }} onRemove={onRemove} />
}

/** the "@pri" being typed right before the cursor, if any */
const mentionAt = (text: string, caret: number): { start: number; query: string } | null => {
  const m = /(^|\s)@([\p{L}\p{N}._-]*)$/u.exec(text.slice(0, caret))
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null
}

export function Composer({ c, me, members, replyTo, onCancelReply, editing, onDoneEdit, onSent, files, onFiles, onRemoveFile, onClearFiles }: ComposerProps) {
  const draft = useChat((s) => s.drafts[c.id] ?? '')
  const [text, setText] = useState(editing ? editing.body : draft)
  const [emoji, setEmoji] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const addFiles = (list: FileList | File[] | null | undefined) => {
    const r = acceptFiles(list, files.length)
    if (r.ok.length) onFiles(r.ok)
    setProblem(r.problem ?? null)
  }
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [sel, setSel] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const mentioned = useRef(new Map<string, string>()) // userId → "@Name" inserted
  const touch = isCompactDevice()
  const others = useMemo(() => members.filter((m) => m.userId !== me && (c.kind === 'general' || c.memberIds.includes(m.userId))), [members, me, c])

  // another chat, or edit mode: the box shows that chat's draft or the message
  useEffect(() => {
    setText(editing ? editing.body : useChat.getState().drafts[c.id] ?? '')
    setMention(null)
    mentioned.current.clear()
    if (editing || !touch) setTimeout(() => ref.current?.focus(), 30)
  }, [c.id, editing, touch])

  useEffect(() => {
    if (replyTo && !touch) ref.current?.focus()
  }, [replyTo, touch])

  // grows with the text, up to about six lines
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(160, Math.max(24, el.scrollHeight))}px`
  }, [text])

  const candidates = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    return others
      .filter((m) => {
        if (!q) return true
        const words = [...m.name.toLowerCase().split(/\s+/), m.email.toLowerCase(), m.name.toLowerCase().replace(/\s+/g, '')]
        return words.some((w) => w.startsWith(q))
      })
      .slice(0, 6)
  }, [mention, others])

  const change = (v: string) => {
    setText(v)
    if (!editing) setDraft(c.id, v)
    const caret = ref.current?.selectionStart ?? v.length
    const at = mentionAt(v, caret)
    setMention(at)
    setSel(0)
    if (v.trim() && !editing) sendTyping(c.id)
  }

  const insertAt = (start: number, end: number, s: string) => {
    const v = text.slice(0, start) + s + text.slice(end)
    change(v)
    setTimeout(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.setSelectionRange(start + s.length, start + s.length)
    }, 0)
  }

  const pickMention = (m: Member) => {
    if (!mention) return
    const caret = ref.current?.selectionStart ?? text.length
    const label = `@${m.name || m.email.split('@')[0]}`
    mentioned.current.set(m.userId, label)
    insertAt(mention.start, caret, `${label} `)
    setMention(null)
  }

  const submit = async () => {
    const body = text.trim()
    if (!body && !files.length) return
    if (editing) {
      await editMessage(c.id, editing.id, body)
      onDoneEdit()
      setText('')
      return
    }
    const mentions = [...mentioned.current].filter(([, label]) => body.includes(label)).map(([u]) => u)
    if (/@everyone\b/i.test(body) && c.kind !== 'dm') c.memberIds.filter((u) => u !== me).forEach((u) => mentions.push(u))
    const sending = files
    setText('')
    mentioned.current.clear()
    setMention(null)
    setProblem(null)
    onClearFiles()
    sendMessage(c.id, body, { replyTo: replyTo?.id, mentions: [...new Set(mentions)], files: sending }).catch((e: unknown) => setProblem(e instanceof Error ? e.message : 'That could not be sent.'))
    onCancelReply()
    onSent()
    if (!touch) ref.current?.focus()
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && candidates.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((i) => (i + 1) % candidates.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((i) => (i - 1 + candidates.length) % candidates.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickMention(candidates[sel])
        return
      }
      if (e.key === 'Escape') {
        setMention(null)
        return
      }
    }
    if (e.key === 'Escape' && editing) {
      onDoneEdit()
      return
    }
    if (e.key === 'Escape' && replyTo) {
      onCancelReply()
      return
    }
    // desktop: Enter sends, Shift+Enter is a new line; phones use the button
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  // "9:40 PM for Wen — they may be asleep"
  const partner = c.kind === 'dm' ? members.find((m) => m.userId !== me && c.memberIds.includes(m.userId)) : undefined
  const local = partner ? localTimeFor(partner.timezone) : null
  const night = local && (local.hour >= 22 || local.hour < 7)
  const ws = useWorkspace.getState()

  return (
    <div className="ch-composer">
      {night && partner && (
        <div className="ch-night">
          It’s {local!.time} for {partner.name.split(' ')[0]} — they may be asleep. Your message will wait for them.
        </div>
      )}
      {replyTo && !editing && (
        <div className="ch-replying">
          <CornerUpLeft size={14} />
          <span>
            Replying to <b>{ws.memberName(replyTo.senderId)}</b>: {replyTo.body.slice(0, 80)}
          </span>
          <button onClick={onCancelReply} aria-label="Cancel reply">
            <X size={14} />
          </button>
        </div>
      )}
      {editing && (
        <div className="ch-replying edit">
          <Pencil size={14} />
          <span>Editing your message</span>
          <button onClick={onDoneEdit} aria-label="Cancel edit">
            <X size={14} />
          </button>
        </div>
      )}
      {files.length > 0 && !editing && (
        <div className="ch-pending">
          {files.map((f, i) => (
            <PendingFile key={`${f.name}-${f.size}-${i}`} file={f} onRemove={() => onRemoveFile(i)} />
          ))}
        </div>
      )}
      {problem && <div className="ch-err ch-err-line">{problem}</div>}
      <div className="ch-box">
        <button className="ch-ico" onClick={() => setEmoji((v) => !v)} aria-label="Emoji" title="Emoji">
          <Smile size={20} />
        </button>
        {!editing && (
          <>
            <button className="ch-ico" onClick={() => fileRef.current?.click()} aria-label="Attach a picture or file" title="Attach">
              <Paperclip size={19} />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={c.kind === 'dm' && partner ? `Message ${partner.name.split(' ')[0]}` : c.kind === 'group' ? 'Message the group' : 'Message everyone here'}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKey}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files]
            if (pasted.length && !editing) {
              e.preventDefault()
              addFiles(pasted)
            }
          }}
          onClick={() => setMention(mentionAt(text, ref.current?.selectionStart ?? text.length))}
          aria-label="Message"
          enterKeyHint={touch ? 'enter' : 'send'}
        />
        <button className={`ch-send${text.trim() || files.length ? ' on' : ''}`} onClick={() => void submit()} disabled={!text.trim() && !files.length} aria-label={editing ? 'Save' : 'Send'}>
          {editing ? <Check size={18} /> : <SendHorizontal size={18} />}
        </button>
        {emoji && (
          <EmojiPicker
            onClose={() => setEmoji(false)}
            onPick={(e) => {
              const el = ref.current
              const start = el?.selectionStart ?? text.length
              const end = el?.selectionEnd ?? text.length
              insertAt(start, end, e)
            }}
          />
        )}
        {mention && candidates.length > 0 && (
          <div className="ch-mentions" role="listbox">
            {candidates.map((m, i) => (
              <button key={m.userId} role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pickMention(m)}>
                <PersonAvatar userId={m.userId} size={26} />
                <span>
                  <b>{m.name || m.email}</b>
                  <small>{presenceText(m.userId)}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {!touch && <div className="ch-hint">Enter to send · Shift+Enter for a new line · @ to mention · paste or drop pictures and files</div>}
    </div>
  )
}

/* ---------- people picker (new chat · add people) ---------- */

interface PickerProps {
  title: string
  /** people already in (hidden from the list) */
  exclude: string[]
  /** a group name field appears when more than one person is picked */
  naming?: boolean
  action: string
  onClose: () => void
  onDone: (userIds: string[], name: string) => Promise<void> | void
}

export function PeoplePicker({ title, exclude, naming, action, onClose, onDone }: PickerProps) {
  const members = useWorkspace((s) => s.members)
  const me = useWorkspace((s) => s.me)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const list = members.filter((m) => m.userId !== me && !exclude.includes(m.userId) && (!q || `${m.name} ${m.email}`.toLowerCase().includes(q.toLowerCase())))
  const toggle = (u: string) => setPicked((p) => (p.includes(u) ? p.filter((x) => x !== u) : [...p, u]))
  const go = async () => {
    if (!picked.length) return
    setBusy(true)
    setErr(null)
    try {
      await onDone(picked, name)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void go()} disabled={!picked.length || busy}>
            {busy ? 'One moment…' : action}
          </button>
        </>
      }
    >
      <div className="ch-pick">
        <label className="ch-pick-search">
          <Search size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" autoFocus={!isCompactDevice()} />
        </label>
        {picked.length > 0 && (
          <div className="ch-chips">
            {picked.map((u) => {
              const m = members.find((x) => x.userId === u)
              return (
                <button key={u} className="ch-chip" onClick={() => toggle(u)}>
                  {m?.name.split(' ')[0] || m?.email.split('@')[0]} <X size={12} />
                </button>
              )
            })}
          </div>
        )}
        {naming && picked.length > 1 && <input className="ch-pick-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name (optional)" maxLength={80} />}
        <div className="ch-pick-list">
          {list.length === 0 && <div className="ch-pick-empty">{members.length <= 1 ? 'Invite people to the workspace first.' : 'Nobody matches.'}</div>}
          {list.map((m) => (
            <button key={m.userId} className={`ch-pick-row${picked.includes(m.userId) ? ' on' : ''}`} onClick={() => toggle(m.userId)} role="checkbox" aria-checked={picked.includes(m.userId)}>
              <PersonAvatar userId={m.userId} size={32} />
              <span className="ch-pick-text">
                <b>{m.name || m.email}</b>
                <small>{presenceText(m.userId)}</small>
              </span>
              <span className="ch-pick-box">{picked.includes(m.userId) && <Check size={14} />}</span>
            </button>
          ))}
        </div>
        {err && <div className="ch-err">{err}</div>}
      </div>
    </Modal>
  )
}

/* ---------- my status ---------- */

export function StatusMenu() {
  const me = useWorkspace((s) => s.me)
  const dndUntil = useChat((s) => s.dndUntil)
  const connected = useChat((s) => s.connected)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const dnd = !!dndUntil && dndUntil > Date.now()
  const label = dnd ? `Do not disturb until ${clock(dndUntil!)}` : connected ? 'Online' : 'Connecting…'
  const tomorrow9 = () => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  }
  return (
    <div className="ch-status" ref={ref}>
      <button className="ch-status-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        {me && <PresenceDot userId={me} size={9} />}
        <span>{label}</span>
      </button>
      {open && (
        <div className="ch-status-menu" role="menu">
          <button role="menuitem" className={!dnd ? 'on' : ''} onClick={() => (setOpen(false), void setDnd(null))}>
            <i className="ch-dot online" /> Online
          </button>
          <div className="ch-status-sep">Do not disturb</div>
          <button role="menuitem" onClick={() => (setOpen(false), void setDnd(Date.now() + 3600_000))}>
            <i className="ch-dot dnd" /> For 1 hour
          </button>
          <button role="menuitem" onClick={() => (setOpen(false), void setDnd(tomorrow9()))}>
            <i className="ch-dot dnd" /> Until tomorrow 9:00 AM
          </button>
          <button role="menuitem" onClick={() => (setOpen(false), void setDnd(Date.now() + 7 * 864e5))}>
            <i className="ch-dot dnd" /> Until I turn it off
          </button>
          <div className="ch-status-note">Notifications wait while it’s on. Others see ⛔ next to your name.</div>
        </div>
      )}
    </div>
  )
}
