/**
 * People you can hand a task to, in one list: members of the open workspace
 * and people invited but not joined yet. Each comes with their current load
 * (open / overdue tasks) and is ordered by who you assign to most.
 *
 * A person's key is their user id, or "invite:<invite id>" for someone who
 * hasn't joined — see assignFromKey().
 */
import { useMemo } from 'react'
import { useStore } from '../store/useStore'
import { initialsOf, nameFromEmail, useWorkspace } from './workspace'
import { isOverdue } from './tasks'
import { toDateKey } from './time'
import type { SelectOption } from '../components/Select'
import type { Member, PendingPerson, Task, WorkspaceRole } from '../types'

export const INVITE = 'invite:'

export interface Person {
  key: string
  userId?: string
  inviteId?: string
  name: string
  first: string
  email: string
  initials: string
  invited: boolean
  isMe: boolean
  open: number
  overdue: number
}

/** the picker value of a task's assignee ('' = nobody) */
export const personKey = (t: Pick<Task, 'assignedTo' | 'assignedInvite'>) =>
  t.assignedInvite ? INVITE + t.assignedInvite : (t.assignedTo ?? '')

/** picker value → the task fields to save */
export const assignFromKey = (key: string): Pick<Task, 'assignedTo' | 'assignedInvite'> =>
  key.startsWith(INVITE)
    ? { assignedTo: undefined, assignedInvite: key.slice(INVITE.length) }
    : { assignedTo: key || undefined, assignedInvite: undefined }

/** "6 open · 2 overdue", or "Free" */
export const loadLabel = (p: Pick<Person, 'open' | 'overdue' | 'invited'>) => {
  if (p.invited && !p.open) return 'Invited · not joined yet'
  const parts = [p.open ? `${p.open} open` : 'Free']
  if (p.overdue) parts.push(`${p.overdue} overdue`)
  if (p.invited) parts.push('invited')
  return parts.join(' · ')
}
/** 8+ open tasks counts as busy */
export const loadTone = (p: Pick<Person, 'open' | 'overdue'>): 'warn' | 'bad' | undefined =>
  p.overdue ? 'bad' : p.open >= 8 ? 'warn' : undefined

/** only people who see everyone's tasks get workload numbers that are true */
export const seesLoad = (role: WorkspaceRole | null) => role === 'admin' || role === 'manager'

const build = (members: Member[], pending: PendingPerson[], tasks: Task[], me: string | null, activeId: string | null): Person[] => {
  const todayKey = toDateKey(new Date())
  const open = new Map<string, number>()
  const overdue = new Map<string, number>()
  const freq = new Map<string, number>()
  const since = Date.now() - 60 * 86_400_000
  for (const t of tasks) {
    if (t.companyId !== activeId) continue
    const k = personKey(t)
    if (!k) continue
    if (!t.done) {
      open.set(k, (open.get(k) ?? 0) + 1)
      if (isOverdue(t, todayKey)) overdue.set(k, (overdue.get(k) ?? 0) + 1)
    }
    // who I hand work to most often floats to the top
    if (t.assignedBy === me && k !== me && t.createdAt > since) freq.set(k, (freq.get(k) ?? 0) + 1)
  }
  const joined: Person[] = members.map((m) => {
    const name = m.name || nameFromEmail(m.email)
    return {
      key: m.userId,
      userId: m.userId,
      name,
      first: name.split(/\s+/)[0],
      email: m.email,
      initials: initialsOf(m.name, m.email),
      invited: false,
      isMe: m.userId === me,
      open: open.get(m.userId) ?? 0,
      overdue: overdue.get(m.userId) ?? 0
    }
  })
  const emails = new Set(members.map((m) => m.email.toLowerCase()))
  const waiting: Person[] = pending
    .filter((p) => p.email && !emails.has(p.email.toLowerCase()))
    .map((p) => {
      const name = nameFromEmail(p.email)
      const key = INVITE + p.id
      return {
        key,
        inviteId: p.id,
        name,
        first: name.split(/\s+/)[0],
        email: p.email,
        initials: initialsOf(name, p.email),
        invited: true,
        isMe: false,
        open: open.get(key) ?? 0,
        overdue: overdue.get(key) ?? 0
      }
    })
  const meFirst = (p: Person) => (p.isMe ? 1 : 0)
  return [...joined, ...waiting].sort(
    (a, b) => meFirst(b) - meFirst(a) || (freq.get(b.key) ?? 0) - (freq.get(a.key) ?? 0) || Number(a.invited) - Number(b.invited) || a.name.localeCompare(b.name)
  )
}

/** everyone you can assign to in the open workspace (empty outside one) */
export const usePeople = () => {
  const members = useWorkspace((s) => s.members)
  const pending = useWorkspace((s) => s.pending)
  const pendingOn = useWorkspace((s) => s.pendingOn)
  const me = useWorkspace((s) => s.me)
  const activeId = useWorkspace((s) => s.activeId)
  const role = useWorkspace((s) => s.active()?.role ?? null)
  const company = useWorkspace((s) => s.available && s.workspaces.find((w) => w.id === s.activeId)?.kind === 'company')
  const tasks = useStore((s) => s.tasks)
  const people = useMemo(
    () => (company ? build(members, pendingOn ? pending : [], tasks, me, activeId) : []),
    [company, members, pending, pendingOn, tasks, me, activeId]
  )
  return { people, showLoad: seesLoad(role), me, company: !!company }
}

/** options for the assignee dropdowns (Me first, then most-assigned, Unassigned last) */
export const personOptions = (people: Person[], showLoad: boolean, withNobody = true): SelectOption[] => [
  ...people.map((p) => ({
    value: p.key,
    label: p.isMe ? `Me (${p.first})` : p.invited ? `${p.name} · invited` : p.name,
    hint: showLoad ? loadLabel(p) : p.invited ? 'Gets it when they join' : undefined,
    tone: showLoad ? loadTone(p) : undefined
  })),
  ...(withNobody ? [{ value: '', label: 'Unassigned' }] : [])
]

/** who a key points to, for labels ("Priya", "Amara (invited)") */
export const personName = (people: Person[], key: string) => {
  const p = people.find((x) => x.key === key)
  if (!p) return key ? 'Someone' : 'Unassigned'
  return p.isMe ? 'You' : p.invited ? `${p.first} (invited)` : p.first
}

/* ---------- @mentions while typing ---------- */

/** the "@pri" being typed right before the cursor, if any */
export const mentionAt = (text: string, caret: number): { start: number; query: string } | null => {
  const m = /(^|\s)@([\p{L}\p{N}._-]*)$/u.exec(text.slice(0, caret))
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null
}

/** people whose name / email starts with the query (any word) */
export const matchPeople = (people: Person[], query: string) => {
  const q = query.toLowerCase()
  if (!q) return people
  return people.filter((p) => {
    const words = [...p.name.toLowerCase().split(/\s+/), p.email.toLowerCase(), p.name.toLowerCase().replace(/\s+/g, '')]
    return words.some((w) => w.startsWith(q)) || (q === 'me' && p.isMe)
  })
}

/** "@Priya" in finished text → that person, if exactly one matches */
export const resolveMention = (people: Person[], text: string): { key: string; text: string } | null => {
  const re = /(^|\s)@([\p{L}\p{N}._-]+)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const token = m[2].toLowerCase()
    const hits = people.filter(
      (p) =>
        p.first.toLowerCase() === token ||
        p.name.toLowerCase().replace(/\s+/g, '') === token ||
        p.email.toLowerCase().split('@')[0] === token ||
        (token === 'me' && p.isMe)
    )
    if (hits.length === 1) {
      const cleaned = (text.slice(0, m.index) + m[1] + text.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').trim()
      return { key: hits[0].key, text: cleaned }
    }
  }
  return null
}
