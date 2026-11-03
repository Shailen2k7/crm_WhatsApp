/**
 * Board view for tasks — To do · In progress · Done.
 * Drag a card between columns on a computer; on a phone the columns scroll
 * sideways and each card has a "Move" button, so nothing needs explaining.
 */
import { useMemo, useState } from 'react'
import { CalendarDays, Check, ChevronRight, Flag, GripVertical, ListChecks, MoveRight, Plus } from 'lucide-react'
import { useStore } from '../store/useStore'
import { notifyTask } from '../lib/notify'
import { dueLabel, isOverdue, STATUS_LABEL, STATUS_ORDER, statusOf, subtaskProgress } from '../lib/tasks'
import { toDateKey } from '../lib/time'
import { initialsOf, useWorkspace } from '../lib/workspace'
import type { Task, TaskStatus } from '../types'

const PRIO_RANK = { high: 0, medium: 1, low: 2 }

export default function TaskBoard({ tasks, team, onNew }: { tasks: Task[]; team: boolean; onNew?: () => void }) {
  const updateTask = useStore((s) => s.updateTask)
  const openTaskEditor = useStore((s) => s.openTaskEditor)
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<TaskStatus | null>(null)
  const [moveFor, setMoveFor] = useState<string | null>(null)
  const todayKey = toDateKey(new Date())

  const columns = useMemo(() => {
    const by: Record<TaskStatus, Task[]> = { todo: [], in_progress: [], done: [] }
    for (const t of tasks) by[statusOf(t)].push(t)
    const dueKey = (t: Task) => t.dueDate ?? '9999-99-99'
    by.todo.sort((a, b) => dueKey(a).localeCompare(dueKey(b)) || PRIO_RANK[a.priority] - PRIO_RANK[b.priority])
    by.in_progress.sort((a, b) => dueKey(a).localeCompare(dueKey(b)) || PRIO_RANK[a.priority] - PRIO_RANK[b.priority])
    by.done.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    by.done = by.done.slice(0, 40)
    return by
  }, [tasks])

  const moveTo = (id: string, status: TaskStatus) => {
    const t = useStore.getState().tasks.find((x) => x.id === id)
    if (!t || statusOf(t) === status) return
    updateTask(id, { status })
    if (status === 'done') notifyTask('completed', { ...t, done: true })
    setMoveFor(null)
  }

  return (
    <div className="tb" role="list" aria-label="Task board">
      {STATUS_ORDER.map((st) => {
        const list = columns[st]
        return (
          <section
            key={st}
            className={`tb-col tb-${st}${over === st && dragId ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (over !== st) setOver(st)
            }}
            onDragLeave={(e) => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              const id = e.dataTransfer.getData('text/task') || dragId
              if (id) moveTo(id, st)
              setDragId(null)
              setOver(null)
            }}
          >
            <header className="tb-head">
              <span className={`tb-dot st-${st}`} />
              <h2>{STATUS_LABEL[st]}</h2>
              <span className="tb-count">{list.length}</span>
              {st === 'todo' && onNew && (
                <button className="tb-add" onClick={onNew} aria-label="New task" title="New task">
                  <Plus size={16} strokeWidth={2.5} />
                </button>
              )}
            </header>

            <div className="tb-cards">
              {list.length === 0 && (
                <div className="tb-empty">{st === 'todo' ? 'Nothing waiting. Add a task above.' : st === 'in_progress' ? 'Drag a card here when you start on it.' : 'Finished tasks land here.'}</div>
              )}
              {list.map((t) => {
                const prog = subtaskProgress(t)
                const due = dueLabel(t, todayKey)
                const late = isOverdue(t, todayKey)
                return (
                  <article
                    key={t.id}
                    className={`tb-card prio-${t.priority}${dragId === t.id ? ' dragging' : ''}${t.done ? ' done' : ''}`}
                    draggable
                    onDragStart={(e) => {
                      setDragId(t.id)
                      e.dataTransfer.setData('text/task', t.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => {
                      setDragId(null)
                      setOver(null)
                    }}
                    onClick={() => openTaskEditor(t.id)}
                    role="listitem"
                  >
                    <div className="tb-card-top">
                      <span className={`tb-prio p-${t.priority}`}>
                        {t.priority === 'high' && <Flag size={10} />}
                        {t.priority[0].toUpperCase() + t.priority.slice(1)}
                      </span>
                      <span className="tb-grip" aria-hidden>
                        <GripVertical size={14} />
                      </span>
                    </div>
                    <h3 className="tb-title" title={t.title}>
                      {t.title}
                    </h3>
                    {prog.total > 0 && (
                      <div className="tb-steps" title={`${prog.done} of ${prog.total} steps done`}>
                        <ListChecks size={12} />
                        <span className="tb-steps-bar">
                          <span style={{ width: `${(prog.done / prog.total) * 100}%` }} />
                        </span>
                        <span>
                          {prog.done}/{prog.total}
                        </span>
                      </div>
                    )}
                    <div className="tb-foot">
                      {due && (
                        <span className={`td-chip${late ? ' red' : ''}`}>
                          <CalendarDays size={12} />
                          {due}
                        </span>
                      )}
                      {team && <Avatar userId={t.assignedTo} invite={t.assignedInvite} />}
                      <span className="tb-foot-grow" />
                      {st !== 'done' ? (
                        <button
                          className="tb-move"
                          onClick={(e) => {
                            e.stopPropagation()
                            setMoveFor(moveFor === t.id ? null : t.id)
                          }}
                          aria-label="Move to another column"
                        >
                          <MoveRight size={14} />
                        </button>
                      ) : (
                        <span className="tb-done-mark">
                          <Check size={12} strokeWidth={3} />
                        </span>
                      )}
                    </div>
                    {moveFor === t.id && (
                      <div className="tb-move-menu" onClick={(e) => e.stopPropagation()}>
                        {STATUS_ORDER.filter((s) => s !== st).map((s) => (
                          <button key={s} onClick={() => moveTo(t.id, s)}>
                            <ChevronRight size={14} /> {STATUS_LABEL[s]}
                          </button>
                        ))}
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function Avatar({ userId, invite }: { userId?: string; invite?: string }) {
  const me = useWorkspace((s) => s.me)
  const member = useWorkspace((s) => s.member)
  const memberName = useWorkspace((s) => s.memberName)
  const invitedName = useWorkspace((s) => (invite ? s.pendingName(invite) : ''))
  if (invite) {
    const n = invitedName
    return (
      <span className="tb-avatar invited" title={`${n} · invited, gets it when they join`}>
        {initialsOf(n)}
      </span>
    )
  }
  if (!userId) return <span className="tb-avatar none" title="Unassigned">?</span>
  const m = member(userId)
  return (
    <span className={`tb-avatar${userId === me ? ' me' : ''}`} title={memberName(userId)}>
      {userId === me ? 'Me' : initialsOf(m?.name ?? '', m?.email ?? '')}
    </span>
  )
}
