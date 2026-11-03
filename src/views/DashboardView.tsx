/**
 * Home. A personal space gets the personal home (your day, your tasks,
 * your meetings); a company workspace gets the company home
 * (HomeCompany: the team, its work and what needs attention).
 */
import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import { AlarmClock, CalendarPlus, Check, CircleCheck, Flag, Link2, NotebookPen, Sunrise } from 'lucide-react'
import { useStore } from '../store/useStore'
import { bookingUrl } from '../lib/booking'
import { isOverdue } from '../lib/tasks'
import { meetingStart, minToLabel, toDateKey } from '../lib/time'
import { occursOnDay } from '../lib/recurrence'
import { tasksForWorkspace, useWorkspace } from '../lib/workspace'
import { useQuickActions } from '../components/QuickActions'
import NotifyPrompt from '../components/NotifyPrompt'
import { GetStarted } from '../components/DashboardExtras'
import { HeroButtons } from '../components/NotificationsPanel'
import HomeCompany from '../components/HomeCompany'
import {
  ActivityFeed,
  CalendarAgenda,
  fmtDur,
  freeToday,
  NextUp,
  greetingFor,
  openMig,
  Planner,
  plural,
  Productivity,
  QuickRow,
  quickIcons,
  Ring,
  statusTabs,
  TaskTabs,
  TodaySchedule,
  UpcomingMeetings,
  useTick,
  type ActivityItem,
  useFirstName,
  type Suggestion
} from '../components/HomeParts'

export default function DashboardView() {
  const company = useWorkspace((s) => s.available && s.workspaces.find((w) => w.id === s.activeId)?.kind === 'company')
  return company ? <HomeCompany /> : <PersonalHome />
}

function PersonalHome() {
  const allTasks = useStore((s) => s.tasks)
  const meetings = useStore((s) => s.meetings)
  const reminders = useStore((s) => s.reminders)
  const notes = useStore((s) => s.notes)
  const blocked = useStore((s) => s.blocked)
  const settings = useStore((s) => s.settings)
  const setView = useStore((s) => s.setView)
  const openSchedule = useStore((s) => s.openSchedule)
  const openDetails = useStore((s) => s.openDetails)
  const openTaskEditor = useStore((s) => s.openTaskEditor)
  const updateTask = useStore((s) => s.updateTask)
  const wsOn = useWorkspace((s) => s.available)
  const activeId = useWorkspace((s) => s.activeId)
  const hasCompany = useWorkspace((s) => s.available && s.workspaces.some((w) => w.kind === 'company'))
  const qa = useQuickActions()
  const first = useFirstName()
  const now = useTick()
  const [moved, setMoved] = useState(0)

  const todayKey = toDateKey(new Date())
  const tasks = useMemo(() => (wsOn ? tasksForWorkspace(allTasks, activeId) : allTasks), [allTasks, wsOn, activeId])

  const day = useMemo(() => {
    const dueToday = tasks.filter((t) => t.dueDate === todayKey)
    const openToday = dueToday.filter((t) => !t.done)
    const doneToday = tasks.filter((t) => t.done && t.completedAt && toDateKey(new Date(t.completedAt)) === todayKey)
    const overdue = tasks.filter((t) => !t.done && isOverdue(t, todayKey) && t.dueDate !== todayKey)
    const meetsToday = meetings.filter((m) => m.date === todayKey)
    const remToday = reminders.filter((r) => !r.fired && occursOnDay(r, todayKey))
    const next = meetings
      .map((m) => ({ m, start: meetingStart(m.date, m.startMin).getTime() }))
      .filter(({ m, start }) => start + m.durationMin * 60_000 > now)
      .sort((a, b) => a.start - b.start)[0]
    return { dueToday, openToday, doneToday, overdue, meetsToday, remToday, next }
  }, [tasks, meetings, reminders, todayKey, now])

  const summary = (() => {
    const parts = [
      day.meetsToday.length && plural(day.meetsToday.length, 'meeting'),
      day.openToday.length && `${plural(day.openToday.length, 'task')} due`,
      day.remToday.length && plural(day.remToday.length, 'reminder')
    ].filter(Boolean) as string[]
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
    return list ? `You have ${list} today.` : 'A clear day. A good time to get ahead on something important.'
  })()

  const ringTotal = day.doneToday.length + day.openToday.length

  // the planner: a few useful nudges, each with a working button
  const free = freeToday(meetings, blocked, settings.workStartMin, settings.workEndMin)
  const suggestions: Suggestion[] = []
  if (day.overdue.length) {
    suggestions.push({
      id: 'late',
      tone: 'bad',
      icon: <AlarmClock size={15} />,
      text: (
        <>
          <b>{plural(day.overdue.length, 'task')} overdue.</b> Bring {day.overdue.length === 1 ? 'it' : 'them'} into today so nothing slips further.
        </>
      ),
      cta: 'Move to today',
      run: () => {
        day.overdue.forEach((t) => updateTask(t.id, { dueDate: todayKey, dueTime: undefined }))
        setMoved(day.overdue.length)
      }
    })
  }
  const unplanned = day.openToday.filter((t) => !blocked.some((b) => b.taskId === t.id && b.date === todayKey))
  if (unplanned.length && free.free >= 30) {
    suggestions.push({
      id: 'plan',
      tone: 'warn',
      icon: <Sunrise size={15} />,
      text: (
        <>
          <b>{fmtDur(free.free)} free</b> and {plural(unplanned.length, 'task')} due today without a time.
        </>
      ),
      cta: 'Give them a time',
      run: () => setView('plan')
    })
  }
  const prep = meetings
    .map((m) => ({ m, start: meetingStart(m.date, m.startMin).getTime() }))
    .filter(({ start }) => start > now && start - now < 24 * 3600_000)
    .sort((a, b) => a.start - b.start)
    .find(({ m }) => !notes.some((n) => n.meetingId === m.id))
  if (prep) {
    suggestions.push({
      id: 'prep',
      tone: 'info',
      icon: <NotebookPen size={15} />,
      text: (
        <>
          Prep for <b>{prep.m.title}</b> {prep.m.date === todayKey ? 'today' : 'tomorrow'} at {minToLabel(prep.m.startMin)}.
        </>
      ),
      cta: 'Start notes',
      run: () => {
        setView('notes')
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('msos:note-for-meeting', { detail: { id: prep.m.id } })), 80)
      }
    })
  }
  const undated = tasks.find((t) => !t.done && t.priority === 'high' && !t.dueDate)
  if (undated) {
    suggestions.push({
      id: 'undated',
      tone: 'warn',
      icon: <Flag size={15} />,
      text: (
        <>
          <b>{undated.title}</b> is important but has no date.
        </>
      ),
      cta: 'Set a date',
      run: () => openTaskEditor(undated.id)
    })
  }
  if (!suggestions.length) {
    suggestions.push({ id: 'ok', tone: 'good', icon: <CircleCheck size={15} />, text: <>You're on top of everything. Nothing needs your attention right now.</> })
  }
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  const lead =
    nowMin >= settings.workEndMin
      ? `Your working day is done${day.doneToday.length ? `, with ${plural(day.doneToday.length, 'task')} finished` : ''}. Rest up.`
      : free.longest
        ? `Your longest free stretch is ${minToLabel(free.longest[0])} – ${minToLabel(free.longest[1])} (${fmtDur(free.longest[1] - free.longest[0])}). Good for focused work.`
        : 'Your working day is fully booked. Keep the gaps for quick wins.'

  const activity: ActivityItem[] = useMemo(() => {
    const out: ActivityItem[] = []
    for (const t of tasks) {
      if (t.done && t.completedAt) out.push({ id: `d${t.id}`, at: t.completedAt, kind: 'done', text: <>Completed <b>{t.title}</b></>, run: () => openTaskEditor(t.id) })
      out.push({ id: `n${t.id}`, at: t.createdAt, kind: 'new', text: <>Added task <b>{t.title}</b></>, run: () => openTaskEditor(t.id) })
    }
    for (const n of notes.filter((x) => !x.companyId)) {
      out.push({
        id: `p${n.id}`,
        at: n.updatedAt,
        kind: 'note',
        text: <>Edited page <b>{n.title || 'Untitled'}</b></>,
        run: () => {
          setView('notes')
          window.setTimeout(() => window.dispatchEvent(new CustomEvent('msos:note-open', { detail: { id: n.id } })), 60)
        }
      })
    }
    for (const m of meetings) out.push({ id: `m${m.id}`, at: m.createdAt, kind: 'meet', text: <>Booked <b>{m.title}</b></>, run: () => openDetails(m.id) })
    return out.filter((a) => a.at <= Date.now()).sort((a, b) => b.at - a.at).slice(0, 7)
  }, [tasks, notes, meetings]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page page-wide hm">
      <header className="hm-hero">
        <div className="hm-hero-blob a" aria-hidden />
        <div className="hm-hero-blob b" aria-hidden />
        <div className="hm-hero-main">
          <span className="hm-eyebrow">{format(new Date(), 'EEEE, d MMMM')}</span>
          <h1>
            {greetingFor()}, {first}
          </h1>
          <p>{summary}</p>
          <div className="hm-hero-acts">
            <button className="hm-hbtn solid" onClick={() => setView('plan')}>
              <Sunrise size={16} /> Plan my day
            </button>
            <button className="hm-hbtn" onClick={() => openSchedule()}>
              <CalendarPlus size={16} /> Schedule meeting
            </button>
            <CopyBookingLink />
          </div>
        </div>
        <div className="hm-hero-side">
          <Ring value={ringTotal ? day.doneToday.length / ringTotal : 0} size={104} stroke={10} label={`${day.doneToday.length}/${ringTotal}`} sub="done today" />
          <div className="hm-hero-stats">
            <button onClick={() => setView('meetings')}>
              <b>{day.meetsToday.length}</b>
              <span>Meetings</span>
            </button>
            <button onClick={() => setView('tasks')}>
              <b>{day.openToday.length}</b>
              <span>Due today</span>
            </button>
            <button onClick={() => setView('tasks')} className={day.overdue.length ? 'bad' : ''}>
              <b>{day.overdue.length}</b>
              <span>Overdue</span>
            </button>
          </div>
        </div>
        {hasCompany && <HeroButtons />}
      </header>

      <NextUp />

      <QuickRow
        items={[
          { key: 'task', label: 'Task', sub: 'Something to do', hue: '#6c63f7', icon: quickIcons.task, run: qa.task },
          { key: 'meeting', label: 'Meeting', sub: 'Pick a time', hue: '#0ea5e9', icon: quickIcons.meeting, run: qa.meeting },
          { key: 'note', label: 'Note', sub: 'A page for anything', hue: '#14b8a6', icon: quickIcons.note, run: qa.note },
          { key: 'reminder', label: 'Reminder', sub: 'Rings on time', hue: '#f59e0b', icon: quickIcons.reminder, run: qa.reminder },
          { key: 'speak', label: 'Say it', sub: 'Tell Mig by voice', hue: '#ec4899', icon: quickIcons.speak, run: qa.speak, wide: true }
        ]}
      />

      <NotifyPrompt />
      <GetStarted />

      <div className="hm-grid">
        <div className="hm-c7">
          <TodaySchedule tasks={tasks} />
        </div>
        <div className="hm-c5">
          <Planner
            title="Daily planner"
            lead={lead}
            items={moved ? [{ id: 'moved', tone: 'good', icon: <Check size={15} />, text: <>Moved {plural(moved, 'task')} to today.</> }, ...suggestions.filter((s) => s.id !== 'late')] : suggestions}
            foot={
              <>
                <button className="btn btn-primary btn-sm" onClick={() => setView('plan')}>
                  <Sunrise size={14} /> Plan my day
                </button>
                <button className="btn btn-secondary btn-sm" onClick={openMig}>
                  Ask Mig
                </button>
              </>
            }
          />
        </div>
        <div className="hm-c7">
          <TaskTabs title="My tasks" tabs={statusTabs(tasks)} />
        </div>
        <div className="hm-c5">
          <UpcomingMeetings />
        </div>
        <div className="hm-c6">
          <CalendarAgenda tasks={tasks} />
        </div>
        <div className="hm-c3">
          <Productivity tasks={tasks} />
        </div>
        <div className="hm-c3">
          <ActivityFeed items={activity} />
        </div>
      </div>
    </div>
  )
}

export function CopyBookingLink() {
  const slug = useStore((s) => s.settings.bookingSlug)
  const enabled = useStore((s) => s.settings.bookingEnabled ?? true)
  const [copied, setCopied] = useState(false)
  if (!slug || !enabled) return null
  return (
    <button
      className="hm-hbtn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(bookingUrl(slug))
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          prompt('Copy your booking link:', bookingUrl(slug))
        }
      }}
    >
      {copied ? <Check size={16} /> : <Link2 size={16} />}
      {copied ? 'Copied!' : 'Booking link'}
    </button>
  )
}
