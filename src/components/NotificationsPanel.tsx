import { useEffect, useState } from 'react'
import { Bell, BellOff, CheckCircle2, Inbox, MessageCircle, MessageSquare, Trash2, UserPlus } from 'lucide-react'
import { formatDistanceToNowStrict } from 'date-fns'
import Modal from './Modal'
import { clearNotifications, markAllRead, switchWorkspace, useWorkspace } from '../lib/workspace'
import { showWorkspaceTasks } from '../lib/auth'
import { useChatUnread } from '../lib/chat'
import { useStore } from '../store/useStore'
import type { AppNotification } from '../types'

const ICON: Record<string, typeof UserPlus> = {
  task_assigned: UserPlus,
  task_done: CheckCircle2,
  task_comment: MessageSquare,
  tasks_waiting: Inbox
}

/** "Updates": tasks assigned to you, finished for you, or commented on. */
export default function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const notifications = useWorkspace((s) => s.notifications)
  const openTaskEditor = useStore((s) => s.openTaskEditor)
  const updateSettings = useStore((s) => s.updateSettings)
  const setView = useStore((s) => s.setView)

  // opening the panel is "I've seen these"
  useEffect(() => {
    const t = setTimeout(() => void markAllRead(), 800)
    return () => clearTimeout(t)
  }, [])

  const open = async (n: AppNotification) => {
    // "3 tasks are waiting for you" (handed out before you joined) → your task list
    if (n.kind === 'tasks_waiting') {
      onClose()
      setView('tasks')
      return
    }
    if (!n.taskId) return
    const ws = useWorkspace.getState()
    const task = ws.allTasks.find((t) => t.id === n.taskId)
    if (!task) return
    if (task.companyId && task.companyId !== ws.activeId) {
      showWorkspaceTasks(task.companyId)
      updateSettings({ activeCompanyId: task.companyId })
      await switchWorkspace(task.companyId)
    }
    onClose()
    openTaskEditor(task.id)
  }

  return (
    <Modal
      title="Updates"
      onClose={onClose}
      footer={
        notifications.length > 0 ? (
          <button className="btn btn-secondary" onClick={() => void clearNotifications()}>
            <Trash2 size={15} /> Clear all
          </button>
        ) : undefined
      }
    >
      {notifications.length === 0 ? (
        <div className="td-empty">
          <div className="td-empty-ico">
            <BellOff size={24} />
          </div>
          <div className="td-empty-title">You're all caught up</div>
          <div className="td-empty-sub">Tasks assigned to you, finished for you or commented on show up here.</div>
        </div>
      ) : (
        <div className="notif-list">
          {notifications.map((n) => {
            const Icon = ICON[n.kind] ?? UserPlus
            return (
              <button key={n.id} className={`notif${n.readAt ? '' : ' unread'}`} onClick={() => void open(n)}>
                <span className={`notif-ico k-${n.kind}`}>
                  <Icon size={16} />
                </span>
                <span className="notif-text">
                  <b>{n.title}</b>
                  {n.body && <span>{n.body}</span>}
                  <small>{formatDistanceToNowStrict(n.createdAt, { addSuffix: true })}</small>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </Modal>
  )
}

/** chat with an unread count; opens the Chat page (home hero, next to the bell) */
export function ChatButton({ className = '' }: { className?: string }) {
  const unread = useChatUnread()
  const setView = useStore((s) => s.setView)
  return (
    <button className={`${className}${unread ? ' has-unread' : ''}`} onClick={() => setView('chat')} title="Chat" aria-label={`Chat${unread ? `, ${unread} new` : ''}`}>
      <span className="nav-ico">
        <MessageCircle size={18} strokeWidth={2.1} />
        {unread > 0 && <span className="nav-badge">{unread > 9 ? '9+' : unread}</span>}
      </span>
    </button>
  )
}

/** the hero's top-right buttons: chat and updates (only inside a company) */
export function HeroButtons() {
  return (
    <div className="hm-hero-btns">
      <ChatButton className="hm-bell" />
      <InboxButton className="hm-bell" label={false} />
    </div>
  )
}

/** bell with an unread count; opens the panel (used in the sidebar and on phones) */
export function InboxButton({ className = '', label = true }: { className?: string; label?: boolean }) {
  const unread = useWorkspace((s) => s.notifications.filter((n) => !n.readAt).length)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className={`${className}${unread ? ' has-unread' : ''}`} onClick={() => setOpen(true)} title="Updates" aria-label={`Updates${unread ? `, ${unread} new` : ''}`}>
        <span className="inbox-ico">
          <Bell size={18} strokeWidth={2.1} />
          {unread > 0 && <span className="nav-badge">{unread > 9 ? '9+' : unread}</span>}
        </span>
        {label && <span className="sb-label">Updates</span>}
      </button>
      {open && <NotificationsPanel onClose={() => setOpen(false)} />}
    </>
  )
}
