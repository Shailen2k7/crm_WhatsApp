/**
 * Dashboard cards:
 *  - Get started: three one-tap steps for a new account or company workspace
 *  - Recent pages: what you (and your team) edited lately
 *  - Week in review: Friday to Monday, what got done, what slipped, what's next
 */
import { useEffect, useMemo, useState } from 'react'
import { addDays, endOfWeek, format, startOfWeek } from 'date-fns'
import { ArrowRight, Building2, CalendarCheck2, Check, FileText, Lock, Sparkles, TrendingUp, Users, X } from 'lucide-react'
import InviteModal from './InviteModal'
import CreateCompanyModal from './CreateCompanyModal'
import { useStore } from '../store/useStore'
import { useWorkspace, tasksForWorkspace } from '../lib/workspace'
import { fromDateKey, toDateKey } from '../lib/time'
import { isOverdue } from '../lib/tasks'

const rel = (t: number) => {
  const d = Date.now() - t
  if (d < 60_000) return 'Just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  return format(t, 'EEE d MMM')
}

export function RecentPages() {
  const notes = useStore((s) => s.notes)
  const setView = useStore((s) => s.setView)
  const me = useWorkspace((s) => s.me)
  const activeId = useWorkspace((s) => s.activeId)
  const inCompany = useWorkspace((s) => s.available && !!s.activeId && s.workspaces.find((w) => w.id === s.activeId)?.kind === 'company')
  const memberName = useWorkspace((s) => s.memberName)

  const recent = useMemo(
    () =>
      notes
        .filter((n) => (inCompany ? n.companyId === activeId && (n.shared || !n.createdBy || n.createdBy === me) : !n.companyId))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5),
    [notes, inCompany, activeId, me]
  )

  const open = (id?: string) => {
    setView('notes')
    if (id) window.setTimeout(() => window.dispatchEvent(new CustomEvent('msos:note-open', { detail: { id } })), 60)
  }

  return (
    <div className="dbx-card dbx-pages">
      <div className="dbx-head">
        <span className="dbx-title">Recent pages</span>
        <button className="dbx-link" onClick={() => open()}>
          All notes <ArrowRight size={14} />
        </button>
      </div>
      {recent.length === 0 ? (
        <div className="dbx-empty">
          No pages yet.{' '}
          <button className="dbx-inline-link" onClick={() => open()}>
            Start one
          </button>{' '}
          for meeting prep, a plan or a brief.
        </div>
      ) : (
        <div className="dbx-page-list">
          {recent.map((n) => (
            <button key={n.id} className="dbx-page" onClick={() => open(n.id)}>
              <span className="dbx-page-ico">{n.icon ?? <FileText size={15} />}</span>
              <span className="dbx-page-body">
                <span className="dbx-page-title">{n.title || 'Untitled'}</span>
                <span className="dbx-page-meta">
                  {inCompany && (n.shared ? <Users size={11} /> : <Lock size={11} />)}
                  {n.updatedBy && n.updatedBy !== me ? `${memberName(n.updatedBy)} · ` : ''}
                  {rel(n.updatedAt)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** shown Friday → Monday: the week that was, and the one ahead */
export function WeekInReview() {
  const allTasks = useStore((s) => s.tasks)
  const meetings = useStore((s) => s.meetings)
  const setView = useStore((s) => s.setView)
  const wsOn = useWorkspace((s) => s.available)
  const activeId = useWorkspace((s) => s.activeId)
  const me = useWorkspace((s) => s.me)

  const now = new Date()
  const dow = now.getDay() // 0 = Sunday
  const show = dow === 5 || dow === 6 || dow === 0 || dow === 1
  const todayKey = toDateKey(now)

  const data = useMemo(() => {
    const scoped = wsOn ? tasksForWorkspace(allTasks, activeId) : allTasks
    const tasks = wsOn && activeId ? scoped.filter((t) => !t.companyId || t.assignedTo === me || (!t.assignedTo && !t.assignedInvite && (!t.createdBy || t.createdBy === me))) : scoped
    // Monday: look back at last week
    const anchor = dow === 1 ? addDays(now, -3) : now
    const from = startOfWeek(anchor, { weekStartsOn: 1 })
    const to = endOfWeek(anchor, { weekStartsOn: 1 })
    const fromKey = toDateKey(from)
    const toKey = toDateKey(to)
    const nextFrom = toDateKey(addDays(from, 7))
    const nextTo = toDateKey(addDays(to, 7))
    const done = tasks.filter((t) => t.done && t.completedAt && t.completedAt >= from.getTime() && t.completedAt <= to.getTime() + 86_399_000)
    const slipped = tasks.filter((t) => !t.done && t.dueDate && t.dueDate >= fromKey && t.dueDate <= toKey && isOverdue(t, todayKey))
    const next = tasks.filter((t) => !t.done && t.dueDate && t.dueDate >= nextFrom && t.dueDate <= nextTo).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
    const met = meetings.filter((m) => m.date >= fromKey && m.date <= toKey).length
    const nextMeetings = meetings.filter((m) => m.date >= nextFrom && m.date <= nextTo).length
    const highDone = done.filter((t) => t.priority === 'high').length
    return { from, to, done, slipped, next, met, nextMeetings, highDone }
  }, [allTasks, meetings, wsOn, activeId, me, dow, todayKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!show) return null
  const { from, to, done, slipped, next, met, nextMeetings, highDone } = data
  const line =
    done.length === 0 && met === 0
      ? 'A quiet week on paper. Next week is a fresh start.'
      : done.length >= 5
        ? `Strong week: ${done.length} tasks closed${highDone ? `, ${highDone} of them important` : ''}.`
        : `${done.length} task${done.length === 1 ? '' : 's'} closed and ${met} meeting${met === 1 ? '' : 's'} held.`

  return (
    <div className="dbx-card dbx-week">
      <div className="dbx-head">
        <span className="dbx-title">
          <TrendingUp size={15} /> Week in review
        </span>
        <span className="dbx-week-range">
          {format(from, 'd MMM')} – {format(to, 'd MMM')}
        </span>
      </div>
      <p className="dbx-week-line">
        <Sparkles size={14} /> {line}
      </p>
      <div className="dbx-week-stats">
        <div>
          <b>{done.length}</b>
          <span>Done</span>
        </div>
        <div className={slipped.length ? 'warn' : ''}>
          <b>{slipped.length}</b>
          <span>Slipped</span>
        </div>
        <div>
          <b>{met}</b>
          <span>Meetings</span>
        </div>
        <div>
          <b>{next.length}</b>
          <span>Due next week</span>
        </div>
      </div>
      {slipped.length > 0 && (
        <div className="dbx-week-list">
          <span className="dbx-week-sub">Slipped, carry these over</span>
          {slipped.slice(0, 3).map((t) => (
            <span key={t.id} className="dbx-week-item warn">
              {t.title}
            </span>
          ))}
        </div>
      )}
      {next.length > 0 && (
        <div className="dbx-week-list">
          <span className="dbx-week-sub">Coming up</span>
          {next.slice(0, 3).map((t) => (
            <span key={t.id} className="dbx-week-item">
              <Check size={12} /> {t.title} · {format(fromDateKey(t.dueDate!), 'EEE')}
            </span>
          ))}
          {nextMeetings > 0 && (
            <span className="dbx-week-item">
              <CalendarCheck2 size={12} /> {nextMeetings} meeting{nextMeetings === 1 ? '' : 's'} next week
            </span>
          )}
        </div>
      )}
      <button className="dbx-link dbx-week-go" onClick={() => setView('plan')}>
        Plan {dow === 1 ? 'this' : 'next'} week <ArrowRight size={14} />
      </button>
    </div>
  )
}

/* ================= get started (first run) ================= */

type Step = { id: string; title: string; sub: string; done: boolean; cta: string; run: () => void }

/**
 * Three steps that get a new account (or a new company workspace) going.
 * Each step is one tap; ticks itself off from what you actually did; goes
 * away once everything is done, or when dismissed.
 */
export function GetStarted() {
  const tasks = useStore((s) => s.tasks)
  const meetings = useStore((s) => s.meetings)
  const reminders = useStore((s) => s.reminders)
  const setView = useStore((s) => s.setView)
  const openSchedule = useStore((s) => s.openSchedule)
  const openReminderEditor = useStore((s) => s.openReminderEditor)
  const me = useWorkspace((s) => s.me)
  const activeId = useWorkspace((s) => s.activeId)
  const wsOn = useWorkspace((s) => s.available)
  const company = useWorkspace((s) => s.available && s.workspaces.find((w) => w.id === s.activeId)?.kind === 'company')
  const isAdmin = useWorkspace((s) => s.isAdmin())
  const members = useWorkspace((s) => s.members)
  const invites = useWorkspace((s) => s.invites)
  const wsName = useWorkspace((s) => s.active()?.name)
  const [inviting, setInviting] = useState(false)
  const [creating, setCreating] = useState(false)

  const key = `msos:get-started-off:${me ?? 'local'}:${company ? activeId : 'personal'}`
  const [off, setOff] = useState(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      setOff(localStorage.getItem(key) === '1')
    } catch {
      /* ignore */
    }
  }, [key])

  const quickAdd = () => {
    setView('tasks')
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('msos:quick-add')), 80)
  }

  // members of a company don't run the workspace; the card is for whoever sets things up
  if (company && !isAdmin) return null

  const steps: Step[] = company
    ? [
        {
          id: 'ws',
          title: `${wsName ?? 'Your workspace'} is ready`,
          sub: 'Your company workspace, separate from your personal space',
          done: true,
          cta: '',
          run: () => {}
        },
        {
          id: 'invite',
          title: 'Bring in your team',
          sub: 'Paste a list of emails or upload a CSV. Everyone gets a link to join.',
          done: members.length > 1 || invites.length > 0,
          cta: 'Invite people',
          run: () => setInviting(true)
        },
        {
          id: 'assign',
          title: 'Hand out the first task',
          sub: 'Type @ and a name while writing it. Invited people get it when they join.',
          done: tasks.some((t) => t.companyId === activeId && ((t.assignedTo && t.assignedTo !== me) || !!t.assignedInvite)),
          cta: 'Write a task',
          run: quickAdd
        }
      ]
    : [
        { id: 'task', title: 'Add your first task', sub: 'Type it the way you’d say it: “Send the proposal tomorrow at 4pm”.', done: tasks.length > 0, cta: 'Add a task', run: quickAdd },
        { id: 'meet', title: 'Book a meeting', sub: 'Pick a time and invite people, or share your booking link.', done: meetings.length > 0, cta: 'Schedule', run: () => openSchedule() },
        { id: 'remind', title: 'Set a reminder', sub: 'It rings on your phone at the time you choose.', done: reminders.length > 0, cta: 'Add a reminder', run: () => openReminderEditor('new') }
      ]

  const done = steps.filter((s) => s.done).length
  if (off || done === steps.length) return null
  const next = steps.find((s) => !s.done)
  const dismiss = () => {
    setOff(true)
    try {
      localStorage.setItem(key, '1')
    } catch {
      /* ignore */
    }
  }

  return (
    <section className="gs card" aria-label="Get started">
      <div className="gs-head">
        <Ring done={done} total={steps.length} />
        <div className="gs-head-text">
          <b>{company ? 'Set up your team in a minute' : 'Get going in a minute'}</b>
          <span>
            {done} of {steps.length} done{next ? ` · next: ${next.title.toLowerCase()}` : ''}
          </span>
        </div>
        <button className="gs-x" onClick={dismiss} aria-label="Hide this card" title="Hide">
          <X size={16} />
        </button>
      </div>
      <ol className="gs-steps">
        {steps.map((s, i) => (
          <li key={s.id} className={`gs-step${s.done ? ' done' : ''}${s === next ? ' next' : ''}`}>
            <span className="gs-num">{s.done ? <Check size={14} strokeWidth={3} /> : i + 1}</span>
            <span className="gs-text">
              <b>{s.title}</b>
              <small>{s.sub}</small>
            </span>
            {!s.done && s.cta && (
              <button className={`btn ${s === next ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={s.run}>
                {s.cta}
              </button>
            )}
          </li>
        ))}
      </ol>
      {!company && wsOn && (
        <button className="gs-team" onClick={() => setCreating(true)}>
          <Building2 size={14} /> Working with a team? <b>Create a company workspace</b>
        </button>
      )}
      {inviting && <InviteModal many onClose={() => setInviting(false)} />}
      {creating && <CreateCompanyModal onClose={() => setCreating(false)} />}
    </section>
  )
}

function Ring({ done, total }: { done: number; total: number }) {
  const r = 17
  const c = 2 * Math.PI * r
  return (
    <span className="gs-ring" aria-hidden>
      <svg width="42" height="42" viewBox="0 0 42 42">
        <circle cx="21" cy="21" r={r} className="gs-ring-bg" />
        <circle cx="21" cy="21" r={r} className="gs-ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - done / total)} />
      </svg>
      <i>
        {done}/{total}
      </i>
    </span>
  )
}
