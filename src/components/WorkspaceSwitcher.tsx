import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Building2, Check, ChevronsUpDown, Plus } from 'lucide-react'
import { useWorkspace, switchWorkspace, ROLE_LABEL } from '../lib/workspace'
import { showWorkspaceTasks } from '../lib/auth'
import { useStore } from '../store/useStore'
import CreateCompanyModal from './CreateCompanyModal'
import type { Workspace } from '../types'

/** the little logo/initial square used everywhere a workspace is shown */
export function WorkspaceMark({ ws, size = 28 }: { ws: Pick<Workspace, 'name' | 'logoUrl' | 'kind'>; size?: number }) {
  return (
    <span className={`ws-mark${ws.kind === 'personal' ? ' personal' : ''}`} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {ws.logoUrl ? <img src={ws.logoUrl} alt="" /> : ws.kind === 'personal' ? <Building2 size={size * 0.5} /> : ws.name.trim()[0]?.toUpperCase()}
    </span>
  )
}

/** Sidebar control: which workspace is open, switch, or start a company one. */
export default function WorkspaceSwitcher() {
  const workspaces = useWorkspace((s) => s.workspaces)
  const activeId = useWorkspace((s) => s.activeId)
  const updateSettings = useStore((s) => s.updateSettings)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  // the menu is portalled (the collapsed sidebar clips anything inside it)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0]

  const toggle = () => {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect()
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 288)), top: r.bottom + 6 })
    }
    setOpen((v) => !v)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!active) return null

  const pick = async (id: string) => {
    setOpen(false)
    if (id === activeId) return
    showWorkspaceTasks(id)
    updateSettings({ activeCompanyId: id })
    await switchWorkspace(id)
  }

  return (
    <div className="ws-switch" ref={ref}>
      <button className={`ws-btn${open ? ' open' : ''}`} onClick={toggle} aria-haspopup="listbox" aria-expanded={open} title={active.name}>
        <WorkspaceMark ws={active} />
        <span className="ws-btn-text sb-label">
          <span className="ws-btn-name">{active.name}</span>
          <span className="ws-btn-role">{active.kind === 'personal' ? 'Personal space' : `Workspace · ${ROLE_LABEL[active.role]}`}</span>
        </span>
        <ChevronsUpDown size={15} className="ws-btn-chev sb-label" />
      </button>

      {open &&
        createPortal(
          <div className="ws-menu" role="listbox" ref={menuRef} style={{ left: pos.left, top: pos.top }}>
          <div className="ws-menu-title">Workspaces</div>
          {workspaces.map((w) => (
            <button key={w.id} role="option" aria-selected={w.id === active.id} className={`ws-item${w.id === active.id ? ' on' : ''}`} onClick={() => void pick(w.id)}>
              <WorkspaceMark ws={w} size={26} />
              <span className="ws-item-text">
                <span className="ws-item-name">{w.name}</span>
                <span className="ws-item-sub">{w.kind === 'personal' ? 'Just you' : `Company · ${ROLE_LABEL[w.role]}`}</span>
              </span>
              {w.id === active.id && <Check size={15} strokeWidth={2.6} />}
            </button>
          ))}
          <button
            className="ws-item ws-item-new"
            onClick={() => {
              setOpen(false)
              setCreating(true)
            }}
          >
            <span className="ws-mark ws-mark-new">
              <Plus size={15} strokeWidth={2.6} />
            </span>
            <span className="ws-item-text">
              <span className="ws-item-name">Create a company workspace</span>
              <span className="ws-item-sub">Invite your team and assign tasks</span>
            </span>
          </button>
          </div>,
          document.body
        )}

      {creating && <CreateCompanyModal onClose={() => setCreating(false)} />}
    </div>
  )
}
