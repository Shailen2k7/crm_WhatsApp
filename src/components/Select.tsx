import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from 'lucide-react'

export interface SelectOption {
  value: string
  label: string
  /** small grey line under the label in the list (e.g. "6 open · 2 overdue") */
  hint?: string
  /** colours the hint: 'warn' (amber) or 'bad' (red) */
  tone?: 'warn' | 'bad'
}

/**
 * The product's dropdown — replaces every native <select>.
 * A styled trigger + a portalled, animated listbox that never clips inside
 * panels or modals. Arrow keys / Enter / Escape work; long lists get search.
 */
export default function Select({
  value,
  options,
  onChange,
  className = '',
  block = false,
  ariaLabel,
  searchable
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  /** extra class on the trigger button */
  className?: string
  /** full-width, form-field look (like .input) */
  block?: boolean
  ariaLabel?: string
  /** show a filter box (defaults to on for 12+ options) */
  searchable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState(-1)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const withSearch = searchable ?? options.length >= 12
  const current = options.find((o) => o.value === value)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q)) : options
  }, [options, query])

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = Math.min(Math.max(r.width, 180), vw - 24)
    const left = Math.min(Math.max(12, r.left), vw - width - 12)
    const spaceBelow = vh - r.bottom
    if (spaceBelow < 290 && r.top > spaceBelow) setPos({ left, bottom: vh - r.top + 6, width })
    else setPos({ left, top: r.bottom + 6, width })
  }

  const openMenu = () => {
    place()
    setQuery('')
    setHover(shown.findIndex((o) => o.value === value))
    setOpen(true)
  }

  // focus search / scroll the selected row into view once open
  useLayoutEffect(() => {
    if (!open) return
    if (withSearch) searchRef.current?.focus()
    menuRef.current?.querySelector('.sel-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [open, withSearch])

  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // close just the list, not the popup it sits in
        e.stopPropagation()
        setOpen(false)
        btnRef.current?.focus()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setHover((h) => {
          const n = e.key === 'ArrowDown' ? Math.min(h + 1, shown.length - 1) : Math.max(h - 1, 0)
          menuRef.current?.querySelectorAll('.sel-item')[n]?.scrollIntoView({ block: 'nearest' })
          return n
        })
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const o = shown[hover] ?? shown[0]
        if (o) {
          onChange(o.value)
          setOpen(false)
          btnRef.current?.focus()
        }
      }
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, shown, hover, onChange])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`sel-btn${block ? ' sel-block' : ''}${open ? ' open' : ''} ${className}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="sel-value">{current?.label ?? '—'}</span>
        <ChevronDown size={15} className="sel-chev" />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="sel-menu"
            role="listbox"
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.width }}
          >
            {withSearch && (
              <div className="sel-search">
                <Search size={14} />
                <input
                  ref={searchRef}
                  placeholder="Search…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setHover(0)
                  }}
                />
              </div>
            )}
            <div className="sel-list">
              {shown.length === 0 && <div className="sel-none">No matches</div>}
              {shown.map((o, i) => (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className={`sel-item${o.value === value ? ' on' : ''}${i === hover ? ' hover' : ''}`}
                  onMouseEnter={() => setHover(i)}
                  onClick={() => {
                    onChange(o.value)
                    setOpen(false)
                    btnRef.current?.focus()
                  }}
                >
                  {o.hint ? (
                    <span className="sel-two">
                      <span>{o.label}</span>
                      <small className={o.tone ? `sel-hint ${o.tone}` : 'sel-hint'}>{o.hint}</small>
                    </span>
                  ) : (
                    <span>{o.label}</span>
                  )}
                  {o.value === value && <Check size={15} strokeWidth={2.6} />}
                </button>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
