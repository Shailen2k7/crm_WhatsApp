import { useEffect, useMemo, useRef, useState } from 'react'
import { addDays, format } from 'date-fns'
import {
  ArrowUp,
  ArrowUpDown,
  BellRing,
  CalendarDays,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  Flag,
  LayoutGrid,
  List as ListIcon,
  ListChecks,
  Pencil,
  Search,
  Sun,
  Sunrise,
  Trash2,
  UserRound,
  X
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { notifyTask } from '../lib/notify'
import { parseDate, parseTime } from '../lib/assistant'
import { fromDateKey, hhmmToMin, toDateKey } from '../lib/time'
import { parseRepeat } from '../lib/recurrence'
import Select from '../components/Select'
import VoiceButton from '../components/VoiceButton'
import { InboxButton } from '../components/NotificationsPanel'
import { initialsOf, taskScope, useWorkspace, type TaskScope } from '../lib/workspace'
import TaskBoard from '../components/TaskBoard'
import PeopleMenu from '../components/PeopleMenu'
import InviteModal from '../components/InviteModal'
import { assignFromKey, matchPeople, mentionAt, personName, resolveMention, usePeople } from '../lib/people'
import { dueLabel, isOverdue as isLate, subtaskProgress } from '../lib/tasks'
import type { Subtask, Task } from '../types'

/* ================= list ⇄ board ================= */

type TaskLayout = 'list' | 'board'
const LAYOUT_KEY = 'msos-tasks-layout'
const readLayout = (): TaskLayout => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'board' ? 'board' : 'list'
  } catch {
    return 'list'
  }
}
const useLayout = () => {
  const [layout, set] = useState<TaskLayout>(readLayout)
  const setLayout = (l: TaskLayout) => {
    set(l)
    try {
      localStorage.setItem(LAYOUT_KEY, l)
    } catch {
      /* ignore */
    }
  }
  return [layout, setLayout] as const
}

function LayoutToggle({ layout, setLayout }: { layout: TaskLayout; setLayout: (l: TaskLayout) => void }) {
  return (
    <div className="segmented td-layout" role="tablist" aria-label="Layout">
      <button role="tab" aria-selected={layout === 'list'} className={layout === 'list' ? 'active' : ''} onClick={() => setLayout('list')} title="List">
        <ListIcon size={15} /> <span>List</span>
      </button>
      <button role="tab" aria-selected={layout === 'board'} className={layout === 'board' ? 'active' : ''} onClick={() => setLayout('board')} title="Board">
        <LayoutGrid size={15} /> <span>Board</span>
      </button>
    </div>
  )
}

/** the steps of a task, ticked off right in the list */
function StepRows({ task }: { task: Task }) {
  const updateTask = useStore((s) => s.updateTask)
  const list = task.subtasks ?? []
  const toggle = (st: Subtask) => {
    const next = list.map((x) => (x.id === st.id ? { ...x, done: !x.done } : x))
    updateTask(task.id, { subtasks: next })
    buzz(6)
  }
  return (
    <ul className="td-steps" onClick={(e) => e.stopPropagation()}>
      {list.map((st) => (
        <li key={st.id} className={st.done ? 'done' : ''}>
          <button className={`td-check xs${st.done ? ' on' : ''}`} onClick={() => toggle(st)} aria-label={st.done ? 'Mark step not done' : 'Mark step done'}>
            <Check size={10} strokeWidth={3.4} />
          </button>
          <span>{st.title}</span>
        </li>
      ))}
    </ul>
  )
}

type Tab = 'today' | 'upcoming' | 'anytime' | 'done'

/* ================= team workspace: My · Assigned by me · Team ================= */

/** a company workspace is open: tasks get the three scope tabs and a "who" column */
const useTeamMode = () => useWorkspace((s) => s.available && s.workspaces.find((w) => w.id === s.activeId)?.kind === 'company')

const SCOPES: { id: TaskScope; label: string }[] = [
  { id: 'mine', label: 'My tasks' },
  { id: 'by_me', label: 'Assigned by me' },
  { id: 'team', label: 'Team tasks' }
]

/** the store's tasks narrowed to one scope (all of them outside a company workspace) */
const useScopedTasks = (scope: TaskScope) => {
  const all = useStore((s) => s.tasks)
  const me = useWorkspace((s) => s.me)
  const team = useTeamMode()
  return useMemo(() => {
    const counts: Record<TaskScope, number> = { mine: 0, by_me: 0, team: 0 }
    if (team) for (const t of all) if (!t.done) counts[taskScope(t, me)]++
    return { team, counts, tasks: team ? all.filter((t) => taskScope(t, me) === scope) : all }
  }, [all, me, team, scope])
}

function ScopeTabs({ scope, setScope, counts }: { scope: TaskScope; setScope: (s: TaskScope) => void; counts: Record<TaskScope, number> }) {
  return (
    <div className="segmented scope-tabs" role="tablist">
      {SCOPES.map((s) => (
        <button key={s.id} role="tab" aria-selected={scope === s.id} className={scope === s.id ? 'active' : ''} onClick={() => setScope(s.id)}>
          {s.label}
          {counts[s.id] > 0 && <span className="scope-count">{counts[s.id]}</span>}
        </button>
      ))}
    </div>
  )
}

/** "PS Priya" — who a task is for, shown when it is not the signed-in person */
function Who({ userId, invite, always }: { userId?: string; invite?: string; always?: boolean }) {
  const me = useWorkspace((s) => s.me)
  const memberName = useWorkspace((s) => s.memberName)
  const member = useWorkspace((s) => s.member)
  // subscribe to the name itself, so it fills in when the invite list arrives
  const invitedName = useWorkspace((s) => (invite ? s.pendingName(invite) : ''))
  if (invite) {
    const n = invitedName
    return (
      <span className="who invited" title="Invited, gets this task when they join">
        <span className="user-avatar">{initialsOf(n)}</span>
        {n.split(' ')[0]} <em>invited</em>
      </span>
    )
  }
  if (!userId) return always ? <span className="tdd-muted">Unassigned</span> : null
  if (userId === me && !always) return null
  const m = member(userId)
  return (
    <span className={`who${userId === me ? ' me' : ''}`} title={m?.email}>
      <span className="user-avatar">{userId === me ? 'Me' : initialsOf(m?.name ?? '', m?.email ?? '')}</span>
      {memberName(userId)}
    </span>
  )
}

export const dayLabel = (dateKey: string, todayKey: string): string => {
  if (dateKey === todayKey) return 'Today'
  const diff = Math.round((fromDateKey(dateKey).getTime() - fromDateKey(todayKey).getTime()) / 86_400_000)
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return format(fromDateKey(dateKey), diff > 1 && diff < 7 ? 'EEEE' : 'EEE d MMM')
}

/** remove the date/time words the parser understood, keep the subject */
export const stripWhen = (t: string) =>
  t
    .replace(/\b(?:on\s+)?\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?\b/gi, '')
    .replace(/\b(?:on\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi, '')
    .replace(/\b(?:on\s+|by\s+|due\s+)?(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '')
    .replace(/\b(?:by\s+|due\s+)?(?:today|tonight|tomorrow)\b/gi, '')
    .replace(/\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, '')
    .replace(/\b(?:at\s+)?\d{1,2}:\d{2}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
    .replace(/\s+\b(?:on|at|by|for)$/i, '')
    .trim()

export const buzz = (ms = 12) => {
  try {
    // browsers only allow vibration after the user has interacted with the page
    const ua = (navigator as unknown as { userActivation?: { hasBeenActive: boolean } }).userActivation
    if (ua && !ua.hasBeenActive) return
    navigator.vibrate?.(ms)
  } catch {
    /* unsupported */
  }
}

function MobileTasks() {
  const toggleTask = useStore((s) => s.toggleTask)
  const openTaskEditor = useStore((s) => s.openTaskEditor)
  const wsOn = useWorkspace((s) => s.available && s.workspaces.some((w) => w.kind === 'company'))

  const [scope, setScope] = useState<TaskScope>('mine')
  const { tasks, team, counts: scopeCounts } = useScopedTasks(scope)
  const [layout, setLayout] = useLayout()
  const [tab, setTab] = useState<Tab>('today')
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const [snack, setSnack] = useState<{ text: string; undo: () => void; key: number } | null>(null)
  const todayKey = toDateKey(new Date())

  useEffect(() => {
    if (!snack) return
    const t = setTimeout(() => setSnack(null), 4500)
    return () => clearTimeout(t)
  }, [snack])

  const items = useMemo(() => {
    const open = tasks.filter((t) => !t.done)
    const prio = (t: Task) => ({ high: 0, medium: 1, low: 2 })[t.priority] ?? 1
    const byPrio = (a: Task, b: Task) => prio(a) - prio(b)
    const overdue = open.filter((t) => isLate(t, todayKey)).sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1))
    const today = open.filter((t) => t.dueDate === todayKey && !isLate(t, todayKey)).sort(byPrio)
    const future = open
      .filter((t) => t.dueDate && t.dueDate > todayKey)
      .sort((a, b) => (a.dueDate === b.dueDate ? byPrio(a, b) : a.dueDate! < b.dueDate! ? -1 : 1))
    const anytime = open.filter((t) => !t.dueDate).sort(byPrio)
    const done = tasks
      .filter((t) => t.done)
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, 30)
    return { overdue, today, future, anytime, done }
  }, [tasks, todayKey])

  const counts = {
    today: items.overdue.length + items.today.length,
    upcoming: items.future.length,
    anytime: items.anytime.length,
    done: items.done.length
  }

  const complete = (t: Task) => {
    buzz()
    setLeaving((s) => new Set(s).add(t.id))
    setTimeout(() => {
      toggleTask(t.id)
      notifyTask('completed', { ...t, done: true })
      setSnack({ text: 'Task completed', undo: () => toggleTask(t.id), key: Date.now() })
      setLeaving((s) => {
        const n = new Set(s)
        n.delete(t.id)
        return n
      })
    }, 320)
  }

  const row = (t: Task, isDone = false) => (
    <TaskRow
      key={t.id}
      task={t}
      todayKey={todayKey}
      done={isDone}
      leaving={leaving.has(t.id)}
      who={team}
      onCheck={() => (isDone ? (buzz(), toggleTask(t.id)) : complete(t))}
      onOpen={() => openTaskEditor(t.id)}
    />
  )

  const futureGroups = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of items.future) {
      const list = map.get(t.dueDate!) ?? []
      list.push(t)
      map.set(t.dueDate!, list)
    }
    return [...map.entries()]
  }, [items.future])

  const TABS: { id: Tab; label: string }[] = [
    { id: 'today', label: 'Today' },
    { id: 'upcoming', label: 'Upcoming' },
    { id: 'anytime', label: 'Anytime' },
    { id: 'done', label: 'Done' }
  ]

  return (
    <div className="page td-page">
      <header className="td-head">
        <div>
          <h1 className="td-title">Tasks</h1>
          <p className="td-sub">
            {format(new Date(), 'EEEE, d MMMM')}
            {counts.today > 0 && ` · ${counts.today} for today`}
          </p>
        </div>
        <div className="td-head-right">
          <LayoutToggle layout={layout} setLayout={setLayout} />
          {wsOn && <InboxButton className="btn btn-secondary btn-icon td-inbox" label={false} />}
        </div>
      </header>

      <QuickAdd defaultToday={tab === 'today'} />

      {team && <ScopeTabs scope={scope} setScope={setScope} counts={scopeCounts} />}

      {layout === 'board' && <TaskBoard tasks={tasks} team={team} />}

      {layout === 'list' && (
      <nav className="td-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
            {counts[t.id] > 0 && <span className="td-tabcount">{counts[t.id]}</span>}
          </button>
        ))}
      </nav>
      )}

      {layout === 'list' && (
      <div className="td-list" key={tab}>
        {tab === 'today' &&
          (counts.today === 0 ? (
            <Empty icon={<Sun size={26} />} title="All clear for today" sub="Type above to add something — it takes two seconds." />
          ) : (
            <>
              {items.overdue.length > 0 && (
                <section>
                  <h2 className="td-sec td-sec-red">Overdue</h2>
                  {items.overdue.map((t) => row(t))}
                </section>
              )}
              {items.today.length > 0 && (
                <section>
                  {items.overdue.length > 0 && <h2 className="td-sec">Today</h2>}
                  {items.today.map((t) => row(t))}
                </section>
              )}
            </>
          ))}

        {tab === 'upcoming' &&
          (futureGroups.length === 0 ? (
            <Empty icon={<Sunrise size={26} />} title="Nothing planned ahead" sub="Try “Send proposal tomorrow” in the box above." />
          ) : (
            futureGroups.map(([date, list]) => (
              <section key={date}>
                <h2 className="td-sec">
                  {dayLabel(date, todayKey)}
                  <span>{format(fromDateKey(date), 'd MMM')}</span>
                </h2>
                {list.map((t) => row(t))}
              </section>
            ))
          ))}

        {tab === 'anytime' &&
          (items.anytime.length === 0 ? (
            <Empty icon={<CalendarDays size={26} />} title="No undated tasks" sub="Tasks without a date land here." />
          ) : (
            items.anytime.map((t) => row(t))
          ))}

        {tab === 'done' &&
          (items.done.length === 0 ? (
            <Empty icon={<CheckCircle2 size={26} />} title="Nothing completed yet" sub="Tick something off — it feels great." />
          ) : (
            items.done.map((t) => row(t, true))
          ))}
      </div>
      )}

      {snack && (
        <div className="td-snack" key={snack.key}>
          <Check size={16} strokeWidth={3} />
          <span>{snack.text}</span>
          <button
            onClick={() => {
              snack.undo()
              setSnack(null)
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  )
}

/* ================= row ================= */

function TaskRow({
  task,
  todayKey,
  done,
  leaving,
  who,
  onCheck,
  onOpen
}: {
  task: Task
  todayKey: string
  done: boolean
  leaving: boolean
  /** team workspace: show who the task is for */
  who?: boolean
  onCheck: () => void
  onOpen: () => void
}) {
  const overdue = !done && isLate(task, todayKey)
  const important = task.priority === 'high'
  const prog = subtaskProgress(task)
  const [open, setOpen] = useState(false)
  const due = dueLabel(task, todayKey)

  return (
    <div className={`td-row${done ? ' done' : ''}${leaving ? ' leaving' : ''}${open ? ' open' : ''}`}>
      <button
        className={`td-check${important ? ' imp' : ''}${done || leaving ? ' on' : ''}`}
        onClick={onCheck}
        aria-label={done ? 'Mark as not done' : 'Mark as done'}
      >
        <Check size={14} strokeWidth={3.2} />
      </button>
      <button className="td-body" onClick={onOpen}>
        <span className="td-rtitle" title={task.title}>{task.title}</span>
        <span className="td-meta">
          {due && (task.dueDate !== todayKey || task.dueTime !== undefined) && (
            <span className={`td-chip${overdue ? ' red' : ''}`}>
              <CalendarDays size={12} />
              {due}
            </span>
          )}
          {prog.total > 0 && (
            <span className={`td-chip td-chip-steps${prog.done === prog.total ? ' all' : ''}`}>
              <ListChecks size={12} />
              {prog.done}/{prog.total}
            </span>
          )}
          {important && (
            <span className="td-chip red">
              <Flag size={11} /> Important
            </span>
          )}
          {who && task.status === 'in_progress' && <span className="td-chip prog">In progress</span>}
          {who && (
            <span className="td-chip">
              <Who userId={task.assignedTo} invite={task.assignedInvite} />
            </span>
          )}
          {task.notes && <span className="td-notes">{task.notes}</span>}
        </span>
        {open && prog.total > 0 && <StepRows task={task} />}
      </button>
      {prog.total > 0 && (
        <button
          className={`td-expand${open ? ' on' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            setOpen((v) => !v)
          }}
          aria-label={open ? 'Hide steps' : 'Show steps'}
          aria-expanded={open}
        >
          <ChevronDown size={16} />
        </button>
      )}
    </div>
  )
}

export function Empty({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="td-empty">
      <div className="td-empty-ico">{icon}</div>
      <div className="td-empty-title">{title}</div>
      <div className="td-empty-sub">{sub}</div>
    </div>
  )
}

/* ================= quick add (tasks only) ================= */

function QuickAdd({ defaultToday }: { defaultToday: boolean }) {
  const addTask = useStore((s) => s.addTask)
  const setView = useStore((s) => s.setView)
  const inputRef = useRef<HTMLInputElement>(null)
  const dateRef = useRef<HTMLInputElement>(null)

  const [text, setText] = useState('')
  const [chipDate, setChipDate] = useState<string | null>(null)
  const [important, setImportant] = useState(false)
  const [focused, setFocused] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  // who it's for: picked from "@" or the Assign chip (null = me, as before)
  const { people, showLoad, me, company } = usePeople()
  const isAdmin = useWorkspace((s) => s.isAdmin())
  const [assignee, setAssignee] = useState<string | null>(null)
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [chipMenu, setChipMenu] = useState(false)
  const [chipFilter, setChipFilter] = useState('')
  const [hl, setHl] = useState(0)
  const [inviting, setInviting] = useState(false)
  const menuPeople = mention ? matchPeople(people, mention.query).slice(0, 8) : chipMenu ? matchPeople(people, chipFilter) : []
  const menuOpen = company && (!!mention || chipMenu)

  const todayKey = toDateKey(new Date())
  const tomorrowKey = toDateKey(addDays(new Date(), 1))

  // header "New task" button jumps here
  useEffect(() => {
    const go = () => setTimeout(() => inputRef.current?.focus(), 30)
    window.addEventListener('msos:quick-add', go)
    return () => window.removeEventListener('msos:quick-add', go)
  }, [])

  const parsedDate = text ? parseDate(text) : null
  const parsedTime = text ? parseTime(text) : null
  // a repeat phrase means they probably want a reminder, not a task
  const looksLikeReminder = !!text && !!parseRepeat(text)

  const taskDate = chipDate ?? parsedDate ?? (parsedTime ? todayKey : null) ?? (defaultToday ? todayKey : null)
  const taskTime = parsedTime && taskDate ? hhmmToMin(parsedTime) : undefined
  // "@priya" typed in full (without picking from the list) still counts
  const typed = company && !mention && text.includes('@') ? resolveMention(people, text) : null
  const who = assignee ?? typed?.key ?? null
  const title = stripWhen(typed?.text ?? text) || (typed?.text ?? text).trim()
  const forOther = !!who && who !== me
  const open = focused || text.length > 0 || !!chipDate || important || !!assignee || chipMenu

  const reset = () => {
    setText('')
    setChipDate(null)
    setImportant(false)
    setAssignee(null)
    setMention(null)
  }

  /** the "@pri" just typed becomes a chip; the text loses it */
  const pick = (key: string) => {
    if (mention) {
      const caret = inputRef.current?.selectionStart ?? text.length
      const next = (text.slice(0, mention.start) + text.slice(caret)).replace(/\s{2,}/g, ' ')
      setText(next.trimStart())
      setMention(null)
      setTimeout(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        const at = Math.min(mention.start, el.value.length)
        el.setSelectionRange(at, at)
      }, 0)
    }
    setChipMenu(false)
    setChipFilter('')
    setAssignee(key)
  }

  const onType = (value: string, caret: number) => {
    setText(value)
    const m = company ? mentionAt(value, caret) : null
    setMention(m)
    if (m) {
      setChipMenu(false)
      setHl(0)
    }
  }

  const save = () => {
    if (!title) {
      inputRef.current?.focus()
      return
    }
    const t: Task = {
      id: crypto.randomUUID(),
      title,
      priority: important ? 'high' : 'medium',
      done: false,
      dueDate: taskDate ?? undefined,
      dueTime: taskTime,
      createdAt: Date.now(),
      ...(who ? assignFromKey(who) : {})
    }
    addTask(t)
    notifyTask('created', t)
    setFlash(`${forOther ? `Assigned to ${personName(people, who!)}` : 'Task added'}${t.dueDate ? ` · ${dueLabel(t, todayKey)}` : ''}`)
    buzz(8)
    reset()
    inputRef.current?.focus()
    setTimeout(() => setFlash(null), 1800)
  }

  const toReminders = () => {
    // hand the typed text to the Reminders page, where times and repeats live
    try {
      sessionStorage.setItem('msos:rem-handoff', text)
    } catch {
      /* ignore */
    }
    setView('reminders')
  }

  const openPicker = (el: HTMLInputElement | null) => {
    try {
      el?.showPicker?.()
    } catch {
      /* the transparent input under the finger opens it on mobile */
    }
  }

  return (
    <div className={`td-add${open ? ' open' : ''}`}>
      <div className="td-add-row">
        <input
          ref={inputRef}
          id="td-quickadd"
          className="td-add-input"
          placeholder={company ? 'What needs doing? Type @ to assign it' : 'What do you need to do?'}
          value={text}
          onChange={(e) => onType(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onFocus={() => setFocused(true)}
          onBlur={() =>
            setTimeout(() => {
              setFocused(false)
              setMention(null)
            }, 150)
          }
          onKeyDown={(e) => {
            if (mention && menuPeople.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setHl((h) => (e.key === 'ArrowDown' ? Math.min(h + 1, menuPeople.length - 1) : Math.max(h - 1, 0)))
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                pick(menuPeople[Math.min(hl, menuPeople.length - 1)].key)
                return
              }
            }
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') {
              if (mention || chipMenu) {
                setMention(null)
                setChipMenu(false)
                return
              }
              reset()
              inputRef.current?.blur()
            }
          }}
          aria-autocomplete={company ? 'list' : undefined}
          aria-expanded={company ? !!menuOpen : undefined}
          enterKeyHint="done"
          autoComplete="off"
        />
        <VoiceButton mode="task" className="td-mic" label="Say the task" />
        {text.trim() && (
          <button className="td-add-send" onMouseDown={(e) => e.preventDefault()} onClick={save} aria-label="Save">
            <ArrowUp size={18} strokeWidth={2.6} />
          </button>
        )}
      </div>

      {menuOpen && (
        <PeopleMenu
          people={menuPeople}
          active={Math.min(hl, Math.max(0, menuPeople.length - 1))}
          showLoad={showLoad}
          selected={who ?? undefined}
          onHover={setHl}
          onPick={(p) => pick(p.key)}
          filter={chipMenu ? chipFilter : undefined}
          onFilter={chipMenu ? setChipFilter : undefined}
          onInvite={
            isAdmin
              ? () => {
                  setChipMenu(false)
                  setMention(null)
                  setInviting(true)
                }
              : undefined
          }
        />
      )}
      {inviting && <InviteModal onClose={() => setInviting(false)} />}

      {open && (
        <div className="td-tools" onMouseDown={(e) => e.preventDefault()}>
          {company && (
            <button
              className={`td-tool who-chip${forOther ? ' on' : ''}`}
              onClick={() => {
                setMention(null)
                setChipFilter('')
                setHl(0)
                setChipMenu(!chipMenu)
              }}
              aria-haspopup="listbox"
              aria-expanded={chipMenu}
            >
              <UserRound size={14} />
              {forOther ? personName(people, who!) : 'Assign'}
            </button>
          )}
          {company && assignee && (
            <button className="td-tool ghost" onClick={() => setAssignee(null)} aria-label="Back to me">
              <X size={14} />
            </button>
          )}
          <button className={`td-tool${chipDate === todayKey ? ' on' : ''}`} onClick={() => setChipDate(chipDate === todayKey ? null : todayKey)}>
            <Sun size={14} /> Today
          </button>
          <button className={`td-tool${chipDate === tomorrowKey ? ' on' : ''}`} onClick={() => setChipDate(chipDate === tomorrowKey ? null : tomorrowKey)}>
            <Sunrise size={14} /> Tomorrow
          </button>
          <label className={`td-tool${chipDate && chipDate !== todayKey && chipDate !== tomorrowKey ? ' on' : ''}`} onClick={() => openPicker(dateRef.current)}>
            <CalendarDays size={14} />
            {chipDate && chipDate !== todayKey && chipDate !== tomorrowKey ? format(fromDateKey(chipDate), 'EEE d MMM') : 'Date'}
            <input ref={dateRef} type="date" className="td-native" value={chipDate ?? ''} min={todayKey} onChange={(e) => setChipDate(e.target.value || null)} />
          </label>
          <button className={`td-tool imp${important ? ' on' : ''}`} onClick={() => setImportant(!important)}>
            <Flag size={14} /> Important
          </button>
          {chipDate && (
            <button className="td-tool ghost" onClick={() => setChipDate(null)} aria-label="Clear date">
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {(text.trim() || flash) && (
        <div className={`td-preview${flash ? ' ok' : ''}`}>
          {flash ? (
            <>
              <Check size={13} strokeWidth={3} /> {flash}
            </>
          ) : (
            <>
              <CheckSquare size={13} />
              <b>{title || '…'}</b>
              <span>· {taskDate ? dueLabel({ dueDate: taskDate, dueTime: taskTime }, todayKey) : 'No date'}</span>
              {forOther && <span className="td-prev-who">→ {personName(people, who!)}</span>}
              {important && <span className="red">· Important</span>}
              <button className="td-save" onMouseDown={(e) => e.preventDefault()} onClick={save}>
                {forOther ? 'Assign task' : 'Add task'}
              </button>
            </>
          )}
        </div>
      )}

      {looksLikeReminder && !flash && (
        <button className="td-handoff" onMouseDown={(e) => e.preventDefault()} onClick={toReminders}>
          <BellRing size={13} /> Want it to ring? Make it a <b>reminder</b> →
        </button>
      )}
    </div>
  )
}

/* ================= desktop ================= */

export const useIsDesktop = () => {
  const q = '(min-width: 900px)'
  const [match, setMatch] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setMatch(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return match
}

export default function TasksView() {
  return useIsDesktop() ? <DesktopTasks /> : <MobileTasks />
}

type Pill = 'all' | 'today' | 'upcoming' | 'anytime' | 'overdue' | 'done'
type SortKey = 'due' | 'priority' | 'name' | 'newest'

function DesktopTasks() {
  const [scope, setScope] = useState<TaskScope>('mine')
  const { tasks, team, counts: scopeCounts } = useScopedTasks(scope)
  const toggleTask = useStore((s) => s.toggleTask)
  const deleteTask = useStore((s) => s.deleteTask)
  const addTask = useStore((s) => s.addTask)
  const openTaskEditor = useStore((s) => s.openTaskEditor)
  const [layout, setLayout] = useLayout()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const [pill, setPill] = useState<Pill>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('due')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const [snack, setSnack] = useState<{ text: string; undo: () => void; key: number } | null>(null)
  const todayKey = toDateKey(new Date())

  useEffect(() => {
    if (!snack) return
    const t = setTimeout(() => setSnack(null), 5000)
    return () => clearTimeout(t)
  }, [snack])

  // press N anywhere (outside a field) to jump into quick add
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey) return
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        document.getElementById('td-quickadd')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => setSelected(new Set()), [pill, query])

  const isOverdue = (t: Task) => isLate(t, todayKey)

  const inPill = (t: Task, p: Pill) => {
    switch (p) {
      case 'all':
        return !t.done
      case 'today':
        return !t.done && !!t.dueDate && t.dueDate <= todayKey
      case 'upcoming':
        return !t.done && !!t.dueDate && t.dueDate > todayKey
      case 'anytime':
        return !t.done && !t.dueDate
      case 'overdue':
        return isOverdue(t)
      case 'done':
        return t.done
    }
  }

  const counts = useMemo(() => {
    const c: Record<Pill, number> = { all: 0, today: 0, upcoming: 0, anytime: 0, overdue: 0, done: 0 }
    for (const t of tasks) (Object.keys(c) as Pill[]).forEach((p) => inPill(t, p) && c[p]++)
    return c
  }, [tasks]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const prio = (t: Task) => ({ high: 0, medium: 1, low: 2 })[t.priority]
    const dueKey = (t: Task) => t.dueDate ?? '9999-99-99'
    return tasks
      .filter((t) => inPill(t, pill))
      .filter((t) => !q || `${t.title} ${t.notes ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) =>
        sort === 'name'
          ? a.title.localeCompare(b.title)
          : sort === 'priority'
            ? prio(a) - prio(b) || dueKey(a).localeCompare(dueKey(b))
            : sort === 'newest'
              ? b.createdAt - a.createdAt
              : pill === 'done'
                ? dueKey(b).localeCompare(dueKey(a))
                : dueKey(a).localeCompare(dueKey(b))
      )
  }, [tasks, pill, query, sort]) // eslint-disable-line react-hooks/exhaustive-deps

  const setDone = (id: string, done: boolean) => {
    // read live state: undo closures hold an outdated snapshot of the task
    const current = useStore.getState().tasks.find((t) => t.id === id)
    if (current && current.done !== done) toggleTask(id)
  }

  const completeOne = (t: Task) => {
    buzz()
    setLeaving((s) => new Set(s).add(t.id))
    setTimeout(() => {
      setDone(t.id, true)
      notifyTask('completed', { ...t, done: true })
      setSnack({ text: 'Task completed', undo: () => setDone(t.id, false), key: Date.now() })
      setLeaving((s) => {
        const n = new Set(s)
        n.delete(t.id)
        return n
      })
    }, 300)
  }

  const chosen = rows.filter((t) => selected.has(t.id))

  const bulkDone = () => {
    const list = chosen.filter((t) => !t.done)
    list.forEach((t) => setDone(t.id, true))
    setSelected(new Set())
    setSnack({ text: `${list.length} marked done`, undo: () => list.forEach((t) => setDone(t.id, false)), key: Date.now() })
  }

  const bulkDelete = () => {
    const list = [...chosen]
    list.forEach((t) => deleteTask(t.id))
    setSelected(new Set())
    setSnack({ text: `${list.length} deleted`, undo: () => list.forEach((t) => addTask(t)), key: Date.now() })
  }

  const allChecked = rows.length > 0 && rows.every((t) => selected.has(t.id))
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map((t) => t.id)))
  const toggleOne = (t: Task) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(t.id)) n.delete(t.id)
      else n.add(t.id)
      return n
    })

  const PILLS: { id: Pill; label: string }[] = [
    { id: 'all', label: 'All open' },
    { id: 'today', label: 'Today' },
    { id: 'upcoming', label: 'Upcoming' },
    { id: 'anytime', label: 'No date' },
    { id: 'overdue', label: 'Overdue' },
    { id: 'done', label: 'Done' }
  ]

  const status = (t: Task): { label: string; cls: string } => {
    if (t.done) return { label: 'Done', cls: 'st-done' }
    if (t.status === 'in_progress') return { label: 'In progress', cls: 'st-prog' }
    if (isOverdue(t)) return { label: 'Overdue', cls: 'st-over' }
    if (t.dueDate === todayKey) return { label: 'Due today', cls: 'st-today' }
    if (t.dueDate) return { label: 'Planned', cls: 'st-plan' }
    return { label: 'Open', cls: 'st-open' }
  }

  return (
    <div className="page page-wide tdd">
      <header className="tdd-head">
        <div>
          <h1 className="td-title">Tasks</h1>
          <p className="td-sub">Things to get done. Capture, break down, prioritise and finish; timed and repeating alerts live in Reminders.</p>
        </div>
        <button className="btn btn-primary" onClick={() => window.dispatchEvent(new CustomEvent('msos:quick-add'))}>
          <PlusIcon /> New task <kbd className="tdd-kbd">N</kbd>
        </button>
      </header>

      <QuickAdd defaultToday={pill === 'today'} />

      {team && <ScopeTabs scope={scope} setScope={setScope} counts={scopeCounts} />}

      <div className="tdd-panel">
        <div className="tdd-bar">
          <LayoutToggle layout={layout} setLayout={setLayout} />
          {layout === 'list' && (
          <div className="tdd-pills">
            {PILLS.map((p) => (
              <button key={p.id} className={`tdd-pill${pill === p.id ? ' on' : ''}${p.id === 'overdue' && counts.overdue > 0 ? ' warn' : ''}`} onClick={() => setPill(p.id)}>
                {p.label}
                <span>{counts[p.id]}</span>
              </button>
            ))}
          </div>
          )}
          <div className="tdd-tools">
            <div className="tdd-search">
              <Search size={15} />
              <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
              {query && (
                <button onClick={() => setQuery('')} aria-label="Clear search">
                  <X size={14} />
                </button>
              )}
            </div>
            {layout === 'list' && (
            <label className="tdd-sort">
              <ArrowUpDown size={14} />
              <Select
                ariaLabel="Sort by"
                value={sort}
                onChange={(v) => setSort(v as SortKey)}
                options={[
                  { value: 'due', label: 'Due date' },
                  { value: 'priority', label: 'Priority' },
                  { value: 'name', label: 'Name' },
                  { value: 'newest', label: 'Newest' }
                ]}
              />
            </label>
            )}
          </div>
        </div>

        {layout === 'board' && (
          <TaskBoard
            tasks={tasks.filter((t) => !query.trim() || `${t.title} ${t.notes ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))}
            team={team}
            onNew={() => window.dispatchEvent(new CustomEvent('msos:quick-add'))}
          />
        )}

        {layout === 'list' && (
        <div className={`tdd-table tdd-tasks${team ? ' tdd-team' : ''}`} role="table">
          <div className="tdd-row tdd-th" role="row">
            <span className="tdd-cell-check">
              <button className={`tdd-box${allChecked ? ' on' : ''}`} onClick={toggleAll} aria-label="Select all" disabled={rows.length === 0}>
                {allChecked && <Check size={12} strokeWidth={3.4} />}
              </button>
            </span>
            <span>Name</span>
            {team && <span>Who</span>}
            <span className="tdd-col-notes">Notes</span>
            <span>Due</span>
            <span>Priority</span>
            <span>Status</span>
            <span />
          </div>

          {rows.length === 0 ? (
            <div className="td-empty">
              <div className="td-empty-ico">{pill === 'done' ? <CheckCircle2 size={26} /> : <Sun size={26} />}</div>
              <div className="td-empty-title">{query ? 'No matches' : pill === 'done' ? 'Nothing completed yet' : 'All clear here'}</div>
              <div className="td-empty-sub">
                {query ? 'Try a different word.' : 'Type in the box above — press N from anywhere to jump there.'}
              </div>
            </div>
          ) : (
            rows.map((t) => {
              const st = status(t)
              const sel = selected.has(t.id)
              const prog = subtaskProgress(t)
              const isOpen = expanded.has(t.id)
              return (
                <div
                  key={t.id}
                  role="row"
                  className={`tdd-row${sel ? ' sel' : ''}${t.done ? ' done' : ''}${leaving.has(t.id) ? ' leaving' : ''}${isOpen ? ' open' : ''}`}
                  onClick={() => openTaskEditor(t.id)}
                >
                  <span className="tdd-cell-check" onClick={(e) => e.stopPropagation()}>
                    <button className={`tdd-box${sel ? ' on' : ''}`} onClick={() => toggleOne(t)} aria-label="Select">
                      {sel && <Check size={12} strokeWidth={3.4} />}
                    </button>
                  </span>
                  <span className="tdd-name">
                    <button
                      className={`td-check sm${t.done || leaving.has(t.id) ? ' on' : ''}${t.priority === 'high' ? ' imp' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (t.done) setDone(t.id, false)
                        else completeOne(t)
                      }}
                      aria-label={t.done ? 'Mark as not done' : 'Mark as done'}
                    >
                      <Check size={12} strokeWidth={3.2} />
                    </button>
                    <span className="tdd-title-wrap">
                      <span className="tdd-title" title={t.title}>{t.title}</span>
                      {prog.total > 0 && (
                        <button
                          className={`tdd-steps${prog.done === prog.total ? ' all' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setExpanded((s) => {
                              const n = new Set(s)
                              if (n.has(t.id)) n.delete(t.id)
                              else n.add(t.id)
                              return n
                            })
                          }}
                          aria-expanded={isOpen}
                          title={`${prog.done} of ${prog.total} steps done`}
                        >
                          <ListChecks size={12} />
                          {prog.done}/{prog.total}
                          <ChevronDown size={12} className="tdd-steps-chev" />
                        </button>
                      )}
                      {isOpen && prog.total > 0 && <StepRows task={t} />}
                    </span>
                  </span>
                  {team && (
                    <span className="tdd-who">
                      <Who userId={t.assignedTo} invite={t.assignedInvite} always />
                    </span>
                  )}
                  <span className="tdd-col-notes tdd-notes">{t.notes || '—'}</span>
                  <span className={`tdd-due${isOverdue(t) ? ' red' : ''}`}>
                    {t.dueDate ? dueLabel(t, todayKey) : <span className="tdd-muted">No date</span>}
                  </span>
                  <span>
                    <span className={`tdd-prio p-${t.priority}`}>{t.priority[0].toUpperCase() + t.priority.slice(1)}</span>
                  </span>
                  <span>
                    <span className={`tdd-status ${st.cls}`}>{st.label}</span>
                  </span>
                  <span className="tdd-actions">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        openTaskEditor(t.id)
                      }}
                      aria-label="Edit"
                      title="Edit"
                    >
                      <Pencil size={14} />
                    </button>
                  </span>
                </div>
              )
            })
          )}
        </div>
        )}
      </div>

      {chosen.length > 0 && (
        <div className="tdd-bulk">
          <span>
            <b>{chosen.length}</b> selected
          </span>
          {pill !== 'done' && (
            <button onClick={bulkDone}>
              <Check size={15} strokeWidth={3} /> Mark done
            </button>
          )}
          <button className="danger" onClick={bulkDelete}>
            <Trash2 size={15} /> Delete
          </button>
          <button className="ghost" onClick={() => setSelected(new Set())} aria-label="Clear selection">
            <X size={15} />
          </button>
        </div>
      )}

      {snack && chosen.length === 0 && (
        <div className="td-snack" key={snack.key}>
          <Check size={16} strokeWidth={3} />
          <span>{snack.text}</span>
          <button
            onClick={() => {
              snack.undo()
              setSnack(null)
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  )
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
