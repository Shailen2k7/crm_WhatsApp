/**
 * Plan my day — today's tasks on one side, the day's timeline on the other.
 * Press Plan to drop a task into your next free time, or drag it to the
 * exact time. On the timeline a planned task can be moved, stretched,
 * ticked off or taken out. Blocks land on the calendar and the app
 * reminds you when they start.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { addDays, format } from 'date-fns'
import { Check, ChevronLeft, ChevronRight, CircleCheck, Flag, Sunrise, Video, Wand2, X } from 'lucide-react'
import { useStore } from '../store/useStore'
import { notifyTask } from '../lib/notify'
import { dueLabel, isOverdue, subtaskProgress } from '../lib/tasks'
import { clamp, fromDateKey, minToLabel, nowMinutes, snap, toDateKey } from '../lib/time'
import { tasksForWorkspace, useWorkspace } from '../lib/workspace'
import { typeById } from '../lib/meetingTypes'
import type { BlockedTime, Task } from '../types'

const HOUR_H = 72
const DEFAULT_LEN = 60
const PRIO_RANK = { high: 0, medium: 1, low: 2 }

interface Busy {
  start: number
  end: number
}

/** free gaps of at least `min` minutes between `from` and `to` */
const freeSlots = (busy: Busy[], from: number, to: number, min = 15): Busy[] => {
  const sorted = [...busy].sort((a, b) => a.start - b.start)
  const out: Busy[] = []
  let cursor = from
  for (const b of sorted) {
    if (b.end <= cursor) continue
    if (b.start - cursor >= min) out.push({ start: cursor, end: Math.min(b.start, to) })
    cursor = Math.max(cursor, b.end)
    if (cursor >= to) break
  }
  if (to - cursor >= min) out.push({ start: cursor, end: to })
  return out.filter((s) => s.end > s.start)
}

/** "1h 30m", "45m", "2h" */
const fmtDur = (min: number) => {
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`
}

/** side-by-side lanes for things that overlap, so nothing hides behind anything */
const lanesFor = (items: { key: string; start: number; end: number }[]) => {
  const out = new Map<string, { lane: number; lanes: number }>()
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end)
  let cluster: string[] = []
  let cols: number[] = []
  let clusterEnd = -1
  const close = () => {
    for (const k of cluster) out.get(k)!.lanes = cols.length
    cluster = []
    cols = []
  }
  for (const it of sorted) {
    if (it.start >= clusterEnd) close()
    let lane = cols.findIndex((end) => end <= it.start)
    if (lane === -1) lane = cols.push(it.end) - 1
    else cols[lane] = it.end
    out.set(it.key, { lane, lanes: 1 })
    cluster.push(it.key)
    clusterEnd = Math.max(clusterEnd, it.end)
  }
  close()
  return out
}

export default function PlanView() {
  const allTasks = useStore((s) => s.tasks)
  const meetings = useStore((s) => s.meetings)
  const blocked = useStore((s) => s.blocked)
  const settings = useStore((s) => s.settings)
  const addBlocked = useStore((s) => s.addBlocked)
  const updateBlocked = useStore((s) => s.updateBlocked)
  const deleteBlocked = useStore((s) => s.deleteBlocked)
  const toggleTask = useStore((s) => s.toggleTask)
  const openTaskEditor = useStore((s) => s.openTaskEditor)
  const wsOn = useWorkspace((s) => s.available)
  const activeId = useWorkspace((s) => s.activeId)
  const me = useWorkspace((s) => s.me)

  const todayKey = toDateKey(new Date())
  const [dateKey, setDateKey] = useState(todayKey)
  const [dragTask, setDragTask] = useState<string | null>(null)
  const [hoverMin, setHoverMin] = useState<number | null>(null)
  const [showAnytime, setShowAnytime] = useState(false)
  const [flash, setFlash] = useState<{ text: string; undo?: () => void } | null>(null)
  const colRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [, tick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), flash.undo ? 5000 : 2400)
    return () => clearTimeout(t)
  }, [flash])

  const tasks = useMemo(() => {
    const scoped = wsOn ? tasksForWorkspace(allTasks, activeId) : allTasks
    // my own work only: in a company, tasks assigned to me (or unassigned ones I wrote)
    return wsOn && activeId ? scoped.filter((t) => !t.companyId || t.assignedTo === me || (!t.assignedTo && !t.assignedInvite && (!t.createdBy || t.createdBy === me))) : scoped
  }, [allTasks, wsOn, activeId, me])

  const dayMeetings = useMemo(() => meetings.filter((m) => m.date === dateKey).sort((a, b) => a.startMin - b.startMin), [meetings, dateKey])
  const dayBlocks = useMemo(() => blocked.filter((b) => b.date === dateKey).sort((a, b) => a.startMin - b.startMin), [blocked, dateKey])
  const planned = useMemo(() => new Map(dayBlocks.filter((b) => b.taskId).map((b) => [b.taskId!, b])), [dayBlocks])

  const lists = useMemo(() => {
    const open = tasks.filter((t) => !t.done)
    const byPrio = (a: Task, b: Task) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority] || (a.dueTime ?? 1440) - (b.dueTime ?? 1440)
    const overdue = open.filter((t) => t.dueDate && t.dueDate < dateKey && !planned.has(t.id)).sort(byPrio)
    const today = open.filter((t) => t.dueDate === dateKey && !planned.has(t.id)).sort(byPrio)
    const anytime = open.filter((t) => !t.dueDate && !planned.has(t.id)).sort(byPrio)
    return { toPlan: [...overdue, ...today], anytime }
  }, [tasks, dateKey, planned])

  // the hours shown: working hours, stretched to fit anything already on the day
  const range = useMemo(() => {
    let from = Math.min(settings.workStartMin, 8 * 60)
    let to = Math.max(settings.workEndMin, 18 * 60)
    for (const m of dayMeetings) {
      from = Math.min(from, m.startMin)
      to = Math.max(to, m.startMin + m.durationMin)
    }
    for (const b of dayBlocks) {
      from = Math.min(from, b.startMin)
      to = Math.max(to, b.endMin)
    }
    from = Math.floor(from / 60) * 60
    to = Math.min(24 * 60, Math.ceil(to / 60) * 60)
    return { from, to }
  }, [settings.workStartMin, settings.workEndMin, dayMeetings, dayBlocks])

  const busy: Busy[] = useMemo(
    () => [...dayMeetings.map((m) => ({ start: m.startMin, end: m.startMin + m.durationMin })), ...dayBlocks.map((b) => ({ start: b.startMin, end: b.endMin }))],
    [dayMeetings, dayBlocks]
  )
  const slots = useMemo(() => freeSlots(busy, range.from, range.to, 15), [busy, range])

  /** where "next free time" starts looking: now on today, the start of work on other days */
  const startFrom = () => (dateKey === todayKey ? Math.max(range.from, Math.ceil((nowMinutes() + 5) / 15) * 15) : Math.max(range.from, settings.workStartMin))

  const minToY = (min: number) => ((min - range.from) / 60) * HOUR_H
  const yToMin = (y: number) => range.from + (y / HOUR_H) * 60
  const minAtClientY = (clientY: number) => {
    const el = colRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return clamp(snap(yToMin(clientY - rect.top), 15), range.from, range.to - 15)
  }

  /** the slot a block starting at `start` would get: shortened so it never overlaps */
  const fit = (start: number, len = DEFAULT_LEN): Busy | null => {
    if (busy.some((b) => start >= b.start && start < b.end)) return null
    const next = busy.filter((b) => b.start > start).sort((a, b) => a.start - b.start)[0]
    const end = Math.min(start + len, next ? next.start : range.to, 24 * 60)
    return end - start >= 15 ? { start, end } : null
  }

  const place = (t: Task, slot: Busy) => {
    const id = crypto.randomUUID()
    addBlocked({ id, date: dateKey, startMin: slot.start, endMin: slot.end, label: t.title, taskId: t.id })
    setFlash({ text: `${t.title} · ${minToLabel(slot.start)}–${minToLabel(slot.end)}`, undo: () => deleteBlocked(id) })
  }

  /** dropped at an exact time */
  const planAt = (taskId: string, start: number) => {
    const t = tasks.find((x) => x.id === taskId)
    const slot = fit(start)
    setDragTask(null)
    setHoverMin(null)
    if (!t) return
    if (!slot) return setFlash({ text: 'That time is already taken' })
    place(t, slot)
  }

  /** the Plan button: the next free gap, an hour at most */
  const planNext = (t: Task) => {
    const from = startFrom()
    const gap = freeSlots(busy, from, range.to, 30)[0] ?? freeSlots(busy, from, range.to, 15)[0]
    if (!gap) return setFlash({ text: `No free time left ${dateKey === todayKey ? 'today' : 'that day'}` })
    place(t, { start: gap.start, end: Math.min(gap.start + DEFAULT_LEN, gap.end) })
  }

  /** put every task for the day into the free time, important first */
  const autoPlan = () => {
    let current = [...busy]
    const from = startFrom()
    const added: string[] = []
    for (const t of lists.toPlan) {
      const gap = freeSlots(current, from, range.to, 30)[0]
      if (!gap) break
      const end = Math.min(gap.start + DEFAULT_LEN, gap.end)
      const id = crypto.randomUUID()
      addBlocked({ id, date: dateKey, startMin: gap.start, endMin: end, label: t.title, taskId: t.id })
      current = [...current, { start: gap.start, end }]
      added.push(id)
    }
    setFlash(
      added.length
        ? { text: `${added.length} task${added.length === 1 ? '' : 's'} planned into your free time`, undo: () => added.forEach((id) => deleteBlocked(id)) }
        : { text: 'No free time left today' }
    )
  }

  // scroll to the morning (or to now) on open
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const target = dateKey === todayKey ? Math.max(range.from, nowMinutes() - 60) : Math.max(range.from, settings.workStartMin)
    el.scrollTop = Math.max(0, minToY(target) - 16)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey])

  // move a planned block, or stretch it from its bottom edge
  const moveRef = useRef<{ id: string; mode: 'move' | 'resize'; startY: number; origStart: number; origLen: number; start: number; len: number; moved: boolean } | null>(null)
  const [moving, setMoving] = useState<{ id: string; start: number; len: number } | null>(null)
  const beginMove = (e: React.PointerEvent, b: BlockedTime, mode: 'move' | 'resize') => {
    if (!b.taskId || e.button !== 0) return
    e.stopPropagation()
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    const len = b.endMin - b.startMin
    moveRef.current = { id: b.id, mode, startY: e.clientY, origStart: b.startMin, origLen: len, start: b.startMin, len, moved: false }
  }
  const onMove = (e: React.PointerEvent) => {
    const m = moveRef.current
    if (!m) return
    const dy = e.clientY - m.startY
    if (!m.moved && Math.abs(dy) < 5) return
    m.moved = true
    const dMin = (dy / HOUR_H) * 60
    if (m.mode === 'move') m.start = clamp(snap(m.origStart + dMin, 15), range.from, range.to - m.len)
    else m.len = clamp(snap(m.origLen + dMin, 15), 15, range.to - m.origStart)
    setMoving({ id: m.id, start: m.start, len: m.len })
  }
  const endMove = () => {
    const m = moveRef.current
    setMoving(null)
    if (!m || !m.moved) {
      moveRef.current = null
      return
    }
    // keep the ref a moment so the click that follows the drag is ignored
    setTimeout(() => (moveRef.current = null), 0)
    const b = dayBlocks.find((x) => x.id === m.id)
    if (!b) return
    const others = busy.filter((x) => !(x.start === b.startMin && x.end === b.endMin))
    if (others.some((x) => m.start < x.end && m.start + m.len > x.start)) return setFlash({ text: 'That time is already taken' })
    updateBlocked(b.id, { startMin: m.start, endMin: m.start + m.len })
  }

  const dayLabelText = dateKey === todayKey ? 'Today' : dateKey === toDateKey(addDays(new Date(), 1)) ? 'Tomorrow' : format(fromDateKey(dateKey), 'EEEE')
  const nowMin = nowMinutes()
  const hours = useMemo(() => Array.from({ length: (range.to - range.from) / 60 }, (_, i) => range.from + i * 60), [range])

  // the numbers at the top of the list
  const taskBlocks = dayBlocks.filter((b) => b.taskId && allTasks.some((t) => t.id === b.taskId))
  const plannedMin = taskBlocks.reduce((acc, b) => acc + b.endMin - b.startMin, 0)
  const freeFrom = dateKey === todayKey ? Math.max(settings.workStartMin, nowMin) : settings.workStartMin
  const freeMin = freeSlots(busy, freeFrom, settings.workEndMin, 15).reduce((acc, s) => acc + s.end - s.start, 0)
  const toPlan = lists.toPlan.length
  const total = toPlan + taskBlocks.length
  const dayWord = dateKey === todayKey ? 'today' : dayLabelText === 'Tomorrow' ? 'tomorrow' : 'that day'

  // everything on the timeline, laid out in lanes
  const items = [
    ...dayMeetings.map((m) => ({ key: `m:${m.id}`, start: m.startMin, end: m.startMin + m.durationMin })),
    ...dayBlocks.map((b) => {
      const mv = moving?.id === b.id ? moving : null
      const start = mv ? mv.start : b.startMin
      return { key: `b:${b.id}`, start, end: start + (mv ? mv.len : b.endMin - b.startMin) }
    })
  ]
  const lanes = lanesFor(items)
  const boxStyle = (key: string, start: number, end: number) => {
    const l = lanes.get(key) ?? { lane: 0, lanes: 1 }
    const h = minToY(end) - minToY(start)
    return {
      top: minToY(start) + 1,
      height: Math.max(20, h - 2),
      left: `calc(${(l.lane / l.lanes) * 100}% + 4px)`,
      width: `calc(${100 / l.lanes}% - 8px)`
    }
  }
  const compact = (start: number, end: number) => minToY(end) - minToY(start) < 44

  const TaskRow = ({ t }: { t: Task }) => {
    const prog = subtaskProgress(t)
    const late = isOverdue(t, todayKey)
    const due = t.dueDate ? dueLabel(t, todayKey) : null
    return (
      <div
        className={`pl-row${dragTask === t.id ? ' dragging' : ''}`}
        draggable
        onDragStart={(e) => {
          setDragTask(t.id)
          e.dataTransfer.setData('text/task', t.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => {
          setDragTask(null)
          setHoverMin(null)
        }}
      >
        <span className={`pl-dot prio-${t.priority}`} aria-hidden />
        <span className="pl-row-body">
          <span className="pl-row-title">{t.title}</span>
          {(late || due || t.priority === 'high' || prog.total > 0) && (
            <span className="pl-row-meta">
              {late ? <em className="late">Overdue</em> : due && <em>{due}</em>}
              {t.priority === 'high' && (
                <em className="imp">
                  <Flag size={10} /> Important
                </em>
              )}
              {prog.total > 0 && (
                <em>
                  {prog.done}/{prog.total} steps
                </em>
              )}
            </span>
          )}
        </span>
        <button className="pl-plan" onClick={() => planNext(t)} aria-label={`Plan ${t.title} in your next free time`}>
          Plan
        </button>
      </div>
    )
  }

  return (
    <div className="page page-wide pl">
      <header className="tdd-head pl-head">
        <div>
          <h1 className="td-title">Plan my day</h1>
          <p className="td-sub">Give each task a time. Press Plan for your next free slot, or drag it onto the day.</p>
        </div>
        <div className="pl-nav" role="group" aria-label="Day">
          <button onClick={() => setDateKey(toDateKey(addDays(fromDateKey(dateKey), -1)))} aria-label="Previous day">
            <ChevronLeft size={16} />
          </button>
          <button className="pl-nav-day" onClick={() => setDateKey(todayKey)} title={dateKey === todayKey ? undefined : 'Back to today'}>
            <b>{dayLabelText}</b> {format(fromDateKey(dateKey), 'EEE d MMM')}
          </button>
          <button onClick={() => setDateKey(toDateKey(addDays(fromDateKey(dateKey), 1)))} aria-label="Next day">
            <ChevronRight size={16} />
          </button>
        </div>
      </header>

      <div className="pl-grid">
        <aside className="pl-side">
          <div className="pl-sum">
            <div className="pl-sum-top">
              {toPlan > 0 ? (
                <b>
                  {toPlan} to plan <span>{dayWord}</span>
                </b>
              ) : total > 0 ? (
                <b className="ok">
                  <CircleCheck size={18} /> All planned
                </b>
              ) : (
                <b>Nothing due {dayWord}</b>
              )}
              {total > 0 && (
                <small>
                  {taskBlocks.length} of {total}
                </small>
              )}
            </div>
            {total > 0 && (
              <div className="pl-bar" aria-hidden>
                <span style={{ width: `${(taskBlocks.length / total) * 100}%` }} />
              </div>
            )}
            <div className="pl-stats">
              <span>
                <b>{fmtDur(plannedMin)}</b> planned
              </span>
              <span>
                {freeMin ? (
                  <>
                    <b>{fmtDur(freeMin)}</b> free
                  </>
                ) : (
                  'No free time left'
                )}
              </span>
              <span>
                <b>{dayMeetings.length}</b> meeting{dayMeetings.length === 1 ? '' : 's'}
              </span>
            </div>
            {toPlan > 1 && (
              <button className="btn btn-primary pl-auto" onClick={autoPlan}>
                <Wand2 size={15} /> Plan all {toPlan} for me
              </button>
            )}
          </div>

          {toPlan > 0 ? (
            <section className="pl-list" aria-label="To plan">
              {lists.toPlan.map((t) => (
                <TaskRow key={t.id} t={t} />
              ))}
            </section>
          ) : (
            total === 0 && (
              <div className="pl-clear">
                <Sunrise size={20} />
                <span>{lists.anytime.length ? 'A clear day. Pull something in from Anytime below.' : 'A clear day. Enjoy the space.'}</span>
              </div>
            )
          )}

          {lists.anytime.length > 0 && (
            <section className="pl-list">
              <button className="pl-anytime" onClick={() => setShowAnytime((v) => !v)} aria-expanded={showAnytime}>
                <ChevronRight size={14} className={showAnytime ? 'open' : ''} />
                Anytime <span>{lists.anytime.length}</span>
                <small>No due date</small>
              </button>
              {showAnytime && lists.anytime.slice(0, 20).map((t) => <TaskRow key={t.id} t={t} />)}
            </section>
          )}
        </aside>

        <section className={`pl-day${dragTask ? ' targeting' : ''}`} aria-label="Timeline">
          <div className="pl-scroll" ref={scrollRef}>
            <div
              className="pl-col"
              ref={colRef}
              style={{ height: minToY(range.to) }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const m = minAtClientY(e.clientY)
                if (m !== null && m !== hoverMin) setHoverMin(m)
              }}
              onDragLeave={(e) => {
                if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setHoverMin(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                const id = e.dataTransfer.getData('text/task') || dragTask
                const m = minAtClientY(e.clientY)
                if (id && m !== null) planAt(id, m)
              }}
              onPointerMove={onMove}
              onPointerUp={endMove}
              onPointerCancel={endMove}
            >
              {/* outside working hours, gently dimmed */}
              {settings.workStartMin > range.from && <div className="pl-off" style={{ top: 0, height: minToY(Math.min(settings.workStartMin, range.to)) }} />}
              {settings.workEndMin < range.to && <div className="pl-off" style={{ top: minToY(Math.max(settings.workEndMin, range.from)), bottom: 0 }} />}

              {hours.map((h) => (
                <div key={h} className="pl-hour" style={{ top: minToY(h) }}>
                  <span>{minToLabel(h).replace(':00', '')}</span>
                </div>
              ))}
              {hours.map((h) => (
                <div key={`h${h}`} className="pl-half" style={{ top: minToY(h + 30) }} />
              ))}

              {dragTask && slots.map((s) => <div key={`${s.start}-${s.end}`} className="pl-free" style={{ top: minToY(s.start) + 1, height: minToY(s.end) - minToY(s.start) - 2 }} />)}

              {dayMeetings.map((m) => {
                const end = m.startMin + m.durationMin
                return (
                  <div
                    key={m.id}
                    className={`pl-ev meeting${compact(m.startMin, end) ? ' compact' : ''}`}
                    style={{ ...boxStyle(`m:${m.id}`, m.startMin, end), ['--c' as string]: typeById(m.type).color }}
                    title={`${m.title} · ${minToLabel(m.startMin)}–${minToLabel(end)}${m.personName ? ` · ${m.personName}` : ''}`}
                  >
                    <span className="pl-ev-text">
                      <b>
                        <Video size={12} /> {m.title}
                      </b>
                      <small>
                        {minToLabel(m.startMin)}
                        {m.personName ? ` · ${m.personName}` : ''}
                      </small>
                    </span>
                  </div>
                )
              })}

              {dayBlocks.map((b) => {
                const task = b.taskId ? allTasks.find((t) => t.id === b.taskId) : undefined
                const mv = moving?.id === b.id ? moving : null
                const start = mv ? mv.start : b.startMin
                const end = start + (mv ? mv.len : b.endMin - b.startMin)
                if (!b.taskId)
                  return (
                    <div key={b.id} className={`pl-ev block${compact(start, end) ? ' compact' : ''}`} style={boxStyle(`b:${b.id}`, start, end)} title={b.label}>
                      <span className="pl-ev-text">
                        <b>{b.label || 'Busy'}</b>
                        <small>
                          {minToLabel(start)} – {minToLabel(end)}
                        </small>
                      </span>
                    </div>
                  )
                return (
                  <div
                    key={b.id}
                    className={`pl-ev task${task?.done ? ' done' : ''}${mv ? ' moving' : ''}${compact(start, end) ? ' compact' : ''}`}
                    style={boxStyle(`b:${b.id}`, start, end)}
                    onPointerDown={(e) => beginMove(e, b, 'move')}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (moveRef.current?.moved) return
                      if (task) openTaskEditor(task.id)
                    }}
                  >
                    {task && (
                      <button
                        className={`pl-ev-check${task.done ? ' on' : ''}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleTask(task.id)
                          if (!task.done) notifyTask('completed', { ...task, done: true })
                        }}
                        aria-label={task.done ? 'Mark not done' : 'Mark done'}
                      >
                        <Check size={10} strokeWidth={3.4} />
                      </button>
                    )}
                    <span className="pl-ev-text">
                      <b>{task ? task.title : b.label}</b>
                      <small>
                        {minToLabel(start)} – {minToLabel(end)}
                      </small>
                    </span>
                    <button
                      className="pl-ev-x"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteBlocked(b.id)
                      }}
                      aria-label="Take off the plan"
                    >
                      <X size={13} />
                    </button>
                    <span className="pl-ev-resize" onPointerDown={(e) => beginMove(e, b, 'resize')} aria-hidden />
                  </div>
                )
              })}

              {hoverMin !== null &&
                dragTask &&
                (() => {
                  const slot = fit(hoverMin)
                  const t = tasks.find((x) => x.id === dragTask)
                  const end = slot ? slot.end : Math.min(hoverMin + DEFAULT_LEN, range.to)
                  return (
                    <div className={`pl-ghost${slot ? '' : ' taken'}`} style={{ top: minToY(hoverMin) + 1, height: Math.max(20, minToY(end) - minToY(hoverMin) - 2) }}>
                      <b>{slot ? t?.title : 'That time is taken'}</b>
                      {slot && (
                        <small>
                          {minToLabel(slot.start)} – {minToLabel(slot.end)}
                        </small>
                      )}
                    </div>
                  )
                })()}

              {dateKey === todayKey && nowMin >= range.from && nowMin <= range.to && (
                <div className="pl-now" style={{ top: minToY(nowMin) }}>
                  <span>{minToLabel(nowMin)}</span>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {flash && (
        <div className="td-snack" key={flash.text}>
          <Check size={16} strokeWidth={3} />
          <span>{flash.text}</span>
          {flash.undo && (
            <button
              onClick={() => {
                flash.undo!()
                setFlash(null)
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  )
}
