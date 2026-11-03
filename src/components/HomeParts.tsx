/**
 * Building blocks of the two home pages (personal and company):
 * cards, quick actions, today's schedule, task tabs, meetings, calendar
 * with agenda, productivity, recent activity and the daily planner.
 * Everything reads the real store; nothing here is sample data.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { addDays, format, formatDistanceToNowStrict, startOfWeek } from 'date-fns'
import {
  ArrowRight,
  BellRing,
  CalendarDays,
  CalendarPlus,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  Flag,
  Mic,
  Play,
  Plus,
  Sparkles,
  Video
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { firstNameOf, useAuth } from '../lib/auth'
import { notifyTask } from '../lib/notify'
import { dueLabel, isOverdue, subtaskProgress } from '../lib/tasks'
import { fromDateKey, meetingStart, minToLabel, nowMinutes, toDateKey } from '../lib/time'
import { occursOnDay, timesOnDay } from '../lib/recurrence'
import { typeById } from '../lib/meetingTypes'
import { initialsOf } from '../lib/workspace'
import type { Meeting, Task } from '../types'

/* ================= small shared pieces ================= */

export const useTick = (ms = 30_000) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export const greetingFor = (d = new Date()) => {
  const h = d.getHours()
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

export const useFirstName = () => {
  const authUser = useAuth((s) => s.user)
  const name = useStore((s) => s.settings.name)
  return (name || firstNameOf(authUser ?? { id: '', name: '', email: '' }) || 'there').split(/\s+/)[0]
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "1h 30m", "45m" */
export const fmtDur = (min: number) => {
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`
}

const rel = (t: number) => (Date.now() - t < 60_000 ? 'just now' : formatDistanceToNowStrict(t, { addSuffix: true }))

export function Card({
  icon,
  hue,
  title,
  sub,
  action,
  className = '',
  children
}: {
  icon: ReactNode
  hue: string
  title: string
  sub?: ReactNode
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`hm-card ${className}`} style={{ ['--h' as string]: hue }}>
      <header className="hm-card-head">
        <span className="hm-chip">{icon}</span>
        <span className="hm-card-titles">
          <h2>{title}</h2>
          {sub && <small>{sub}</small>}
        </span>
        {action}
      </header>
      {children}
    </section>
  )
}

export function LinkBtn({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="hm-link" onClick={onClick}>
      {children} <ArrowRight size={14} />
    </button>
  )
}

export function Ring({ value, size = 76, stroke = 8, label, sub }: { value: number; size?: number; stroke?: number; label: ReactNode; sub?: ReactNode }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(1, value))
  return (
    <span className="hm-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="hm-ring-bg" />
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="hm-ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - v)} />
      </svg>
      <span className="hm-ring-in">
        <b>{label}</b>
        {sub && <small>{sub}</small>}
      </span>
    </span>
  )
}

export function Avatar({ name, email = '', invited, size = 26 }: { name: string; email?: string; invited?: boolean; size?: number }) {
  // a steady colour per person
  const hues = ['#6c63f7', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#22c55e', '#ef4444']
  let h = 0
  for (const ch of name || email) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return (
    <span className={`hm-av${invited ? ' invited' : ''}`} style={{ width: size, height: size, ['--c' as string]: hues[h % hues.length] }} title={name}>
      {initialsOf(name, email)}
    </span>
  )
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="hm-empty">
      <span>{children}</span>
      {action}
    </div>
  )
}

/* ================= quick actions ================= */

export interface Quick {
  key: string
  label: string
  sub: string
  hue: string
  icon: ReactNode
  run: () => void
  wide?: boolean
}

export function QuickRow({ items }: { items: Quick[] }) {
  return (
    <nav className="hm-quick" aria-label="Quick actions">
      {items.map((q) => (
        <button key={q.key} className={`hm-q${q.wide ? ' wide' : ''}`} style={{ ['--h' as string]: q.hue }} onClick={q.run}>
          <span className="hm-q-ico">{q.icon}</span>
          <span className="hm-q-text">
            <b>{q.label}</b>
            <small>{q.sub}</small>
          </span>
          <Plus size={16} className="hm-q-plus" />
        </button>
      ))}
    </nav>
  )
}

export const quickIcons = {
  task: <CheckSquare size={19} />,
  meeting: <CalendarPlus size={19} />,
  note: <FileText size={19} />,
  reminder: <BellRing size={19} />,
  speak: <Mic size={19} />
}

/* ================= today's schedule ================= */

type Slot = { key: string; start: number; end?: number; title: string; sub: string; kind: 'meeting' | 'reminder' | 'block' | 'task'; color: string; run: () => void; link?: string }

export function TodaySchedule({ tasks }: { tasks: Task[] }) {
  const meetings = useStore((s) => s.meetings)
  const reminders = useStore((s) => s.reminders)
  const blocked = useStore((s) => s.blocked)
  const openDetails = useStore((s) => s.openDetails)
  const openTaskEditor = useStore((s) => s.openTaskEditor)
  const setView = useStore((s) => s.setView)
  const openSchedule = useStore((s) => s.openSchedule)
  const defaultLink = useStore((s) => s.settings.meetLink)
  useTick()
  const todayKey = toDateKey(new Date())
  const nowMin = nowMinutes()

  const { slots, anytime } = useMemo(() => {
    const out: Slot[] = []
    for (const m of meetings.filter((x) => x.date === todayKey)) {
      out.push({
        key: `m${m.id}`,
        start: m.startMin,
        end: m.startMin + m.durationMin,
        title: m.title,
        sub: [m.personName, fmtDur(m.durationMin)].filter(Boolean).join(' · '),
        kind: 'meeting',
        color: typeById(m.type).color,
        run: () => openDetails(m.id),
        link: m.meetLink || defaultLink || undefined
      })
    }
    for (const r of reminders.filter((x) => !x.fired && occursOnDay(x, todayKey))) {
      const times = timesOnDay(r)
      const hourly = r.repeat === 'hourly'
      const next = hourly ? (times.find((t) => t >= nowMin) ?? times[times.length - 1]) : times[0]
      out.push({
        key: `r${r.id}`,
        start: next,
        title: r.title,
        sub: hourly ? `Every ${fmtDur(r.intervalMin ?? 60)} until ${minToLabel(r.untilMin ?? 21 * 60)}` : 'Reminder',
        kind: 'reminder',
        color: 'var(--warn)',
        run: () => setView('reminders')
      })
    }
    const blockedTasks = new Set<string>()
    for (const b of blocked.filter((x) => x.date === todayKey && x.taskId)) {
      const t = tasks.find((x) => x.id === b.taskId)
      if (!t) continue
      blockedTasks.add(t.id)
      out.push({ key: `b${b.id}`, start: b.startMin, end: b.endMin, title: t.title, sub: t.done ? 'Done' : 'Time set aside', kind: 'block', color: 'var(--accent)', run: () => openTaskEditor(t.id) })
    }
    const dueToday = tasks.filter((t) => !t.done && t.dueDate === todayKey && !blockedTasks.has(t.id))
    for (const t of dueToday.filter((x) => x.dueTime !== undefined)) {
      out.push({ key: `t${t.id}`, start: t.dueTime!, title: t.title, sub: 'Task due', kind: 'task', color: t.priority === 'high' ? 'var(--danger)' : 'var(--type-international)', run: () => openTaskEditor(t.id) })
    }
    out.sort((a, b) => a.start - b.start)
    return { slots: out, anytime: dueToday.filter((x) => x.dueTime === undefined) }
  }, [meetings, reminders, blocked, tasks, todayKey, nowMin, defaultLink]) // eslint-disable-line react-hooks/exhaustive-deps

  const nextIdx = slots.findIndex((s) => (s.end ?? s.start + 15) > nowMin)

  return (
    <Card
      icon={<Clock size={17} />}
      hue="#6c63f7"
      title="Today's schedule"
      sub={format(new Date(), 'EEEE d MMMM')}
      className="hm-sched"
      action={<LinkBtn onClick={() => setView('plan')}>Plan my day</LinkBtn>}
    >
      {anytime.length > 0 && (
        <div className="hm-anytime">
          <span>Due today</span>
          {anytime.slice(0, 4).map((t) => (
            <button key={t.id} onClick={() => openTaskEditor(t.id)} className={t.priority === 'high' ? 'imp' : ''}>
              {t.priority === 'high' && <Flag size={11} />} {t.title}
            </button>
          ))}
          {anytime.length > 4 && <em>+{anytime.length - 4} more</em>}
        </div>
      )}
      {slots.length === 0 ? (
        <Empty
          action={
            <span className="hm-empty-acts">
              <button className="btn btn-secondary btn-sm" onClick={() => openSchedule()}>
                <CalendarPlus size={14} /> Book a meeting
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setView('plan')}>
                Plan my day
              </button>
            </span>
          }
        >
          {anytime.length ? 'No fixed times today. Give your tasks a slot so they get done.' : 'Nothing on the clock today. A clear run for deep work.'}
        </Empty>
      ) : (
        <ol className="hm-tl">
          {slots.map((s, i) => {
            const past = (s.end ?? s.start + 15) <= nowMin
            const live = s.start <= nowMin && (s.end ?? s.start) > nowMin
            return (
              <li key={s.key} className={`hm-tl-row${past ? ' past' : ''}${live ? ' live' : ''}`} style={{ ['--c' as string]: s.color }}>
                <span className="hm-tl-time">{minToLabel(s.start)}</span>
                <span className="hm-tl-dot" aria-hidden />
                <button className="hm-tl-body" onClick={s.run}>
                  <b>
                    {s.kind === 'meeting' && <Video size={13} />}
                    {s.kind === 'reminder' && <BellRing size={13} />}
                    {s.title}
                  </b>
                  <small>
                    {s.end ? `${minToLabel(s.start)} – ${minToLabel(s.end)}` : s.sub}
                    {s.end && s.sub ? ` · ${s.sub}` : ''}
                  </small>
                </button>
                {live ? (
                  s.link && s.kind === 'meeting' ? (
                    <a className="hm-pill live" href={s.link} target="_blank" rel="noreferrer">
                      <Video size={12} /> Join
                    </a>
                  ) : (
                    <span className="hm-pill live">Now</span>
                  )
                ) : i === nextIdx ? (
                  <span className="hm-pill">Next</span>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}
    </Card>
  )
}

/* ================= tasks with tabs ================= */

export type TaskTab = { id: string; label: string; tasks: Task[]; empty: string; tone?: 'bad' | 'ok' }

export function TaskTabs({
  title,
  sub,
  tabs,
  assigneeOf
}: {
  title: string
  sub?: string
  tabs: TaskTab[]
  /** company: who a task is with (shown as an avatar) */
  assigneeOf?: (t: Task) => { name: string; email?: string; invited?: boolean } | null
}) {
  const toggleTask = useStore((s) => s.toggleTask)
  const updateTask = useStore((s) => s.updateTask)
  const openTaskEditor = useStore((s) => s.openTaskEditor)
  const setView = useStore((s) => s.setView)
  const [tab, setTab] = useState(tabs[0]?.id)
  const cur = tabs.find((t) => t.id === tab) ?? tabs[0]
  const todayKey = toDateKey(new Date())

  return (
    <Card icon={<CheckSquare size={17} />} hue="#8b5cf6" title={title} sub={sub} className="hm-tasks" action={<LinkBtn onClick={() => setView('tasks')}>All tasks</LinkBtn>}>
      <div className="hm-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === cur.id} className={`${t.id === cur.id ? 'on' : ''}${t.tone ? ` ${t.tone}` : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            <i>{t.tasks.length}</i>
          </button>
        ))}
      </div>
      {cur.tasks.length === 0 ? (
        <Empty>{cur.empty}</Empty>
      ) : (
        <ul className="hm-tlist">
          {cur.tasks.slice(0, 6).map((t) => {
            const late = isOverdue(t, todayKey)
            const prog = subtaskProgress(t)
            const who = assigneeOf?.(t)
            const due = dueLabel(t, todayKey)
            return (
              <li key={t.id} className={`hm-trow${t.done ? ' done' : ''}`}>
                <button
                  className={`hm-check${t.done ? ' on' : ''}${t.priority === 'high' ? ' imp' : ''}`}
                  onClick={() => {
                    toggleTask(t.id)
                    notifyTask(t.done ? 'reopened' : 'completed', { ...t, done: !t.done })
                  }}
                  aria-label={t.done ? 'Mark not done' : 'Mark done'}
                >
                  <Check size={12} strokeWidth={3.4} />
                </button>
                <button className="hm-tmain" onClick={() => openTaskEditor(t.id)}>
                  <b>{t.title}</b>
                  <span className="hm-tmeta">
                    {t.priority === 'high' && !t.done && (
                      <em className="imp">
                        <Flag size={10} /> Important
                      </em>
                    )}
                    {t.done && t.completedAt ? <em>Done {rel(t.completedAt)}</em> : due ? <em className={late ? 'late' : ''}>{late ? `Overdue · ${due}` : due}</em> : <em>No date</em>}
                    {prog.total > 0 && (
                      <em>
                        {prog.done}/{prog.total} steps
                      </em>
                    )}
                    {t.status === 'in_progress' && !t.done && <em className="prog">In progress</em>}
                  </span>
                </button>
                {who && <Avatar name={who.name} email={who.email} invited={who.invited} size={24} />}
                {!t.done && t.status !== 'in_progress' && (
                  <button className="hm-start" onClick={() => updateTask(t.id, { status: 'in_progress' })} aria-label={`Start ${t.title}`}>
                    <Play size={11} /> Start
                  </button>
                )}
              </li>
            )
          })}
          {cur.tasks.length > 6 && (
            <li className="hm-more">
              <button onClick={() => setView('tasks')}>+{cur.tasks.length - 6} more in Tasks</button>
            </li>
          )}
        </ul>
      )}
    </Card>
  )
}

/** the four standard tabs for a list of my tasks */
export const statusTabs = (tasks: Task[]): TaskTab[] => {
  const todayKey = toDateKey(new Date())
  const open = tasks.filter((t) => !t.done)
  const late = open.filter((t) => isOverdue(t, todayKey))
  const lateIds = new Set(late.map((t) => t.id))
  const byDue = (a: Task, b: Task) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || (a.dueTime ?? 1440) - (b.dueTime ?? 1440)
  return [
    { id: 'todo', label: 'To do', tasks: open.filter((t) => t.status !== 'in_progress' && !lateIds.has(t.id)).sort(byDue), empty: 'Nothing waiting. Add a task or enjoy the calm.' },
    { id: 'prog', label: 'In progress', tasks: open.filter((t) => t.status === 'in_progress' && !lateIds.has(t.id)).sort(byDue), empty: 'Press Start on a task to move it here.' },
    { id: 'done', label: 'Completed', tasks: tasks.filter((t) => t.done).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)), empty: 'Finished tasks land here.', tone: 'ok' },
    { id: 'late', label: 'Overdue', tasks: late.sort(byDue), empty: 'Nothing overdue. Nicely done.', tone: late.length ? 'bad' : undefined }
  ]
}

/* ================= upcoming meetings ================= */

export function UpcomingMeetings({ title = 'Upcoming meetings', limit = 4 }: { title?: string; limit?: number }) {
  const meetings = useStore((s) => s.meetings)
  const openDetails = useStore((s) => s.openDetails)
  const openSchedule = useStore((s) => s.openSchedule)
  const setView = useStore((s) => s.setView)
  const defaultLink = useStore((s) => s.settings.meetLink)
  const now = useTick()

  const list = useMemo(
    () =>
      meetings
        .map((m) => ({ m, start: meetingStart(m.date, m.startMin).getTime() }))
        .filter(({ m, start }) => start + m.durationMin * 60_000 > now)
        .sort((a, b) => a.start - b.start)
        .slice(0, limit),
    [meetings, now, limit]
  )

  return (
    <Card
      icon={<Video size={17} />}
      hue="#0ea5e9"
      title={title}
      sub={list.length ? `Next ${formatDistanceToNowStrict(list[0].start, { addSuffix: true })}` : undefined}
      className="hm-meet"
      action={<LinkBtn onClick={() => setView('meetings')}>All meetings</LinkBtn>}
    >
      {list.length === 0 ? (
        <Empty
          action={
            <button className="btn btn-secondary btn-sm" onClick={() => openSchedule()}>
              <CalendarPlus size={14} /> Schedule one
            </button>
          }
        >
          No meetings coming up.
        </Empty>
      ) : (
        <ul className="hm-mlist">
          {list.map(({ m, start }, i) => (
            <MeetingRow key={m.id} m={m} start={start} now={now} first={i === 0} link={m.meetLink || defaultLink} onOpen={() => openDetails(m.id)} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function MeetingRow({ m, start, now, first, link, onOpen }: { m: Meeting; start: number; now: number; first: boolean; link?: string; onOpen: () => void }) {
  const t = typeById(m.type)
  const d = fromDateKey(m.date)
  const live = start <= now
  const soon = start - now < 15 * 60_000
  return (
    <li className={`hm-mrow${first ? ' first' : ''}`} style={{ ['--c' as string]: t.color }}>
      <span className="hm-mdate">
        <small>{format(d, 'EEE')}</small>
        <b>{format(d, 'd')}</b>
      </span>
      <button className="hm-mbody" onClick={onOpen}>
        <b>{m.title}</b>
        <span>
          {minToLabel(m.startMin)} – {minToLabel(m.startMin + m.durationMin)}
          {m.personName ? ` · ${m.personName}` : ''}
        </span>
        <em className="hm-mtype">{t.label}</em>
      </button>
      {link && (live || soon) ? (
        <a className={`hm-join${live ? ' live' : ''}`} href={link} target="_blank" rel="noreferrer">
          <Video size={13} /> {live ? 'Join now' : 'Join'}
        </a>
      ) : (
        <span className="hm-when">{live ? 'Live' : formatDistanceToNowStrict(start)}</span>
      )}
    </li>
  )
}

/* ================= next meeting ================= */

/** The next meeting as one slim card under the hero: when, what, who,
 *  and Join (green once it's close or live). */
export function NextUp() {
  const meetings = useStore((s) => s.meetings)
  const openDetails = useStore((s) => s.openDetails)
  const defaultLink = useStore((s) => s.settings.meetLink)
  const now = useTick(15_000)

  const next = useMemo(
    () =>
      meetings
        .map((m) => ({ m, start: meetingStart(m.date, m.startMin).getTime() }))
        .filter(({ m, start }) => start + m.durationMin * 60_000 > now)
        .sort((a, b) => a.start - b.start)[0],
    [meetings, now]
  )
  if (!next) return null

  const { m, start } = next
  const t = typeById(m.type)
  const end = start + m.durationMin * 60_000
  const live = start <= now
  const mins = Math.max(1, Math.ceil((start - now) / 60_000))
  const soon = !live && mins <= 15
  const link = m.meetLink || defaultLink
  const today = toDateKey(new Date())
  const span = (n: number) => (n < 60 ? `${n} min` : fmtDur(n))
  const when = live
    ? `Live · ${span(Math.max(1, Math.ceil((end - now) / 60_000)))} left`
    : m.date === today && mins < 180
      ? `Starts in ${span(mins)}`
      : m.date === today
        ? 'Later today'
        : m.date === toDateKey(addDays(new Date(), 1))
          ? 'Tomorrow'
          : format(fromDateKey(m.date), 'EEEE d MMM')
  const label = minToLabel(m.startMin)

  return (
    <section className={`hm-up${live ? ' live' : soon ? ' soon' : ''}`} style={{ ['--c' as string]: t.color }} aria-label="Next meeting">
      <button className="hm-up-main" onClick={() => openDetails(m.id)}>
        <span className="hm-up-time">
          <b>{label.replace(/\s?[AP]M$/i, '')}</b>
          <small>{label.match(/[AP]M$/i)?.[0] ?? ''}</small>
        </span>
        <span className="hm-up-body">
          <small>
            <i />
            {when}
            {m.personName ? <span> · with {m.personName}</span> : null}
          </small>
          <b>{m.title}</b>
        </span>
      </button>
      {link ? (
        <a className="hm-up-join" href={link} target="_blank" rel="noreferrer">
          <Video size={15} /> {live ? 'Join now' : 'Join'}
        </a>
      ) : (
        <button className="hm-up-join ghost" onClick={() => openDetails(m.id)}>
          Open <ArrowRight size={15} />
        </button>
      )}
      {live && <span className="hm-up-prog" style={{ width: `${Math.min(100, ((now - start) / (end - start)) * 100)}%` }} />}
    </section>
  )
}

/* ================= calendar + agenda ================= */

type AgendaItem = { id: string; kind: 'm' | 't' | 'r'; title: string; time?: number; end?: number; sub: string; color: string; run: () => void }

export function CalendarAgenda({ tasks }: { tasks: Task[] }) {
  const meetings = useStore((s) => s.meetings)
  const reminders = useStore((s) => s.reminders)
  const setCalendarDate = useStore((s) => s.setCalendarDate)
  const setCalendarMode = useStore((s) => s.setCalendarMode)
  const setView = useStore((s) => s.setView)
  const openDetails = useStore((s) => s.openDetails)
  const openTaskEditor = useStore((s) => s.openTaskEditor)
  const todayKey = toDateKey(new Date())
  const [week, setWeek] = useState(0)
  const [picked, setPicked] = useState(todayKey)

  const itemsOn = (key: string): AgendaItem[] =>
    [
      ...meetings
        .filter((m) => m.date === key)
        .map((m) => ({
          id: m.id,
          kind: 'm' as const,
          title: m.title,
          time: m.startMin,
          end: m.startMin + m.durationMin,
          sub: [m.personName, typeById(m.type).label].filter(Boolean).join(' · '),
          color: typeById(m.type).color,
          run: () => openDetails(m.id)
        })),
      ...tasks
        .filter((t) => !t.done && t.dueDate === key)
        .map((t) => ({
          id: t.id,
          kind: 't' as const,
          title: t.title,
          time: t.dueTime,
          sub: t.priority === 'high' ? 'Task due · Important' : 'Task due',
          color: t.priority === 'high' ? 'var(--danger)' : '#8b5cf6',
          run: () => openTaskEditor(t.id)
        })),
      ...reminders
        .filter((r) => !r.fired && occursOnDay(r, key))
        .map((r) => ({
          id: r.id,
          kind: 'r' as const,
          title: r.title,
          time: r.atMin,
          sub: r.repeat === 'hourly' ? `Reminder · every ${fmtDur(r.intervalMin ?? 60)}` : r.repeat && r.repeat !== 'none' ? 'Repeating reminder' : 'Reminder',
          color: 'var(--warn)',
          run: () => setView('reminders')
        }))
    ].sort((a, b) => (a.time ?? -1) - (b.time ?? -1))

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(new Date(), week * 7 + i)
    const key = toDateKey(d)
    const items = itemsOn(key)
    return { d, key, items, count: items.length, kinds: new Set(items.map((x) => x.kind)) }
  })
  const totals = { m: 0, t: 0, r: 0 }
  days.forEach((d) => d.items.forEach((x) => totals[x.kind]++))
  const pickedKey = days.some((d) => d.key === picked) ? picked : days[0].key
  const list = itemsOn(pickedKey)
  const pickedDate = fromDateKey(pickedKey)
  const dayTitle = pickedKey === todayKey ? 'Today' : pickedKey === toDateKey(addDays(new Date(), 1)) ? 'Tomorrow' : format(pickedDate, 'EEEE')
  const busyMin = list.filter((x) => x.kind === 'm').reduce((a, x) => a + (x.end! - x.time!), 0)

  const openDay = (key: string) => {
    setCalendarDate(key)
    setCalendarMode('day')
    setView('calendar')
  }
  const shift = (n: number) => {
    const w = week + n
    setWeek(w)
    setPicked(toDateKey(addDays(new Date(), w * 7)))
  }

  return (
    <Card
      icon={<CalendarDays size={17} />}
      hue="#14b8a6"
      title="Calendar & agenda"
      sub={week === 0 ? 'The next 7 days' : `${format(days[0].d, 'd MMM')} – ${format(days[6].d, 'd MMM')}`}
      className="hm-cal"
      action={<LinkBtn onClick={() => setView('calendar')}>Calendar</LinkBtn>}
    >
      <div className="hm-week">
        <button className="hm-week-nav" onClick={() => shift(-1)} disabled={week === 0} aria-label="Earlier days">
          <ChevronLeft size={16} />
        </button>
        <div className="hm-days" role="tablist" aria-label="Pick a day">
          {days.map((d) => (
            <button key={d.key} role="tab" aria-selected={d.key === pickedKey} className={`hm-day${d.key === pickedKey ? ' on' : ''}${d.key === todayKey ? ' today' : ''}`} onClick={() => setPicked(d.key)}>
              <small>{d.key === todayKey ? 'Today' : format(d.d, 'EEE')}</small>
              <b>{format(d.d, 'd')}</b>
              <span className="hm-day-dots" aria-label={`${d.count} items`}>
                {d.kinds.has('m') && <i className="m" />}
                {d.kinds.has('t') && <i className="t" />}
                {d.kinds.has('r') && <i className="r" />}
              </span>
            </button>
          ))}
        </div>
        <button className="hm-week-nav" onClick={() => shift(1)} aria-label="Later days">
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="hm-day-head">
        <b>
          {dayTitle}
          <span>{format(pickedDate, 'd MMMM')}</span>
        </b>
        <small>{list.length ? `${plural(list.length, 'item')}${busyMin ? ` · ${fmtDur(busyMin)} in meetings` : ''}` : ''}</small>
      </div>

      {list.length === 0 ? (
        <Empty
          action={
            <button className="btn btn-secondary btn-sm" onClick={() => openDay(pickedKey)}>
              Open the day
            </button>
          }
        >
          Nothing planned for {dayTitle === 'Today' || dayTitle === 'Tomorrow' ? dayTitle.toLowerCase() : dayTitle}. A free day.
        </Empty>
      ) : (
        <ul className="hm-agenda">
          {list.slice(0, 5).map((it) => (
            <li key={it.kind + it.id}>
              <button className={`hm-ag k-${it.kind}`} style={{ ['--c' as string]: it.color }} onClick={it.run}>
                <span className="hm-ag-time">
                  {it.time !== undefined ? (
                    <>
                      <b>{minToLabel(it.time).replace(/\s?[AP]M$/i, '')}</b>
                      <small>{minToLabel(it.time).match(/[AP]M$/i)?.[0] ?? ''}</small>
                    </>
                  ) : (
                    <b className="allday">All day</b>
                  )}
                </span>
                <span className="hm-ag-ico">
                  {it.kind === 'm' ? <Video size={14} /> : it.kind === 't' ? <CheckSquare size={14} /> : <BellRing size={14} />}
                </span>
                <span className="hm-ag-body">
                  <b>{it.title}</b>
                  <small>
                    {it.end ? `${minToLabel(it.time!)} – ${minToLabel(it.end)} · ` : ''}
                    {it.sub}
                  </small>
                </span>
              </button>
            </li>
          ))}
          {list.length > 5 && (
            <li>
              <button className="hm-link" onClick={() => openDay(pickedKey)}>
                +{list.length - 5} more on this day <ArrowRight size={14} />
              </button>
            </li>
          )}
        </ul>
      )}

      <div className="hm-wk-sum" aria-label="These 7 days">
        <span className="m">
          <i /> <b>{totals.m}</b> meeting{totals.m === 1 ? '' : 's'}
        </span>
        <span className="t">
          <i /> <b>{totals.t}</b> deadline{totals.t === 1 ? '' : 's'}
        </span>
        <span className="r">
          <i /> <b>{totals.r}</b> reminder{totals.r === 1 ? '' : 's'}
        </span>
      </div>
    </Card>
  )
}

/* ================= productivity ================= */

/** completions per day this week (Mon → Sun), plus last week's total */
export const weekStats = (tasks: Task[]) => {
  const mon = startOfWeek(new Date(), { weekStartsOn: 1 })
  const days = Array.from({ length: 7 }, (_, i) => addDays(mon, i))
  const keys = days.map(toDateKey)
  const doneKey = (t: Task) => (t.done && t.completedAt ? toDateKey(new Date(t.completedAt)) : null)
  const perDay = keys.map((k) => tasks.filter((t) => doneKey(t) === k).length)
  const lastMon = addDays(mon, -7).getTime()
  const lastWeek = tasks.filter((t) => t.done && t.completedAt && t.completedAt >= lastMon && t.completedAt < mon.getTime()).length
  const thisWeek = perDay.reduce((a, b) => a + b, 0)
  // due this week: how many of them are done
  const fromKey = keys[0]
  const toKey = keys[6]
  const due = tasks.filter((t) => t.dueDate && t.dueDate >= fromKey && t.dueDate <= toKey)
  const rate = due.length ? due.filter((t) => t.done).length / due.length : tasks.length ? tasks.filter((t) => t.done).length / tasks.length : 0
  // streak: days in a row (ending today or yesterday) with at least one task done
  const doneDays = new Set(tasks.map(doneKey).filter(Boolean) as string[])
  let streak = 0
  let d = doneDays.has(toDateKey(new Date())) ? new Date() : addDays(new Date(), -1)
  while (doneDays.has(toDateKey(d))) {
    streak++
    d = addDays(d, -1)
  }
  return { days, perDay, thisWeek, lastWeek, rate, dueCount: due.length, streak }
}

export function WeekBars({ days, perDay }: { days: Date[]; perDay: number[] }) {
  const max = Math.max(1, ...perDay)
  const todayKey = toDateKey(new Date())
  return (
    <div className="hm-bars" role="img" aria-label={`Tasks done each day this week: ${perDay.join(', ')}`}>
      {days.map((d, i) => {
        const key = toDateKey(d)
        return (
          <span key={key} className={`${key === todayKey ? 'today' : ''}${key > todayKey ? ' future' : ''}`}>
            <i style={{ height: `${Math.max(perDay[i] ? 14 : 4, (perDay[i] / max) * 100)}%` }}>{perDay[i] > 0 && <b>{perDay[i]}</b>}</i>
            <small>{format(d, 'EEEEE')}</small>
          </span>
        )
      })}
    </div>
  )
}

export function Productivity({ tasks, title = 'Productivity', sub }: { tasks: Task[]; title?: string; sub?: string }) {
  const s = useMemo(() => weekStats(tasks), [tasks])
  const diff = s.thisWeek - s.lastWeek
  return (
    <Card icon={<Sparkles size={17} />} hue="#22c55e" title={title} sub={sub ?? 'This week'} className="hm-prod">
      <div className="hm-prod-top">
        <Ring value={s.rate} label={`${Math.round(s.rate * 100)}%`} sub="done" />
        <div className="hm-prod-stats">
          <div>
            <b>{s.thisWeek}</b>
            <span>tasks done</span>
          </div>
          <div>
            <b className={diff > 0 ? 'up' : diff < 0 ? 'down' : ''}>{diff > 0 ? `+${diff}` : diff}</b>
            <span>vs last week</span>
          </div>
          <div>
            <b>{s.streak}</b>
            <span>day streak</span>
          </div>
        </div>
      </div>
      <WeekBars days={s.days} perDay={s.perDay} />
      <p className="hm-note">{s.dueCount ? `${Math.round(s.rate * 100)}% of the ${plural(s.dueCount, 'task')} due this week are done.` : 'Completion rate across all your tasks. Add due dates to track the week.'}</p>
    </Card>
  )
}

/* ================= recent activity ================= */

export interface ActivityItem {
  id: string
  at: number
  text: ReactNode
  kind: 'done' | 'new' | 'note' | 'meet' | 'assign' | 'comment'
  who?: { name: string; email?: string }
  run?: () => void
}

export function ActivityFeed({ items, title = 'Recent activity', sub }: { items: ActivityItem[]; title?: string; sub?: string }) {
  return (
    <Card icon={<Sparkles size={17} />} hue="#f59e0b" title={title} sub={sub} className="hm-act">
      {items.length === 0 ? (
        <Empty>Things you finish, write and book show up here.</Empty>
      ) : (
        <ul className="hm-alist">
          {items.slice(0, 7).map((a) => (
            <li key={a.id} className={`hm-arow k-${a.kind}`}>
              {a.who ? <Avatar name={a.who.name} email={a.who.email} size={28} /> : <span className="hm-adot" aria-hidden />}
              <button className="hm-abody" onClick={a.run} disabled={!a.run}>
                <span>{a.text}</span>
                <small>{rel(a.at)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* ================= daily planner / insights ================= */

export interface Suggestion {
  id: string
  icon: ReactNode
  tone: 'bad' | 'warn' | 'good' | 'info'
  text: ReactNode
  cta?: string
  run?: () => void
}

export function Planner({ title, lead, items, foot }: { title: string; lead: ReactNode; items: Suggestion[]; foot: ReactNode }) {
  return (
    <section className="hm-card hm-ai">
      <div className="hm-ai-glow" aria-hidden />
      <header className="hm-card-head">
        <span className="hm-chip ai">
          <Sparkles size={17} />
        </span>
        <span className="hm-card-titles">
          <h2>{title}</h2>
          <small>From your tasks, meetings and free time</small>
        </span>
      </header>
      <p className="hm-ai-lead">{lead}</p>
      {items.length > 0 && (
        <ul className="hm-sugg">
          {items.slice(0, 4).map((s) => (
            <li key={s.id} className={`t-${s.tone}`}>
              <span className="hm-sugg-ico">{s.icon}</span>
              <span className="hm-sugg-text">{s.text}</span>
              {s.cta && s.run && (
                <button className="hm-sugg-go" onClick={s.run}>
                  {s.cta}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="hm-ai-foot">{foot}</div>
    </section>
  )
}

export const openMig = () => window.dispatchEvent(new Event('msos:open-mig'))

/** free minutes left in the working day (from now), around meetings and planned blocks */
export const freeToday = (meetings: Meeting[], blocks: { date: string; startMin: number; endMin: number }[], workStart: number, workEnd: number) => {
  const key = toDateKey(new Date())
  const busy = [
    ...meetings.filter((m) => m.date === key).map((m) => [m.startMin, m.startMin + m.durationMin] as const),
    ...blocks.filter((b) => b.date === key).map((b) => [b.startMin, b.endMin] as const)
  ].sort((a, b) => a[0] - b[0])
  let cursor = Math.max(workStart, nowMinutes())
  let free = 0
  let longest: [number, number] | null = null
  const gap = (a: number, b: number) => {
    if (b - a >= 15) {
      free += b - a
      if (!longest || b - a > longest[1] - longest[0]) longest = [a, b]
    }
  }
  for (const [s, e] of busy) {
    if (e <= cursor) continue
    if (s > cursor) gap(cursor, Math.min(s, workEnd))
    cursor = Math.max(cursor, e)
    if (cursor >= workEnd) break
  }
  if (cursor < workEnd) gap(cursor, workEnd)
  return { free, longest: longest as [number, number] | null }
}
