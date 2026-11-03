/**
 * Home for a company workspace: the workspace at a glance, its
 * performance, my work, the team's load, teams' progress, deadlines,
 * meetings, what happened lately and what needs attention.
 *
 * Members only see their own tasks (and ones they handed out), so the
 * company-wide numbers and workload are for admins and managers; members
 * get the same cards over the work they can see.
 */
import { useMemo, useState } from 'react'
import { addDays, format, startOfWeek } from 'date-fns'
import { AlarmClock, CalendarPlus, CircleCheck, Flag, Hourglass, Inbox, Layers, Scale, Sunrise, TrendingUp, UserPlus, Users, UserX } from 'lucide-react'
import { useStore } from '../store/useStore'
import { dueLabel, isOverdue } from '../lib/tasks'
import { toDateKey } from '../lib/time'
import { ROLE_LABEL, taskScope, useWorkspace } from '../lib/workspace'
import { usePeople, type Person } from '../lib/people'
import { useQuickActions } from './QuickActions'
import NotifyPrompt from './NotifyPrompt'
import { GetStarted } from './DashboardExtras'
import { HeroButtons } from './NotificationsPanel'
import InviteModal from './InviteModal'
import {
  ActivityFeed,
  Avatar,
  CalendarAgenda,
  Card,
  Empty,
  greetingFor,
  LinkBtn,
  openMig,
  Planner,
  plural,
  QuickRow,
  quickIcons,
  Ring,
  statusTabs,
  TaskTabs,
  UpcomingMeetings,
  useFirstName,
  useTick,
  WeekBars,
  weekStats,
  type ActivityItem,
  type Suggestion,
  type TaskTab
} from './HomeParts'
import type { Task } from '../types'

const TEAM_HUES = ['#6c63f7', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#22c55e']

export default function HomeCompany() {
  const allTasks = useStore((s) => s.tasks)
  const notes = useStore((s) => s.notes)
  const setView = useStore((s) => s.setView)
  const openSchedule = useStore((s) => s.openSchedule)
  const openTaskEditor = useStore((s) => s.openTaskEditor)
  const ws = useWorkspace((s) => s.active())
  const activeId = useWorkspace((s) => s.activeId)
  const members = useWorkspace((s) => s.members)
  const teams = useWorkspace((s) => s.teams)
  const notifications = useWorkspace((s) => s.notifications)
  const memberName = useWorkspace((s) => s.memberName)
  const pendingName = useWorkspace((s) => s.pendingName)
  const isAdmin = useWorkspace((s) => s.isAdmin())
  const { people, showLoad, me } = usePeople()
  const qa = useQuickActions()
  const first = useFirstName()
  useTick(60_000)
  const [inviting, setInviting] = useState(false)

  const todayKey = toDateKey(new Date())
  const weekEnd = toDateKey(addDays(startOfWeek(new Date(), { weekStartsOn: 1 }), 6))
  const in7 = toDateKey(addDays(new Date(), 7))
  const monday = startOfWeek(new Date(), { weekStartsOn: 1 }).getTime()

  const work = useMemo(() => {
    const all = allTasks.filter((t) => t.companyId === activeId)
    const mine = all.filter((t) => taskScope(t, me) === 'mine')
    const byMe = all.filter((t) => taskScope(t, me) === 'by_me')
    const open = all.filter((t) => !t.done)
    const overdue = open.filter((t) => isOverdue(t, todayKey))
    const dueWeek = open.filter((t) => t.dueDate && t.dueDate >= todayKey && t.dueDate <= weekEnd)
    const unowned = open.filter((t) => !t.assignedTo && !t.assignedInvite)
    return { all, mine, byMe, open, overdue, dueWeek, unowned }
  }, [allTasks, activeId, me, todayKey, weekEnd])

  const stats = useMemo(() => weekStats(work.all), [work.all])

  // who a task is with, for avatars
  const assignee = (t: Task) => {
    if (t.assignedInvite) return { name: pendingName(t.assignedInvite), invited: true }
    if (!t.assignedTo) return null
    const m = members.find((x) => x.userId === t.assignedTo)
    return { name: m?.name || memberName(t.assignedTo), email: m?.email }
  }

  const doneWeekBy = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of work.all) if (t.done && (t.completedAt ?? 0) >= monday && t.assignedTo) map.set(t.assignedTo, (map.get(t.assignedTo) ?? 0) + 1)
    return map
  }, [work.all, monday])

  /* ---------- teams & progress ---------- */
  const teamRows = useMemo(() => {
    const rows = teams.map((tm, i) => {
      const ts = work.all.filter((t) => t.teamId === tm.id)
      const done = ts.filter((t) => t.done).length
      return { id: tm.id, name: tm.name, hue: tm.color || TEAM_HUES[i % TEAM_HUES.length], members: tm.memberIds, total: ts.length, done, open: ts.length - done, late: ts.filter((t) => isOverdue(t, todayKey)).length }
    })
    const loose = work.all.filter((t) => !t.teamId || !teams.some((tm) => tm.id === t.teamId))
    if (loose.length && teams.length) {
      const done = loose.filter((t) => t.done).length
      rows.push({ id: '_none', name: 'No team', hue: 'var(--border-strong)', members: [], total: loose.length, done, open: loose.length - done, late: loose.filter((t) => isOverdue(t, todayKey)).length })
    }
    return rows
  }, [teams, work.all, todayKey])
  const activeTeams = teamRows.filter((r) => r.id !== '_none' && r.open > 0).length

  /* ---------- insights ---------- */
  const joined = people.filter((p) => !p.invited)
  const suggestions: Suggestion[] = []
  if (showLoad) {
    const worst = [...joined].sort((a, b) => b.overdue - a.overdue)[0]
    if (worst && worst.overdue >= 2) {
      suggestions.push({
        id: 'late',
        tone: 'bad',
        icon: <AlarmClock size={15} />,
        text: (
          <>
            <b>{worst.isMe ? 'You have' : `${worst.first} has`} {plural(worst.overdue, 'overdue task')}.</b> {worst.isMe ? 'Clear or move them.' : 'Check in or move the dates.'}
          </>
        ),
        cta: 'See tasks',
        run: () => setView('tasks')
      })
    }
    const busiest = [...joined].sort((a, b) => b.open - a.open)
    const lightest = [...joined].sort((a, b) => a.open - b.open)[0]
    if (busiest[0] && lightest && busiest[0].open >= 6 && busiest[0].open - lightest.open >= 4) {
      suggestions.push({
        id: 'balance',
        tone: 'warn',
        icon: <Scale size={15} />,
        text: (
          <>
            <b>{busiest[0].isMe ? 'You carry' : `${busiest[0].first} carries`} {busiest[0].open} open tasks</b>, {lightest.isMe ? 'you have' : `${lightest.first} has`} {lightest.open}. Worth rebalancing.
          </>
        ),
        cta: 'Reassign',
        run: () => setView('tasks')
      })
    }
    if (work.unowned.length) {
      suggestions.push({
        id: 'unowned',
        tone: 'warn',
        icon: <UserX size={15} />,
        text: (
          <>
            <b>{plural(work.unowned.length, 'task')} without an owner.</b> Hand {work.unowned.length === 1 ? 'it' : 'them'} to someone so {work.unowned.length === 1 ? 'it gets' : 'they get'} done.
          </>
        ),
        cta: 'Assign',
        run: () => openTaskEditor(work.unowned[0].id)
      })
    }
  } else {
    const myLate = work.mine.filter((t) => !t.done && isOverdue(t, todayKey))
    if (myLate.length)
      suggestions.push({
        id: 'mylate',
        tone: 'bad',
        icon: <AlarmClock size={15} />,
        text: (
          <>
            <b>{plural(myLate.length, 'of your tasks', 'of your tasks')} overdue.</b> Finish or move {myLate.length === 1 ? 'it' : 'them'}.
          </>
        ),
        cta: 'Open',
        run: () => openTaskEditor(myLate[0].id)
      })
  }
  const waiting = people.filter((p) => p.invited && p.open > 0)
  if (waiting.length) {
    suggestions.push({
      id: 'waiting',
      tone: 'info',
      icon: <Hourglass size={15} />,
      text: (
        <>
          <b>{waiting[0].first}</b> hasn't joined yet and {plural(waiting[0].open, 'task')} {waiting[0].open === 1 ? 'is' : 'are'} waiting.
          {waiting.length > 1 ? ` (+${waiting.length - 1} more)` : ''}
        </>
      ),
      cta: isAdmin ? 'Resend invite' : 'See team',
      run: () => setView('team')
    })
  }
  const loners = isAdmin && teams.length ? members.filter((m) => !m.teamIds.length) : []
  if (loners.length) {
    suggestions.push({
      id: 'loners',
      tone: 'info',
      icon: <Users size={15} />,
      text: (
        <>
          <b>{loners[0].name.split(' ')[0]}</b>
          {loners.length > 1 ? ` and ${loners.length - 1} more aren't` : " isn't"} in a team yet.
        </>
      ),
      cta: 'Add to a team',
      run: () => setView('team')
    })
  }
  if (!suggestions.length) suggestions.push({ id: 'ok', tone: 'good', icon: <CircleCheck size={15} />, text: <>Nothing needs attention. The team is on track.</> })
  const trend = stats.thisWeek - stats.lastWeek
  const lead =
    stats.thisWeek === 0 && stats.lastWeek === 0
      ? `${showLoad ? 'The team has' : 'You have'} ${plural(work.open.length, 'open task')}, ${work.dueWeek.length} due this week.`
      : `${showLoad ? 'The team' : 'You'} closed ${plural(stats.thisWeek, 'task')} this week${trend ? `, ${Math.abs(trend)} ${trend > 0 ? 'more' : 'fewer'} than last week` : ', same as last week'}.`

  /* ---------- deadlines ---------- */
  const deadlines = work.open
    .filter((t) => t.dueDate && t.dueDate <= in7)
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || (a.dueTime ?? 1440) - (b.dueTime ?? 1440))

  /* ---------- activity ---------- */
  const activity: ActivityItem[] = useMemo(() => {
    const out: ActivityItem[] = []
    const nm = (id?: string) => (id === me ? 'You' : memberName(id))
    const who = (id?: string) => {
      const m = members.find((x) => x.userId === id)
      return m ? { name: m.name, email: m.email } : undefined
    }
    for (const t of work.all) {
      if (t.done && t.completedAt) {
        const by = t.assignedTo ?? t.createdBy
        out.push({ id: `d${t.id}`, at: t.completedAt, kind: 'done', who: who(by), text: <><b>{nm(by)}</b> completed <q>{t.title}</q></>, run: () => openTaskEditor(t.id) })
      }
      const by = t.assignedBy ?? t.createdBy
      const to = t.assignedInvite ? pendingName(t.assignedInvite) : t.assignedTo && t.assignedTo !== by ? nm(t.assignedTo) : null
      out.push({
        id: `n${t.id}`,
        at: t.createdAt,
        kind: to ? 'assign' : 'new',
        who: who(by),
        text: to ? <><b>{nm(by)}</b> gave {to === 'You' ? 'you' : to} <q>{t.title}</q></> : <><b>{nm(by)}</b> added <q>{t.title}</q></>,
        run: () => openTaskEditor(t.id)
      })
    }
    for (const n of notes.filter((x) => x.companyId === activeId && x.shared)) {
      out.push({
        id: `p${n.id}`,
        at: n.updatedAt,
        kind: 'note',
        who: who(n.updatedBy ?? n.createdBy),
        text: <><b>{nm(n.updatedBy ?? n.createdBy)}</b> edited the team page <q>{n.title || 'Untitled'}</q></>,
        run: () => {
          setView('notes')
          window.setTimeout(() => window.dispatchEvent(new CustomEvent('msos:note-open', { detail: { id: n.id } })), 60)
        }
      })
    }
    // comments only exist as updates
    for (const n of notifications.filter((x) => x.kind === 'task_comment')) {
      out.push({ id: `c${n.id}`, at: n.createdAt, kind: 'comment', who: who(n.actorId), text: <>{n.title}</>, run: n.taskId ? () => openTaskEditor(n.taskId!) : undefined })
    }
    return out.filter((a) => a.at <= Date.now()).sort((a, b) => b.at - a.at).slice(0, 8)
  }, [work.all, notes, notifications, members, me, activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- my work ---------- */
  const myTabs: TaskTab[] = [
    ...statusTabs(work.mine),
    { id: 'given', label: 'Handed out', tasks: work.byMe.filter((t) => !t.done).sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')), empty: 'Type @name in a task to hand it to someone.' }
  ]

  const role = ws?.role ?? 'member'
  const rate = stats.rate

  return (
    <div className="page page-wide hm hm-co">
      <header className="hm-hero">
        <div className="hm-hero-blob a" aria-hidden />
        <div className="hm-hero-blob b" aria-hidden />
        <div className="hm-hero-main">
          <span className="hm-eyebrow">
            <span className="hm-ws">{ws?.logoUrl ? <img src={ws.logoUrl} alt="" /> : (ws?.name ?? 'W')[0]}</span>
            {ws?.name} · {ROLE_LABEL[role]}
          </span>
          <h1>
            {greetingFor()}, {first}
          </h1>
          <p>
            {plural(members.length, 'person', 'people')}
            {teams.length ? ` across ${plural(teams.length, 'team')}` : ''}. {showLoad ? 'The team has' : 'You can see'} {plural(work.open.length, 'open task')}, {work.dueWeek.length} due this week
            {work.overdue.length ? ` and ${work.overdue.length} overdue` : ''}.
          </p>
          <div className="hm-hero-acts">
            <button className="hm-hbtn solid" onClick={qa.task}>
              <UserPlus size={16} /> Assign a task
            </button>
            <button className="hm-hbtn" onClick={() => openSchedule()}>
              <CalendarPlus size={16} /> Schedule meeting
            </button>
            {isAdmin && (
              <button className="hm-hbtn" onClick={() => setInviting(true)}>
                <Users size={16} /> Invite people
              </button>
            )}
          </div>
        </div>
        <div className="hm-hero-side">
          <Ring value={rate} size={104} stroke={10} label={`${Math.round(rate * 100)}%`} sub="this week" />
          <div className="hm-hero-stats">
            <button onClick={() => setView('team')}>
              <b>{members.length}</b>
              <span>People</span>
            </button>
            <button onClick={() => setView('tasks')}>
              <b>{work.open.length}</b>
              <span>Open</span>
            </button>
            <button onClick={() => setView('tasks')} className={work.overdue.length ? 'bad' : ''}>
              <b>{work.overdue.length}</b>
              <span>Overdue</span>
            </button>
          </div>
        </div>
        <HeroButtons />
      </header>

      <QuickRow
        items={[
          { key: 'task', label: 'Task', sub: 'For you or a teammate', hue: '#6c63f7', icon: quickIcons.task, run: qa.task },
          { key: 'meeting', label: 'Meeting', sub: 'Pick a time', hue: '#0ea5e9', icon: quickIcons.meeting, run: qa.meeting },
          { key: 'note', label: 'Team page', sub: 'Docs, plans, updates', hue: '#14b8a6', icon: quickIcons.note, run: qa.note },
          isAdmin
            ? { key: 'invite', label: 'Invite people', sub: 'One or a whole list', hue: '#f59e0b', icon: <UserPlus size={19} />, run: () => setInviting(true) }
            : { key: 'reminder', label: 'Reminder', sub: 'Rings on time', hue: '#f59e0b', icon: quickIcons.reminder, run: qa.reminder },
          { key: 'speak', label: 'Say it', sub: 'Tell Mig by voice', hue: '#ec4899', icon: quickIcons.speak, run: qa.speak, wide: true }
        ]}
      />

      <NotifyPrompt />
      <GetStarted />

      <div className="hm-grid">
        <div className="hm-c8">
          <Card
            icon={<TrendingUp size={17} />}
            hue="#22c55e"
            title={showLoad ? 'Company performance' : 'Your work here'}
            sub={showLoad ? 'This week, across the workspace' : 'This week, over the tasks you can see'}
            className="hm-perf"
            action={<LinkBtn onClick={() => setView('tasks')}>Tasks</LinkBtn>}
          >
            <div className="hm-kpis">
              <div className="hm-kpi" style={{ ['--h' as string]: '#22c55e' }}>
                <span>Completed</span>
                <b>{stats.thisWeek}</b>
                <small className={trend > 0 ? 'up' : trend < 0 ? 'down' : ''}>{trend > 0 ? `▲ ${trend}` : trend < 0 ? `▼ ${-trend}` : '–'} vs last week</small>
              </div>
              <div className="hm-kpi" style={{ ['--h' as string]: '#6c63f7' }}>
                <span>Pending</span>
                <b>{work.open.length}</b>
                <small>{work.dueWeek.length} due this week</small>
              </div>
              <div className={`hm-kpi${work.overdue.length ? ' bad' : ''}`} style={{ ['--h' as string]: '#ef4444' }}>
                <span>Overdue</span>
                <b>{work.overdue.length}</b>
                <small>{work.overdue.length ? 'need a nudge' : 'all on time'}</small>
              </div>
              <div className="hm-kpi" style={{ ['--h' as string]: '#0ea5e9' }}>
                <span>Active teams</span>
                <b>{activeTeams}</b>
                <small>of {plural(teams.length, 'team')}</small>
              </div>
            </div>
            <div className="hm-perf-chart">
              <span className="hm-perf-label">Tasks completed each day</span>
              <WeekBars days={stats.days} perDay={stats.perDay} />
            </div>
          </Card>
        </div>
        <div className="hm-c4">
          <Planner
            title="Workspace insights"
            lead={lead}
            items={suggestions}
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
          <TaskTabs title="My tasks & assignments" sub="Assigned to you, and what you handed out" tabs={myTabs} assigneeOf={(t) => (taskScope(t, me) === 'by_me' ? assignee(t) : null)} />
        </div>
        <div className="hm-c5">
          <Card icon={<Flag size={17} />} hue="#ef4444" title="Upcoming deadlines" sub="Overdue and the next 7 days" className="hm-dead" action={<LinkBtn onClick={() => setView('tasks')}>Tasks</LinkBtn>}>
            {deadlines.length === 0 ? (
              <Empty>No deadlines in the next week.</Empty>
            ) : (
              <ul className="hm-dlist">
                {deadlines.slice(0, 6).map((t) => {
                  const late = isOverdue(t, todayKey)
                  const who = assignee(t)
                  const team = teams.find((x) => x.id === t.teamId)
                  return (
                    <li key={t.id}>
                      <button className={`hm-drow${late ? ' late' : ''}`} onClick={() => openTaskEditor(t.id)}>
                        <span className="hm-ddate">
                          <small>{format(new Date(t.dueDate! + 'T00:00'), 'MMM')}</small>
                          <b>{format(new Date(t.dueDate! + 'T00:00'), 'd')}</b>
                        </span>
                        <span className="hm-dbody">
                          <b>
                            {t.priority === 'high' && <Flag size={11} />} {t.title}
                          </b>
                          <small>
                            {late ? 'Overdue · ' : ''}
                            {dueLabel(t, todayKey)}
                            {team ? ` · ${team.name}` : ''}
                          </small>
                        </span>
                        {who ? <Avatar name={who.name} email={who.email} invited={who.invited} size={26} /> : <span className="hm-nobody">No owner</span>}
                      </button>
                    </li>
                  )
                })}
                {deadlines.length > 6 && <li className="hm-more">+{deadlines.length - 6} more</li>}
              </ul>
            )}
          </Card>
        </div>

        <div className="hm-c7">
          <TeamOverview people={people} showLoad={showLoad} doneWeekBy={doneWeekBy} onInvite={isAdmin ? () => setInviting(true) : undefined} />
        </div>
        <div className="hm-c5">
          <Card icon={<Layers size={17} />} hue="#8b5cf6" title="Teams & progress" sub="Done out of all tasks, per team" className="hm-teams" action={<LinkBtn onClick={() => setView('team')}>Teams</LinkBtn>}>
            {teamRows.length === 0 ? (
              <Empty
                action={
                  isAdmin ? (
                    <button className="btn btn-secondary btn-sm" onClick={() => setView('team')}>
                      Create a team
                    </button>
                  ) : undefined
                }
              >
                Group people into teams (Sales, Tech…) to track each one's progress here.
              </Empty>
            ) : (
              <ul className="hm-tmlist">
                {teamRows.map((r) => {
                  const pct = r.total ? Math.round((r.done / r.total) * 100) : 0
                  return (
                    <li key={r.id} style={{ ['--c' as string]: r.hue }}>
                      <div className="hm-tm-top">
                        <span className="hm-tm-dot" />
                        <b>{r.name}</b>
                        <span className="hm-tm-avs">
                          {r.members.slice(0, 4).map((id) => {
                            const m = members.find((x) => x.userId === id)
                            return m ? <Avatar key={id} name={m.name} email={m.email} size={22} /> : null
                          })}
                        </span>
                        <em>{pct}%</em>
                      </div>
                      <div className="hm-tm-bar">
                        <span style={{ width: `${pct}%` }} />
                      </div>
                      <small>
                        {r.done} done · {r.open} open{r.late ? <b className="late"> · {r.late} overdue</b> : ''}
                      </small>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="hm-c7">
          <CalendarAgenda tasks={work.mine.concat(work.byMe)} />
        </div>
        <div className="hm-c5">
          <UpcomingMeetings title="Meetings" />
        </div>

        <div className="hm-c12">
          <ActivityFeed items={activity} title="Recent team activity" sub="Across the workspace" />
        </div>
      </div>

      {inviting && <InviteModal many onClose={() => setInviting(false)} />}
    </div>
  )
}

/* ================= team overview ================= */

function TeamOverview({ people, showLoad, doneWeekBy, onInvite }: { people: Person[]; showLoad: boolean; doneWeekBy: Map<string, number>; onInvite?: () => void }) {
  const setView = useStore((s) => s.setView)
  const members = useWorkspace((s) => s.members)
  const teams = useWorkspace((s) => s.teams)
  const max = Math.max(8, ...people.map((p) => p.open))

  return (
    <Card
      icon={<Users size={17} />}
      hue="#0ea5e9"
      title="Team overview"
      sub={showLoad ? 'Workload and what got done this week' : 'Who is in this workspace'}
      className="hm-team"
      action={
        onInvite ? (
          <button className="hm-link" onClick={onInvite}>
            <UserPlus size={14} /> Invite
          </button>
        ) : (
          <LinkBtn onClick={() => setView('team')}>Team</LinkBtn>
        )
      }
    >
      {people.length === 0 ? (
        <Empty>No one here yet.</Empty>
      ) : (
        <ul className="hm-plist">
          {people.slice(0, 7).map((p) => {
            const m = members.find((x) => x.userId === p.userId)
            const tnames = (m?.teamIds ?? []).map((id) => teams.find((t) => t.id === id)?.name).filter(Boolean)
            // load labels only where the numbers are true (admins and managers see every task)
            const state = p.invited ? { l: 'Invited', c: 'inv' } : !showLoad ? null : p.overdue >= 2 || p.open >= 8 ? { l: 'Stretched', c: 'bad' } : p.open <= 2 ? { l: 'Has room', c: 'ok' } : { l: 'Steady', c: '' }
            return (
              <li key={p.key} className="hm-prow">
                <Avatar name={p.name} email={p.email} invited={p.invited} size={34} />
                <span className="hm-pwho">
                  <b>
                    {p.isMe ? `${p.name} (you)` : p.name}
                  </b>
                  <small>
                    {p.invited ? 'Not joined yet' : ROLE_LABEL[m?.role ?? 'member']}
                    {tnames.length ? ` · ${tnames.join(', ')}` : ''}
                  </small>
                </span>
                {showLoad && (
                  <>
                    <span className="hm-pload" title={`${p.open} open`}>
                      <span className="hm-pbar">
                        <i className={p.overdue ? 'bad' : p.open >= 8 ? 'warn' : ''} style={{ width: `${(p.open / max) * 100}%` }} />
                      </span>
                      <small>
                        {p.open} open{p.overdue ? <b> · {p.overdue} late</b> : ''}
                      </small>
                    </span>
                    <span className="hm-pdone">
                      {!p.invited && (
                        <>
                          <b>{p.userId ? (doneWeekBy.get(p.userId) ?? 0) : 0}</b>
                          <small>done</small>
                        </>
                      )}
                    </span>
                  </>
                )}
                {state && <span className={`hm-pstate ${state.c}`}>{state.l}</span>}
              </li>
            )
          })}
        </ul>
      )}
      {people.length > 7 && (
        <button className="hm-link hm-plist-more" onClick={() => setView('team')}>
          <Inbox size={14} /> See all {people.length} people
        </button>
      )}
    </Card>
  )
}
