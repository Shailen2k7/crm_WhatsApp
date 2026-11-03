/**
 * Sidebar pieces:
 *  - NewMenu: the one "+ New" button near the bottom (task, meeting, note, reminder…)
 *  - ProfileMenu: your name at the bottom → Settings, Privacy & legal, Sign out
 *  - SectionTabs: the tabs along the top of a section (Tasks · Plan my day)
 * Menus are portalled: the collapsed sidebar clips anything inside it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BellRing, CalendarPlus, CheckSquare, ChevronsUpDown, FileText, LogOut, MessageCircle, NotebookPen, Plus, Settings, Shield, UserPlus } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useWorkspace } from '../lib/workspace'
import { useQuickActions } from './QuickActions'
import { sectionOf } from '../lib/sections'
import InviteModal from './InviteModal'
import type { ViewId } from '../types'

/** a small menu anchored to a button, opening below it (or above, near the bottom) */
function useAnchoredMenu(width: number) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const toggle = (up = false) => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
      setPos(up ? { left, bottom: window.innerHeight - r.top + 6 } : { left, top: r.bottom + 6 })
    }
    setOpen((v) => !v)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return { open, setOpen, toggle, pos, btnRef, menuRef }
}

function MenuItem({ icon, label, hint, kbd, onClick, danger }: { icon: ReactNode; label: string; hint?: string; kbd?: string; onClick: () => void; danger?: boolean }) {
  return (
    <button role="menuitem" className={`sbm-item${danger ? ' danger' : ''}`} onClick={onClick}>
      <span className="sbm-ico">{icon}</span>
      <span className="sbm-text">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </span>
      {kbd && <kbd className="sbm-kbd">{kbd}</kbd>}
    </button>
  )
}

/* ================= + New ================= */

export function NewMenu() {
  const qa = useQuickActions()
  const setView = useStore((s) => s.setView)
  const isAdmin = useWorkspace((s) => s.isAdmin())
  const company = useWorkspace((s) => s.available && s.workspaces.find((w) => w.id === s.activeId)?.kind === 'company')
  const m = useAnchoredMenu(272)
  const [inviting, setInviting] = useState(false)
  const run = (fn: () => void) => () => {
    m.setOpen(false)
    fn()
  }

  return (
    <>
      <button ref={m.btnRef} className="btn btn-primary sb-new" onClick={() => m.toggle(true)} aria-haspopup="menu" aria-expanded={m.open} aria-label="New">
        <Plus size={17} strokeWidth={2.6} />
        <span className="sb-label sb-collapse">New</span>
      </button>
      {m.open &&
        createPortal(
          <div className="sbm" role="menu" ref={m.menuRef} style={{ left: m.pos.left, bottom: m.pos.bottom, width: 272 }}>
            <div className="sbm-title">Create</div>
            <MenuItem icon={<CheckSquare size={16} />} label="Task" hint={company ? 'For you or a teammate' : 'Something to get done'} onClick={run(qa.task)} />
            <MenuItem icon={<CalendarPlus size={16} />} label="Meeting" hint="Pick a time, invite people" onClick={run(qa.meeting)} />
            <MenuItem icon={<FileText size={16} />} label="Note" hint={company ? 'A page for you or the team' : 'A page for anything'} onClick={run(qa.note)} />
            <MenuItem icon={<BellRing size={16} />} label="Reminder" hint="Rings at the time you set" onClick={run(qa.reminder)} />
            <MenuItem icon={<NotebookPen size={16} />} label="Journal entry" hint="Private to you" onClick={run(qa.journal)} />
            {company && (
              <>
                <div className="sbm-sep" />
                <MenuItem
                  icon={<MessageCircle size={16} />}
                  label="Message"
                  hint="Chat with someone, or start a group"
                  onClick={run(() => {
                    setView('chat')
                    setTimeout(() => window.dispatchEvent(new Event('msos:chat-new')), 120)
                  })}
                />
                {isAdmin && <MenuItem icon={<UserPlus size={16} />} label="Invite people" hint="One person, or paste a whole list" onClick={run(() => setInviting(true))} />}
              </>
            )}
          </div>,
          document.body
        )}
      {inviting && <InviteModal onClose={() => setInviting(false)} />}
    </>
  )
}

/* ================= profile ================= */

export function ProfileMenu({ name, email, initials, onSignOut }: { name: string; email: string; initials: string; onSignOut: () => void }) {
  const setView = useStore((s) => s.setView)
  const view = useStore((s) => s.view)
  const m = useAnchoredMenu(248)
  const go = (v: ViewId) => {
    m.setOpen(false)
    setView(v)
  }

  return (
    <>
      <button
        ref={m.btnRef}
        className={`sidebar-user sb-profile${view === 'settings' ? ' on' : ''}`}
        onClick={() => m.toggle(true)}
        aria-haspopup="menu"
        aria-expanded={m.open}
        aria-label="Your account"
      >
        <span className="user-avatar">{initials}</span>
        <span className="sidebar-user-info sb-label">
          <span className="sidebar-user-name">{name}</span>
          <span className="sidebar-user-email">{email}</span>
        </span>
        <ChevronsUpDown size={15} className="sb-label sb-profile-chev" />
      </button>
      {m.open &&
        createPortal(
          <div className="sbm" role="menu" ref={m.menuRef} style={{ left: m.pos.left, bottom: m.pos.bottom, width: 248 }}>
            <div className="sbm-who">
              <span className="user-avatar">{initials}</span>
              <span>
                <b>{name}</b>
                <small>{email}</small>
              </span>
            </div>
            <div className="sbm-sep" />
            <MenuItem icon={<Settings size={16} />} label="Settings" hint="Profile, defaults, notifications" onClick={() => go('settings')} />
            <MenuItem
              icon={<Shield size={16} />}
              label="Privacy & legal"
              onClick={() => {
                m.setOpen(false)
                window.open('/legal', '_blank', 'noopener')
              }}
            />
            <div className="sbm-sep" />
            <MenuItem
              icon={<LogOut size={16} />}
              label="Sign out"
              danger
              onClick={() => {
                m.setOpen(false)
                onSignOut()
              }}
            />
          </div>,
          document.body
        )}
    </>
  )
}

/* ================= tabs along the top of a section ================= */

export function SectionTabs({ view }: { view: ViewId }) {
  const setView = useStore((s) => s.setView)
  const section = sectionOf(view)
  if (!section || section.tabs.length < 2) return null
  return (
    <nav className="sec-tabs" aria-label={section.label}>
      <div className="sec-tabs-inner" role="tablist">
        {section.tabs.map((t) => (
          <button key={t.view} role="tab" aria-selected={view === t.view} className={`sec-tab${view === t.view ? ' on' : ''}`} onClick={() => setView(t.view)} title={t.hint}>
            {t.label}
          </button>
        ))}
      </div>
    </nav>
  )
}
