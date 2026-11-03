/**
 * The list of people that pops up while assigning: from "@" in the task box,
 * or from the Assign chip. Shows who is busy, and who is invited but not
 * joined yet (their tasks wait for them).
 */
import { useEffect, useRef } from 'react'
import { Search, UserPlus } from 'lucide-react'
import { loadLabel, loadTone, type Person } from '../lib/people'

export default function PeopleMenu({
  people,
  active,
  showLoad,
  onPick,
  onHover,
  filter,
  onFilter,
  onInvite,
  selected
}: {
  people: Person[]
  /** highlighted row (arrow keys) */
  active: number
  showLoad: boolean
  onPick: (p: Person) => void
  onHover: (i: number) => void
  /** chip mode: a search box at the top */
  filter?: string
  onFilter?: (v: string) => void
  /** admins: "Invite someone new" at the bottom */
  onInvite?: () => void
  selected?: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelectorAll('.pm-row')[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div className="pm" role="listbox" aria-label="Assign to" onMouseDown={(e) => e.preventDefault()}>
      {onFilter && (
        <label className="pm-search" onMouseDown={(e) => e.stopPropagation()}>
          <Search size={14} />
          <input autoFocus placeholder="Find a person…" value={filter ?? ''} onChange={(e) => onFilter(e.target.value)} />
        </label>
      )}
      <div className="pm-list" ref={listRef}>
        {people.length === 0 && <div className="pm-none">No one by that name in this workspace</div>}
        {people.map((p, i) => {
          const tone = showLoad ? loadTone(p) : undefined
          return (
            <button
              key={p.key}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`pm-row${i === active ? ' hl' : ''}${p.key === selected ? ' on' : ''}`}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(p)}
            >
              <span className={`pm-av${p.invited ? ' invited' : ''}${p.isMe ? ' me' : ''}`}>{p.isMe ? 'Me' : p.initials}</span>
              <span className="pm-text">
                <span className="pm-name">
                  {p.isMe ? `Me (${p.first})` : p.name}
                  {p.invited && <em className="pm-tag">Invited</em>}
                </span>
                {showLoad ? (
                  <small className={tone ? `pm-load ${tone}` : 'pm-load'}>{loadLabel(p)}</small>
                ) : p.invited ? (
                  <small className="pm-load">Gets it when they join</small>
                ) : (
                  <small className="pm-load">{p.email}</small>
                )}
              </span>
              {showLoad && !p.invited && <LoadBar open={p.open} />}
            </button>
          )
        })}
      </div>
      {onInvite && (
        <button type="button" className="pm-invite" onClick={onInvite}>
          <UserPlus size={14} /> Invite someone new
        </button>
      )}
      <div className="pm-foot">
        <kbd>↑</kbd>
        <kbd>↓</kbd> to move · <kbd>Enter</kbd> to pick
      </div>
    </div>
  )
}

/** five little bars: how full someone's plate is */
function LoadBar({ open }: { open: number }) {
  const lit = Math.min(5, Math.ceil(open / 2))
  return (
    <span className={`pm-bar${open >= 8 ? ' busy' : ''}`} aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className={i < lit ? 'on' : ''} />
      ))}
    </span>
  )
}
