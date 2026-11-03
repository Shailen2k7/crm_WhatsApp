/**
 * Chat: everyone in the workspace, live.
 *
 * Desktop: the chat list on the left, the conversation in the middle, details
 * on the right (toggled). Phones: the list, then the conversation full screen.
 * The data and the live connection live in lib/chat.ts; this file is the screen.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, Bell, BellOff, ChevronRight, CornerUpLeft, Hash, Info, LogOut, MessageSquarePlus, Pencil, Pin, PinOff, Search, SmilePlus, Trash2, UserPlus, Users, X } from 'lucide-react'
import Modal from '../components/Modal'
import { useWorkspace } from '../lib/workspace'
import {
  addToGroup,
  conversationTitle,
  createGroup,
  deleteMessage,
  fetchMessages,
  leaveGroup,
  localTimeFor,
  markRead,
  openConversation,
  openDm,
  renameGroup,
  retryMessage,
  setMuted,
  setPinned,
  toggleReaction,
  useChat
} from '../lib/chat'
import { isSupabaseEnabled } from '../lib/supabase'
import { isCompactDevice } from '../lib/device'
import { acceptFiles, Composer, ConversationAvatar, dayLabel, EmojiPicker, listTime, MessageRow, PeoplePicker, PersonAvatar, presenceText, QUICK_REACTIONS, SeenLine, StatusMenu } from '../components/ChatParts'
import { attachmentsLabel } from '../lib/chatFiles'
import type { ChatMessage, Conversation } from '../types'
import './chat.css'

/** the chat that was open when the page was left (desktop reopens it) */
let lastOpen: string | null = null

const GROUP_GAP_MS = 5 * 60_000

export default function ChatView() {
  const ready = useChat((s) => s.ready)
  const openId = useChat((s) => s.openId)
  const pendingOpen = useChat((s) => s.pendingOpen)
  const conversations = useChat((s) => s.conversations)
  const [newChat, setNewChat] = useState(false)
  const [info, setInfo] = useState(false)
  const compact = isCompactDevice()

  // a link, a tapped notification, "Message" on a person: open that chat
  useEffect(() => {
    if (pendingOpen) {
      openConversation(pendingOpen)
      return
    }
    if (!openId && lastOpen && !compact && conversations.some((c) => c.id === lastOpen)) openConversation(lastOpen)
  }, [pendingOpen, openId, compact, conversations])

  // leaving the page: others no longer see me "in" this chat
  useEffect(
    () => () => {
      lastOpen = useChat.getState().openId
      openConversation(null)
    },
    []
  )

  // "+ New → Message" from the sidebar
  useEffect(() => {
    const onNew = () => setNewChat(true)
    window.addEventListener('msos:chat-new', onNew)
    return () => window.removeEventListener('msos:chat-new', onNew)
  }, [])

  const open = conversations.find((c) => c.id === openId) ?? null

  return (
    <div className={`ch${open ? ' has-open' : ''}${info && open ? ' has-info' : ''}`}>
      <ChatList onNew={() => setNewChat(true)} />
      {open ? <Thread c={open} onInfo={() => setInfo((v) => !v)} info={info} /> : <NoChat ready={ready} onNew={() => setNewChat(true)} />}
      {open && info && (compact ? <Modal title="Details" onClose={() => setInfo(false)}><InfoPane c={open} onClose={() => setInfo(false)} /></Modal> : <aside className="ch-info"><InfoPane c={open} onClose={() => setInfo(false)} /></aside>)}
      {newChat && (
        <PeoplePicker
          title="New message"
          exclude={[]}
          naming
          action="Start chat"
          onClose={() => setNewChat(false)}
          onDone={async (ids, name) => {
            const id = ids.length === 1 ? await openDm(ids[0]) : await createGroup(name, ids)
            if (id) openConversation(id)
          }}
        />
      )}
    </div>
  )
}

/* ================= the list ================= */

function ChatList({ onNew }: { onNew: () => void }) {
  const conversations = useChat((s) => s.conversations)
  const openId = useChat((s) => s.openId)
  const ready = useChat((s) => s.ready)
  const me = useChat((s) => s.me)
  const typing = useChat((s) => s.typing)
  const members = useWorkspace((s) => s.members)
  const [q, setQ] = useState('')
  void members // names change → re-render

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle ? conversations.filter((c) => conversationTitle(c, me).toLowerCase().includes(needle)) : conversations
    return {
      pinned: list.filter((c) => c.pinned),
      channels: list.filter((c) => !c.pinned && (c.kind === 'team' || c.kind === 'general')),
      direct: list.filter((c) => !c.pinned && (c.kind === 'dm' || c.kind === 'group'))
    }
  }, [conversations, q, me])

  const section = (label: string, list: Conversation[]) =>
    list.length > 0 && (
      <div className="ch-sec" key={label}>
        <div className="ch-sec-label">{label}</div>
        {list.map((c) => (
          <ConvItem key={c.id} c={c} me={me} on={c.id === openId} typing={Object.keys(typing[c.id] ?? {})} />
        ))}
      </div>
    )

  return (
    <aside className="ch-list">
      <header className="ch-list-head">
        <h1>Chat</h1>
        <button className="ch-ico accent" onClick={onNew} aria-label="New message" title="New message">
          <MessageSquarePlus size={20} />
        </button>
      </header>
      <StatusMenu />
      <label className="ch-search">
        <Search size={15} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" />
        {q && (
          <button onClick={() => setQ('')} aria-label="Clear">
            <X size={14} />
          </button>
        )}
      </label>
      <nav className="ch-convs" aria-label="Chats">
        {section('Pinned', groups.pinned)}
        {section('Channels', groups.channels)}
        {section('Direct messages', groups.direct)}
        {ready && conversations.length === 0 && (
          <div className="ch-list-empty">
            <p>No chats yet.</p>
            <button className="btn btn-primary" onClick={onNew}>
              <MessageSquarePlus size={16} /> Start one
            </button>
          </div>
        )}
        {!ready && conversations.length === 0 && <div className="ch-list-empty muted">Loading your chats…</div>}
      </nav>
    </aside>
  )
}

function ConvItem({ c, me, on, typing }: { c: Conversation; me: string | null; on: boolean; typing: string[] }) {
  const ws = useWorkspace.getState()
  const title = conversationTitle(c, me)
  const last = c.lastMessage
  const who = last ? (last.senderId === me ? 'You' : ws.memberName(last.senderId).split(' ')[0]) : ''
  const preview = typing.length
    ? `${ws.memberName(typing[0]).split(' ')[0]} is typing…`
    : last
      ? last.deleted
        ? 'Message removed'
        : `${c.kind === 'dm' && last.senderId !== me ? '' : `${who}: `}${last.body || (last.files ? attachmentsLabel(last.files) : '')}`
      : c.kind === 'general'
        ? 'Everyone in the workspace'
        : c.kind === 'team'
          ? 'Your team’s channel'
          : 'Say hello'
  return (
    <button className={`ch-conv${on ? ' on' : ''}${c.unread && !c.muted ? ' unread' : ''}`} onClick={() => openConversation(c.id)} aria-current={on ? 'true' : undefined}>
      <ConversationAvatar c={c} me={me} size={42} />
      <span className="ch-conv-text">
        <span className="ch-conv-top">
          <b>{title}</b>
          {c.lastMessageAt && <small>{listTime(c.lastMessageAt)}</small>}
        </span>
        <span className="ch-conv-bottom">
          <span className={`ch-conv-prev${typing.length ? ' typing' : ''}`}>{preview}</span>
          {c.muted && <BellOff size={13} className="ch-conv-mute" />}
          {c.unread > 0 && <span className={`ch-badge${c.muted ? ' quiet' : ''}`}>{c.unread > 99 ? '99+' : c.unread}</span>}
        </span>
      </span>
    </button>
  )
}

function NoChat({ ready, onNew }: { ready: boolean; onNew: () => void }) {
  return (
    <section className="ch-thread ch-none">
      <div className="ch-none-in">
        <span className="ch-none-ico">
          <Users size={26} />
        </span>
        <h2>{ready ? 'Pick a chat' : 'Opening chat…'}</h2>
        <p>Message anyone in the workspace, or a whole team. Messages disappear after 3 months.</p>
        <button className="btn btn-primary" onClick={onNew}>
          <MessageSquarePlus size={16} /> New message
        </button>
      </div>
    </section>
  )
}

/* ================= the conversation ================= */

function Thread({ c, onInfo, info }: { c: Conversation; onInfo: () => void; info: boolean }) {
  const me = useChat((s) => s.me) ?? ''
  const messages = useChat((s) => s.messages[c.id])
  const hasMore = useChat((s) => s.hasMore[c.id])
  const loading = useChat((s) => s.loading[c.id])
  const openedAt = useChat((s) => s.openedAt)
  const typing = useChat((s) => s.typing[c.id])
  const connected = useChat((s) => s.connected)
  const presence = useChat((s) => s.presence)
  const members = useWorkspace((s) => s.members)
  const isAdmin = useWorkspace((s) => s.isAdmin())
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [editing, setEditing] = useState<ChatMessage | null>(null)
  const [menuFor, setMenuFor] = useState<ChatMessage | null>(null)
  const [confirmDel, setConfirmDel] = useState<ChatMessage | null>(null)
  const [fresh, setFresh] = useState(0)
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const prepend = useRef<{ height: number; top: number } | null>(null)
  const lastCount = useRef(0)
  void presence // header status re-renders with presence

  const list = useMemo(() => messages ?? [], [messages])
  const byId = useMemo(() => new Map(list.map((m) => [m.id, m])), [list])
  const title = conversationTitle(c, me)
  const partner = c.kind === 'dm' ? c.memberIds.find((u) => u !== me) : undefined
  const partnerMember = partner ? members.find((m) => m.userId === partner) : undefined
  const local = partnerMember ? localTimeFor(partnerMember.timezone) : null
  const typingNames = Object.keys(typing ?? {}).map((u) => useWorkspace.getState().memberName(u).split(' ')[0])
  const firstUnreadId = useMemo(() => list.find((m) => m.senderId !== me && m.createdAt > openedAt)?.id, [list, me, openedAt])
  const myLast = [...list].reverse().find((m) => m.senderId === me && !m.pending && !m.failed && !m.deletedAt)

  const scrollBottom = useCallback((smooth = false) => {
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  // a new chat opened: start at the bottom (or at "New messages")
  useLayoutEffect(() => {
    stick.current = true
    setFresh(0)
    setReplyTo(null)
    setEditing(null)
    setFiles([])
    const el = listRef.current
    const line = el?.querySelector<HTMLElement>('.ch-newline')
    if (line && el) el.scrollTop = Math.max(0, line.offsetTop - 72)
    else scrollBottom()
    lastCount.current = list.length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id])

  // messages arrived: stay at the bottom if we were there, else count them
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (prepend.current) {
      el.scrollTop = el.scrollHeight - prepend.current.height + prepend.current.top
      prepend.current = null
    } else if (list.length > lastCount.current) {
      const added = list.slice(lastCount.current)
      if (stick.current || added.every((m) => m.senderId === me)) scrollBottom(true)
      else setFresh((n) => n + added.filter((m) => m.senderId !== me).length)
    }
    lastCount.current = list.length
  }, [list, me, scrollBottom])

  // pictures loading, typing dots appearing: if we were at the bottom, stay there
  useEffect(() => {
    const el = innerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (stick.current && !prepend.current) scrollBottom()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [c.id, scrollBottom])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stick.current = bottom < 120
    if (stick.current && fresh) {
      setFresh(0)
      void markRead(c.id)
    }
    if (el.scrollTop < 80 && hasMore && !loading && list.length) {
      prepend.current = { height: el.scrollHeight, top: el.scrollTop }
      void fetchMessages(c.id, list[0].createdAt)
    }
  }

  const jump = (id: string) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 1200)
  }

  const subtitle =
    c.kind === 'dm' && partner
      ? `${presenceText(partner)}${local ? ` · ${local.time} for ${partnerMember?.name.split(' ')[0]}` : ''}`
      : c.kind === 'general'
        ? `Everyone in the workspace · ${c.memberIds.length} people`
        : c.kind === 'team'
          ? `Team channel · ${c.memberIds.length} people`
          : `${c.memberIds.length} people`

  // rows with day separators and the "New messages" line
  const rows: React.ReactNode[] = []
  let prevDay = ''
  let prev: ChatMessage | undefined
  for (const m of list) {
    const day = dayLabel(m.createdAt)
    if (day !== prevDay) {
      rows.push(
        <div className="ch-day" key={`d-${day}-${m.id}`}>
          <span>{day}</span>
        </div>
      )
      prevDay = day
      prev = undefined
    }
    if (m.id === firstUnreadId) {
      rows.push(
        <div className="ch-newline" key="new">
          <span>New messages</span>
        </div>
      )
      prev = undefined
    }
    const cont = !!prev && prev.senderId === m.senderId && m.createdAt - prev.createdAt < GROUP_GAP_MS && !prev.deletedAt
    rows.push(
      <MessageRow
        key={m.id}
        m={m}
        c={c}
        me={me}
        cont={cont}
        members={members}
        isAdmin={isAdmin}
        replyTarget={m.replyTo ? byId.get(m.replyTo) : undefined}
        onReply={(x) => {
          setEditing(null)
          setReplyTo(x)
        }}
        onEdit={(x) => {
          setReplyTo(null)
          setEditing(x)
        }}
        onMenu={setMenuFor}
        onDelete={setConfirmDel}
        onJump={jump}
      />
    )
    if (myLast && m.id === myLast.id) rows.push(<SeenLine key={`seen-${m.id}`} c={c} m={m} me={me} />)
    prev = m
  }

  return (
    <section
      className={`ch-thread${dragging ? ' dragging' : ''}`}
      aria-label={title}
      onDragEnter={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) setDragging((n) => n + 1)
      }}
      onDragLeave={() => setDragging((n) => Math.max(0, n - 1))}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(0)
        const r = acceptFiles(e.dataTransfer.files, files.length)
        if (r.ok.length) setFiles((f) => [...f, ...r.ok])
      }}
    >
      {dragging > 0 && (
        <div className="ch-drop">
          <span>Drop to send to {title}</span>
        </div>
      )}
      <header className="ch-thread-head">
        <button className="ch-back" onClick={() => openConversation(null)} aria-label="Back to chats">
          <ArrowLeft size={20} />
        </button>
        <ConversationAvatar c={c} me={me} size={36} />
        <button className="ch-thread-title" onClick={onInfo}>
          <b>{title}</b>
          <small>{subtitle}</small>
        </button>
        <div className="ch-thread-acts">
          <button className={`ch-ico${c.muted ? ' on' : ''}`} onClick={() => void setMuted(c.id, !c.muted)} aria-label={c.muted ? 'Unmute' : 'Mute'} title={c.muted ? 'Unmute' : 'Mute'}>
            {c.muted ? <BellOff size={18} /> : <Bell size={18} />}
          </button>
          <button className={`ch-ico${info ? ' on' : ''}`} onClick={onInfo} aria-label="Details" title="Details">
            <Info size={18} />
          </button>
        </div>
      </header>
      {isSupabaseEnabled && !connected && <div className="ch-offline">Reconnecting… messages you send will go out when you’re back.</div>}
      <div className="ch-msgs" ref={listRef} onScroll={onScroll}>
       <div className="ch-msgs-in" ref={innerRef}>
        {hasMore && (
          <div className="ch-more">
            {loading ? 'Loading…' : <button onClick={() => (prepend.current = { height: listRef.current?.scrollHeight ?? 0, top: listRef.current?.scrollTop ?? 0 }, void fetchMessages(c.id, list[0]?.createdAt))}>Load earlier messages</button>}
          </div>
        )}
        {!hasMore && list.length > 0 && <div className="ch-start">{c.kind === 'dm' ? `This is the start of your conversation with ${title}.` : `This is the start of ${title}.`} Messages disappear after 3 months.</div>}
        {list.length === 0 && (
          <div className="ch-start empty">
            {c.kind === 'dm' ? `Say hello to ${title}.` : c.kind === 'general' ? 'Everyone in the workspace is here. Say hello.' : `Nothing here yet. Say hello.`}
            <br />
            <small>Messages disappear after 3 months.</small>
          </div>
        )}
        {rows}
        {typingNames.length > 0 && (
          <div className="ch-typing">
            <i />
            <i />
            <i />
            <span>{typingNames.length === 1 ? `${typingNames[0]} is typing` : `${typingNames.slice(0, 2).join(' and ')}${typingNames.length > 2 ? ' and others' : ''} are typing`}</span>
          </div>
        )}
       </div>
      </div>
      {fresh > 0 && (
        <button
          className="ch-jump"
          onClick={() => {
            setFresh(0)
            scrollBottom(true)
            void markRead(c.id)
          }}
        >
          <ArrowDown size={15} /> {fresh} new
        </button>
      )}
      <Composer
        c={c}
        me={me}
        members={members}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        editing={editing}
        onDoneEdit={() => setEditing(null)}
        onSent={() => (stick.current = true)}
        files={files}
        onFiles={(add) => setFiles((f) => [...f, ...add])}
        onRemoveFile={(i) => setFiles((f) => f.filter((_, j) => j !== i))}
        onClearFiles={() => setFiles([])}
      />

      {menuFor && (
        <MessageSheet
          m={menuFor}
          c={c}
          me={me}
          isAdmin={isAdmin}
          onClose={() => setMenuFor(null)}
          onReply={() => setReplyTo(menuFor)}
          onEdit={() => setEditing(menuFor)}
          onDelete={() => setConfirmDel(menuFor)}
        />
      )}
      {confirmDel && (
        <Modal
          title="Delete message?"
          onClose={() => setConfirmDel(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setConfirmDel(null)}>
                Keep it
              </button>
              <button
                className="btn btn-primary danger"
                onClick={() => {
                  void deleteMessage(c.id, confirmDel.id)
                  setConfirmDel(null)
                }}
              >
                <Trash2 size={15} /> Delete
              </button>
            </>
          }
        >
          <p className="ch-confirm">{confirmDel.body ? `“${confirmDel.body.slice(0, 140)}”` : attachmentsLabel(confirmDel.attachments)}</p>
          <p className="ch-confirm-sub">Everyone in the chat will see “Message removed”.</p>
        </Modal>
      )}
    </section>
  )
}

/** phones: long-press a message → this sheet */
function MessageSheet({ m, c, me, isAdmin, onClose, onReply, onEdit, onDelete }: { m: ChatMessage; c: Conversation; me: string; isAdmin: boolean; onClose: () => void; onReply: () => void; onEdit: () => void; onDelete: () => void }) {
  const [emoji, setEmoji] = useState(false)
  const mine = m.senderId === me
  const run = (fn: () => void) => () => {
    onClose()
    fn()
  }
  return (
    <div className="ch-sheet-scrim" onClick={onClose}>
      <div className="ch-sheet" onClick={(e) => e.stopPropagation()} role="menu">
        <div className="sheet-grab" />
        {m.failed ? (
          <button role="menuitem" onClick={run(() => retryMessage(c.id, m.id))}>
            <CornerUpLeft size={17} /> Try sending again
          </button>
        ) : (
          <>
            <div className="ch-sheet-react">
              {QUICK_REACTIONS.map((e) => (
                <button key={e} onClick={run(() => void toggleReaction(c.id, m.id, e))}>
                  {e}
                </button>
              ))}
              <button onClick={() => setEmoji(true)} aria-label="More">
                <SmilePlus size={18} />
              </button>
            </div>
            {emoji && (
              <EmojiPicker
                onClose={() => setEmoji(false)}
                onPick={(e) => {
                  onClose()
                  void toggleReaction(c.id, m.id, e)
                }}
              />
            )}
            <button role="menuitem" onClick={run(onReply)}>
              <CornerUpLeft size={17} /> Reply
            </button>
            <button role="menuitem" onClick={run(() => void navigator.clipboard?.writeText(m.body))}>
              <ChevronRight size={17} /> Copy text
            </button>
            {mine && (
              <button role="menuitem" onClick={run(onEdit)}>
                <Pencil size={17} /> Edit
              </button>
            )}
            {(mine || (isAdmin && (c.kind === 'team' || c.kind === 'general'))) && (
              <button role="menuitem" className="danger" onClick={run(onDelete)}>
                <Trash2 size={17} /> Delete
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* ================= details ================= */

function InfoPane({ c, onClose }: { c: Conversation; onClose: () => void }) {
  const me = useChat((s) => s.me)
  const presence = useChat((s) => s.presence)
  const members = useWorkspace((s) => s.members)
  const teams = useWorkspace((s) => s.teams)
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(c.name)
  const [leaving, setLeaving] = useState(false)
  void presence
  const title = conversationTitle(c, me)
  const people = c.memberIds.map((u) => members.find((m) => m.userId === u)).filter((m): m is NonNullable<typeof m> => !!m)
  const team = c.teamId ? teams.find((t) => t.id === c.teamId) : undefined
  const kindLabel = c.kind === 'dm' ? 'Direct message' : c.kind === 'group' ? `Group · ${c.memberIds.length} people` : c.kind === 'team' ? `Team channel${team ? ` · ${team.name}` : ''}` : 'Everyone in the workspace'

  return (
    <div className="ch-info-in">
      <div className="ch-info-head">
        <ConversationAvatar c={c} me={me} size={56} />
        {renaming ? (
          <form
            className="ch-rename"
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim()) void renameGroup(c.id, name)
              setRenaming(false)
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="Group name" />
            <button className="btn btn-primary" type="submit">
              Save
            </button>
          </form>
        ) : (
          <h3>
            {title}
            {c.kind === 'group' && (
              <button className="ch-ico" onClick={() => (setName(c.name), setRenaming(true))} aria-label="Rename" title="Rename">
                <Pencil size={14} />
              </button>
            )}
          </h3>
        )}
        <small>{kindLabel}</small>
        <button className="ch-ico ch-info-close" onClick={onClose} aria-label="Close details">
          <X size={18} />
        </button>
      </div>

      <div className="ch-info-opts">
        <button onClick={() => void setMuted(c.id, !c.muted)}>
          {c.muted ? <BellOff size={17} /> : <Bell size={17} />}
          <span>{c.muted ? 'Muted' : 'Notifications on'}</span>
          <i className={`ch-switch${c.muted ? '' : ' on'}`} />
        </button>
        <button onClick={() => void setPinned(c.id, !c.pinned)}>
          {c.pinned ? <PinOff size={17} /> : <Pin size={17} />}
          <span>{c.pinned ? 'Pinned to the top' : 'Pin to the top'}</span>
          <i className={`ch-switch${c.pinned ? ' on' : ''}`} />
        </button>
      </div>

      <div className="ch-info-sec">
        <div className="ch-sec-label">
          {c.kind === 'dm' ? 'About' : `People · ${people.length}`}
          {c.kind === 'group' && (
            <button className="ch-sec-act" onClick={() => setAdding(true)}>
              <UserPlus size={14} /> Add
            </button>
          )}
        </div>
        {people
          .filter((m) => c.kind !== 'dm' || m.userId !== me)
          .map((m) => {
            const local = localTimeFor(m.timezone)
            return (
              <div key={m.userId} className="ch-person">
                <PersonAvatar userId={m.userId} size={34} />
                <span className="ch-person-text">
                  <b>
                    {m.userId === me ? 'You' : m.name || m.email}
                    {m.role !== 'member' && <em>{m.role}</em>}
                  </b>
                  <small>
                    {presenceText(m.userId)}
                    {local ? ` · ${local.time} their time` : ''}
                  </small>
                  {c.kind === 'dm' && <small className="ch-person-mail">{m.email}</small>}
                </span>
              </div>
            )
          })}
      </div>

      <div className="ch-info-note">
        <Hash size={14} />
        <span>Messages here disappear after 3 months. Only people in this chat can read it{c.kind === 'dm' || c.kind === 'group' ? ' — admins included' : ''}.</span>
      </div>

      {c.kind === 'group' && (
        <button className="ch-leave" onClick={() => setLeaving(true)}>
          <LogOut size={16} /> Leave group
        </button>
      )}

      {adding && <PeoplePicker title="Add people" exclude={c.memberIds} action="Add" onClose={() => setAdding(false)} onDone={(ids) => addToGroup(c.id, ids)} />}
      {leaving && (
        <Modal
          title="Leave this group?"
          onClose={() => setLeaving(false)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setLeaving(false)}>
                Stay
              </button>
              <button
                className="btn btn-primary danger"
                onClick={() => {
                  setLeaving(false)
                  onClose()
                  void leaveGroup(c.id)
                }}
              >
                <LogOut size={15} /> Leave
              </button>
            </>
          }
        >
          <p className="ch-confirm-sub">You’ll stop seeing new messages in {title}. Someone in the group can add you again.</p>
        </Modal>
      )}
    </div>
  )
}
