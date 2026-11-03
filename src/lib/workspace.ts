import { create } from 'zustand'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { isSupabaseEnabled, supabase } from './supabase'
import { fireAlert } from './notify'
import type { AppNotification, Invite, Member, PendingPerson, Task, TaskComment, Team, Workspace, WorkspaceRole } from '../types'

/**
 * Team workspaces (cloud mode only).
 *
 * Everything here talks to Supabase; who may see or change what is enforced by
 * the database (row-level security + the ws_* functions in schema.sql). The
 * store below is just the app's copy of the active workspace: its members,
 * teams, pending invites and the signed-in person's notifications.
 *
 * If the team database update has not been run yet, `available` stays false
 * and the rest of the app keeps working exactly as before.
 */

export const ROLE_LABEL: Record<WorkspaceRole, string> = { admin: 'Admin', manager: 'Manager', member: 'Member' }
export const ROLE_HELP: Record<WorkspaceRole, string> = {
  admin: 'Everything — settings, invites, roles, removing people',
  manager: 'Sees every task of their teams',
  member: 'Sees their own tasks and tasks shared with them'
}
export const COMPANY_SIZES = ['Just me', '2–10', '11–50', '51–200', '200+']

const INVITE_KEY = 'msos:invite-token'
const PENDING_COMPANY_KEY = 'msos:pending-company'

/* ---------- things remembered across the sign-in step ---------- */

export const rememberInviteToken = (token: string) => {
  try {
    localStorage.setItem(INVITE_KEY, token)
  } catch {
    /* ignore */
  }
}
export const pendingInviteToken = () => {
  try {
    return localStorage.getItem(INVITE_KEY)
  } catch {
    return null
  }
}
export const forgetInviteToken = () => {
  try {
    localStorage.removeItem(INVITE_KEY)
  } catch {
    /* ignore */
  }
}

export interface PendingCompany {
  name: string
  size?: string
  logo?: string
}
export const rememberPendingCompany = (c: PendingCompany | null) => {
  try {
    if (c) localStorage.setItem(PENDING_COMPANY_KEY, JSON.stringify(c))
    else localStorage.removeItem(PENDING_COMPANY_KEY)
  } catch {
    /* ignore */
  }
}
const pendingCompany = (): PendingCompany | null => {
  try {
    const raw = localStorage.getItem(PENDING_COMPANY_KEY)
    return raw ? (JSON.parse(raw) as PendingCompany) : null
  } catch {
    return null
  }
}

/** the link an invited person opens */
export const inviteUrl = (token: string) => `${window.location.origin}/join/${token}`

/* ---------- row mappers ---------- */

type MembershipRow = {
  company_id: string
  user_id: string
  role: WorkspaceRole
  created_at: string
  companies: { id: string; name: string; logo_url: string | null; size: string | null; kind: 'company' | 'personal' } | null
}
type ProfileRow = { user_id: string; name: string; email: string; timezone?: string | null }
type TeamRow = { id: string; name: string; color: string | null }
type TeamMemberRow = { team_id: string; user_id: string }
type InviteRow = {
  id: string
  email: string
  role: WorkspaceRole
  team_id: string | null
  token: string
  status: Invite['status']
  invited_by: string | null
  created_at: string
  expires_at: string
}
type NotificationRow = {
  id: string
  kind: string
  title: string
  body: string
  task_id: string | null
  actor_id: string | null
  company_id: string | null
  read_at: string | null
  created_at: string
}
type CommentRow = { id: string; task_id: string; user_id: string; body: string; created_at: string }

const rowToNotification = (r: NotificationRow): AppNotification => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body ?? '',
  taskId: r.task_id ?? undefined,
  actorId: r.actor_id ?? undefined,
  companyId: r.company_id ?? undefined,
  readAt: r.read_at ? Date.parse(r.read_at) : undefined,
  createdAt: Date.parse(r.created_at)
})

const rowToInvite = (r: InviteRow): Invite => ({
  id: r.id,
  email: r.email ?? '',
  role: r.role,
  teamId: r.team_id ?? undefined,
  token: r.token,
  status: r.status,
  invitedBy: r.invited_by ?? undefined,
  createdAt: Date.parse(r.created_at),
  expiresAt: Date.parse(r.expires_at)
})

const rowToComment = (r: CommentRow): TaskComment => ({
  id: r.id,
  taskId: r.task_id,
  userId: r.user_id,
  body: r.body,
  createdAt: Date.parse(r.created_at)
})

/* ---------- store ---------- */

interface WorkspaceState {
  /** false until the team database update has been run (or in local mode) */
  available: boolean
  loaded: boolean
  me: string | null
  workspaces: Workspace[]
  activeId: string | null
  members: Member[]
  teams: Team[]
  invites: Invite[]
  /** invited, not joined yet — anyone in the workspace may hand them tasks */
  pending: PendingPerson[]
  /** false until the database update that lets tasks wait for invited people has been run */
  pendingOn: boolean
  notifications: AppNotification[]
  /** every task the signed-in person may see, across all their workspaces */
  allTasks: Task[]
  /** one-off message for the person (e.g. an invite link that could not be used) */
  notice: string | null

  active: () => Workspace | null
  myRole: () => WorkspaceRole | null
  isAdmin: () => boolean
  member: (userId: string | undefined) => Member | undefined
  memberName: (userId: string | undefined) => string
  /** "amara@northwind.io" → "amara" */
  pendingName: (inviteId: string | undefined) => string
  unread: () => number
}

export const useWorkspace = create<WorkspaceState>()((_set, get) => ({
  available: false,
  loaded: false,
  me: null,
  workspaces: [],
  activeId: null,
  members: [],
  teams: [],
  invites: [],
  pending: [],
  pendingOn: false,
  notifications: [],
  allTasks: [],
  notice: null,

  active: () => get().workspaces.find((w) => w.id === get().activeId) ?? null,
  myRole: () => get().active()?.role ?? null,
  isAdmin: () => get().active()?.role === 'admin',
  member: (userId) => (userId ? get().members.find((m) => m.userId === userId) : undefined),
  memberName: (userId) => {
    if (!userId) return 'Unassigned'
    if (userId === get().me) return 'You'
    const m = get().member(userId)
    return m ? m.name || m.email.split('@')[0] : 'Former member'
  },
  pendingName: (inviteId) => {
    const p = inviteId ? get().pending.find((x) => x.id === inviteId) : undefined
    return p ? nameFromEmail(p.email) : 'Someone'
  },
  unread: () => get().notifications.filter((n) => !n.readAt).length
}))

/** "priya.sharma@x.com" → "Priya Sharma" (for people who haven't signed up yet) */
export const nameFromEmail = (email: string) =>
  (email.split('@')[0] || email)
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')

/** "Priya Sharma" → "PS" */
export const initialsOf = (name: string, email = '') => {
  const src = (name || '').trim() || email.split('@')[0] || '?'
  return src
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

/* ---------- loading ---------- */

const isMissingSchema = (message: string) =>
  /does not exist|not find|schema cache|function .* not found|42P01|42883/i.test(message)

/**
 * First thing after sign-in: accept a pending invite link, create the company
 * chosen at sign-up, make sure a personal space exists, and open the right
 * workspace. Returns the active workspace id (null if team features are off).
 */
export const bootstrapWorkspace = async (userId: string): Promise<string | null> => {
  if (!isSupabaseEnabled) return null
  useWorkspace.setState({ me: userId })

  // the invite link this person opened before signing in
  const token = pendingInviteToken()
  if (token) {
    const { data, error } = await supabase.rpc('ws_accept_invite', { p_token: token })
    if (error && isMissingSchema(error.message)) return null
    const res = (data ?? {}) as { ok?: boolean; reason?: string; email?: string }
    forgetInviteToken()
    if (res.ok === false) {
      useWorkspace.setState({
        notice:
          res.reason === 'email_mismatch'
          ? `That invite was sent to ${res.email}. Sign in with that email to join.`
          : res.reason === 'expired'
            ? 'That invite link has expired — ask for a new one.'
            : 'That invite link is no longer valid.'
      })
    }
  }

  // "Create a company workspace" chosen at sign-up
  const draft = pendingCompany()
  if (draft?.name) {
    const { error } = await supabase.rpc('ws_create_company', {
      p_name: draft.name,
      p_size: draft.size ?? null,
      p_logo: draft.logo ?? null
    })
    if (error && isMissingSchema(error.message)) return null
    if (!error) rememberPendingCompany(null)
  }

  const { data, error } = await supabase.rpc('ws_bootstrap')
  if (error) {
    if (!isMissingSchema(error.message)) console.error('[workspace] bootstrap failed:', error.message)
    useWorkspace.setState({ available: false, loaded: true })
    return null
  }
  const active = ((data ?? {}) as { active?: string | null }).active ?? null
  useWorkspace.setState({ available: true, activeId: active })
  await loadWorkspace()
  return active
}

/** the active workspace's people, teams, invites + my notifications and workspaces */
export const loadWorkspace = async (): Promise<void> => {
  const { me, activeId } = useWorkspace.getState()
  if (!isSupabaseEnabled || !me) return
  const [ms, notifs] = await Promise.all([
    supabase
      .from('memberships')
      .select('company_id, user_id, role, created_at, companies(id, name, logo_url, size, kind)')
      .eq('user_id', me),
    supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(60)
  ])
  if (ms.error) {
    console.error('[workspace] load failed:', ms.error.message)
    return
  }
  const workspaces: Workspace[] = ((ms.data ?? []) as unknown as MembershipRow[])
    .filter((r) => r.companies)
    .map((r) => ({
      id: r.companies!.id,
      name: r.companies!.name,
      logoUrl: r.companies!.logo_url ?? undefined,
      size: r.companies!.size ?? undefined,
      kind: r.companies!.kind,
      role: r.role
    }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'company' ? -1 : 1))

  const active = workspaces.find((w) => w.id === activeId)?.id ?? workspaces[0]?.id ?? null
  useWorkspace.setState({
    workspaces,
    activeId: active,
    notifications: notifs.error ? useWorkspace.getState().notifications : (notifs.data as NotificationRow[]).map(rowToNotification)
  })
  await loadActiveDetails()
  useWorkspace.setState({ loaded: true })
}

const loadActiveDetails = async () => {
  const { activeId: cid } = useWorkspace.getState()
  if (!cid) {
    useWorkspace.setState({ members: [], teams: [], invites: [], pending: [] })
    return
  }
  const [ms, teams, tms, invites, pending] = await Promise.all([
    supabase.from('memberships').select('user_id, role, created_at').eq('company_id', cid),
    supabase.from('teams').select('id, name, color').eq('company_id', cid).order('created_at'),
    supabase.from('team_members').select('team_id, user_id').eq('company_id', cid),
    supabase.from('invites').select('*').eq('company_id', cid).eq('status', 'pending').order('created_at', { ascending: false }),
    // people invited but not joined yet (no link tokens); missing until the Phase 15 database update
    supabase.rpc('ws_pending_people', { p_company: cid })
  ])
  const ids = ((ms.data ?? []) as { user_id: string }[]).map((r) => r.user_id)
  // the time zone column arrives with the chat database update; until then ask without it
  let profiles: { data: ProfileRow[] | null } = { data: [] }
  if (ids.length) {
    const withTz = await supabase.from('profiles').select('user_id, name, email, timezone').in('user_id', ids)
    profiles = withTz.error ? ((await supabase.from('profiles').select('user_id, name, email').in('user_id', ids)) as { data: ProfileRow[] | null }) : (withTz as { data: ProfileRow[] | null })
  }
  const byUser = new Map(((profiles.data ?? []) as ProfileRow[]).map((p) => [p.user_id, p]))
  const teamRows = (teams.data ?? []) as TeamRow[]
  const tmRows = (tms.data ?? []) as TeamMemberRow[]

  const members: Member[] = ((ms.data ?? []) as { user_id: string; role: WorkspaceRole; created_at: string }[])
    .map((r) => ({
      userId: r.user_id,
      name: byUser.get(r.user_id)?.name ?? '',
      email: byUser.get(r.user_id)?.email ?? '',
      role: r.role,
      teamIds: tmRows.filter((t) => t.user_id === r.user_id).map((t) => t.team_id),
      joinedAt: Date.parse(r.created_at),
      timezone: byUser.get(r.user_id)?.timezone ?? undefined
    }))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))

  useWorkspace.setState({
    members,
    teams: teamRows.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color ?? undefined,
      memberIds: tmRows.filter((x) => x.team_id === t.id).map((x) => x.user_id)
    })),
    // invites are only readable by admins; others simply get an empty list
    invites: invites.error ? [] : ((invites.data ?? []) as InviteRow[]).map(rowToInvite),
    pendingOn: !pending.error,
    pending: pending.error
      ? []
      : ((pending.data ?? []) as { id: string; email: string; role: WorkspaceRole; team_id: string | null; created_at: string }[]).map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          teamId: r.team_id ?? undefined,
          createdAt: Date.parse(r.created_at)
        }))
  })
}

/** quiet refresh (used by the once-a-minute sync) */
export const refreshWorkspace = async () => {
  if (!useWorkspace.getState().available) return
  const before = new Set(useWorkspace.getState().notifications.map((n) => n.id))
  await loadWorkspace()
  // anything new that arrived while realtime was not connected
  const fresh = useWorkspace.getState().notifications.filter((n) => !before.has(n.id) && !n.readAt && Date.now() - n.createdAt < 3 * 60_000)
  if (before.size > 0) fresh.forEach(announce)
}

const announce = (n: AppNotification) => fireAlert({ kind: 'task', title: n.title, body: n.body, tag: `notif-${n.id}` })

/* ---------- live notifications ---------- */

let channel: RealtimeChannel | null = null
let onNewNotification: (() => void) | null = null

/** `onChange` runs whenever something arrives (the app re-syncs its tasks) */
export const listenForNotifications = (userId: string, onChange: () => void) => {
  if (!isSupabaseEnabled) return () => {}
  onNewNotification = onChange
  stopListening()
  channel = supabase
    .channel(`notifications-${userId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      (payload) => {
        const n = rowToNotification(payload.new as NotificationRow)
        const s = useWorkspace.getState()
        if (s.notifications.some((x) => x.id === n.id)) return
        useWorkspace.setState({ notifications: [n, ...s.notifications].slice(0, 60) })
        announce(n)
        onNewNotification?.()
      }
    )
    .subscribe()
  return stopListening
}

export const stopListening = () => {
  if (channel) {
    void supabase.removeChannel(channel)
    channel = null
  }
}

export const markAllRead = async () => {
  const s = useWorkspace.getState()
  const ids = s.notifications.filter((n) => !n.readAt).map((n) => n.id)
  if (!ids.length) return
  const now = Date.now()
  useWorkspace.setState({ notifications: s.notifications.map((n) => (n.readAt ? n : { ...n, readAt: now })) })
  if (!isSupabaseEnabled) return
  await supabase.from('notifications').update({ read_at: new Date(now).toISOString() }).in('id', ids)
}

export const clearNotifications = async () => {
  const ids = useWorkspace.getState().notifications.map((n) => n.id)
  useWorkspace.setState({ notifications: [] })
  if (ids.length && isSupabaseEnabled) await supabase.from('notifications').delete().in('id', ids)
}

/* ---------- workspaces ---------- */

export const createCompany = async (c: PendingCompany): Promise<string> => {
  const { data, error } = await supabase.rpc('ws_create_company', {
    p_name: c.name.trim(),
    p_size: c.size ?? null,
    p_logo: c.logo ?? null
  })
  if (error) throw new Error(error.message)
  useWorkspace.setState({ activeId: data as string })
  await loadWorkspace()
  return data as string
}

export const updateCompany = async (patch: { name?: string; size?: string | null; logoUrl?: string | null }) => {
  const cid = useWorkspace.getState().activeId
  if (!cid) return
  const row: Record<string, unknown> = {}
  if (patch.name !== undefined) row.name = patch.name.trim()
  if (patch.size !== undefined) row.size = patch.size
  if (patch.logoUrl !== undefined) row.logo_url = patch.logoUrl
  const { error } = await supabase.from('companies').update(row).eq('id', cid)
  if (error) throw new Error(error.message)
  useWorkspace.setState((s) => ({
    workspaces: s.workspaces.map((w) =>
      w.id === cid
        ? {
            ...w,
            name: patch.name !== undefined ? patch.name.trim() : w.name,
            size: patch.size !== undefined ? (patch.size ?? undefined) : w.size,
            logoUrl: patch.logoUrl !== undefined ? (patch.logoUrl ?? undefined) : w.logoUrl
          }
        : w
    )
  }))
}

export const switchWorkspace = async (id: string) => {
  const s = useWorkspace.getState()
  if (!s.workspaces.some((w) => w.id === id)) return
  useWorkspace.setState({ activeId: id })
  if (!isSupabaseEnabled) return
  await supabase.from('settings').update({ active_company_id: id }).eq('user_id', s.me ?? '')
  await loadActiveDetails()
}

/* ---------- invites ---------- */

export const createInvite = async (opts: { email: string; role: WorkspaceRole; teamId?: string }): Promise<Invite> => {
  const { activeId, me } = useWorkspace.getState()
  if (!activeId || !me) throw new Error('No workspace open')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.email.trim())) throw new Error('Enter the email address of the person you are inviting.')
  if (!isSupabaseEnabled) {
    // the ?team=demo preview
    localInvites([{ email: opts.email, role: opts.role, teamId: opts.teamId }])
    return useWorkspace.getState().invites[0]
  }
  const { data, error } = await supabase
    .from('invites')
    .insert({
      company_id: activeId,
      email: opts.email.trim().toLowerCase(),
      role: opts.role,
      team_id: opts.teamId ?? null,
      invited_by: me
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  const inv = rowToInvite(data as InviteRow)
  useWorkspace.setState((s) => ({
    invites: [inv, ...s.invites],
    pending: inv.email ? [{ id: inv.id, email: inv.email, role: inv.role, teamId: inv.teamId, createdAt: inv.createdAt }, ...s.pending] : s.pending
  }))
  return inv
}

export interface BulkRow {
  email: string
  name?: string
  role: WorkspaceRole
  teamId?: string
}
export type BulkResult = { email: string; ok: boolean; emailed: boolean; reason?: string; token?: string }

/**
 * Invite many people at once (pasted list or CSV). Rows go in one insert; each
 * invite is then emailed. Duplicates and existing members are filtered out
 * before this is called (see lib/people.ts → planBulkInvite).
 */
export const createInvites = async (rows: BulkRow[], onProgress?: (done: number) => void): Promise<BulkResult[]> => {
  const { activeId, me } = useWorkspace.getState()
  if (!activeId || !me) throw new Error('No workspace open')
  if (!rows.length) return []
  if (!isSupabaseEnabled) return localInvites(rows) // the ?team=demo preview
  const { data, error } = await supabase
    .from('invites')
    .insert(rows.map((r) => ({ company_id: activeId, email: r.email.trim().toLowerCase(), role: r.role, team_id: r.teamId ?? null, invited_by: me })))
    .select('*')
  if (error) throw new Error(error.message)
  const made = ((data ?? []) as InviteRow[]).map(rowToInvite)
  useWorkspace.setState((s) => ({
    invites: [...made, ...s.invites],
    pending: [...made.map((i) => ({ id: i.id, email: i.email, role: i.role, teamId: i.teamId, createdAt: i.createdAt })), ...s.pending]
  }))
  const out: BulkResult[] = []
  // one at a time: email services throttle bursts
  for (const inv of made) {
    const r = await emailInvite(inv.token)
    out.push({ email: inv.email, ok: true, emailed: r.sent, reason: r.reason, token: inv.token })
    onProgress?.(out.length)
  }
  return out
}

/** dev preview only (?team=demo): invites live in memory, nothing is sent */
const localInvites = (rows: BulkRow[]): BulkResult[] => {
  const made: Invite[] = rows.map((r) => ({
    id: `sample-i-${crypto.randomUUID()}`,
    email: r.email.trim().toLowerCase(),
    role: r.role,
    teamId: r.teamId,
    token: crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''),
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 14 * 86_400_000
  }))
  useWorkspace.setState((s) => ({
    invites: [...made, ...s.invites],
    pending: [...made.map((i) => ({ id: i.id, email: i.email, role: i.role, teamId: i.teamId, createdAt: i.createdAt })), ...s.pending]
  }))
  return made.map((i) => ({ email: i.email, ok: true, emailed: false, reason: 'local', token: i.token }))
}

export const cancelInvite = async (id: string) => {
  useWorkspace.setState((s) => ({ invites: s.invites.filter((i) => i.id !== id), pending: s.pending.filter((p) => p.id !== id) }))
  if (!isSupabaseEnabled) return
  await supabase.from('invites').update({ status: 'cancelled' }).eq('id', id)
}

/** keeps the same link alive for another two weeks */
export const resendInvite = async (id: string): Promise<Invite | null> => {
  const expires = new Date(Date.now() + 14 * 86_400_000).toISOString()
  const { data, error } = await supabase.from('invites').update({ expires_at: expires }).eq('id', id).select('*').single()
  if (error) return null
  const inv = rowToInvite(data as InviteRow)
  useWorkspace.setState((s) => ({ invites: s.invites.map((i) => (i.id === id ? inv : i)) }))
  return inv
}

/**
 * Emails the invite link through the site's email service, when one is set up
 * (Gmail, SMTP or Resend on Netlify). Otherwise the admin shares the link themselves.
 */
export const emailInvite = async (token: string): Promise<{ sent: boolean; reason?: string }> => {
  if (!isSupabaseEnabled) return { sent: false, reason: 'local' }
  try {
    const { data } = await supabase.auth.getSession()
    const jwt = data.session?.access_token
    if (!jwt) return { sent: false, reason: 'not_signed_in' }
    const res = await fetch('/api/invite-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ token, url: inviteUrl(token) })
    })
    if (!res.ok) return { sent: false, reason: `http_${res.status}` }
    return (await res.json()) as { sent: boolean; reason?: string }
  } catch {
    return { sent: false, reason: 'network' }
  }
}

export const previewInvite = async (token: string) => {
  if (!isSupabaseEnabled) return null
  const { data, error } = await supabase.rpc('ws_invite_preview', { p_token: token })
  if (error) return null
  return data as { ok: boolean; reason?: string; company?: string; logo?: string | null; email?: string; role?: WorkspaceRole; inviter?: string }
}

/* ---------- people & roles ---------- */

export const setMemberRole = async (userId: string, role: WorkspaceRole) => {
  const cid = useWorkspace.getState().activeId
  if (!cid) return
  const { error } = await supabase.rpc('ws_set_role', { p_company: cid, p_user: userId, p_role: role })
  if (error) throw new Error(friendly(error.message))
  useWorkspace.setState((s) => ({
    members: s.members.map((m) => (m.userId === userId ? { ...m, role } : m)),
    workspaces: userId === s.me ? s.workspaces.map((w) => (w.id === cid ? { ...w, role } : w)) : s.workspaces
  }))
}

export const removeMember = async (userId: string) => {
  const cid = useWorkspace.getState().activeId
  if (!cid) return
  const { error } = await supabase.rpc('ws_remove_member', { p_company: cid, p_user: userId })
  if (error) throw new Error(friendly(error.message))
  const s = useWorkspace.getState()
  if (userId === s.me) {
    useWorkspace.setState({ workspaces: s.workspaces.filter((w) => w.id !== cid), activeId: null })
    await loadWorkspace()
  } else {
    useWorkspace.setState({
      members: s.members.filter((m) => m.userId !== userId),
      teams: s.teams.map((t) => ({ ...t, memberIds: t.memberIds.filter((id) => id !== userId) }))
    })
  }
}

const friendly = (msg: string) =>
  msg.includes('at least one admin')
    ? 'A workspace needs at least one admin. Make someone else an admin first.'
    : msg.includes('admins only')
      ? 'Only an admin can do that.'
      : msg

/* ---------- teams ---------- */

export const createTeam = async (name: string): Promise<Team> => {
  const cid = useWorkspace.getState().activeId
  if (!cid) throw new Error('No workspace open')
  const { data, error } = await supabase.from('teams').insert({ company_id: cid, name: name.trim() }).select('id, name, color').single()
  if (error) throw new Error(error.message)
  const t: Team = { id: (data as TeamRow).id, name: (data as TeamRow).name, memberIds: [] }
  useWorkspace.setState((s) => ({ teams: [...s.teams, t] }))
  return t
}

export const renameTeam = async (id: string, name: string) => {
  useWorkspace.setState((s) => ({ teams: s.teams.map((t) => (t.id === id ? { ...t, name } : t)) }))
  await supabase.from('teams').update({ name: name.trim() }).eq('id', id)
}

export const deleteTeam = async (id: string) => {
  useWorkspace.setState((s) => ({
    teams: s.teams.filter((t) => t.id !== id),
    members: s.members.map((m) => ({ ...m, teamIds: m.teamIds.filter((x) => x !== id) }))
  }))
  await supabase.from('teams').delete().eq('id', id)
}

/** put exactly these people in a team */
export const setTeamMembers = async (teamId: string, userIds: string[]) => {
  const s = useWorkspace.getState()
  const cid = s.activeId
  const team = s.teams.find((t) => t.id === teamId)
  if (!cid || !team) return
  const add = userIds.filter((u) => !team.memberIds.includes(u))
  const remove = team.memberIds.filter((u) => !userIds.includes(u))
  useWorkspace.setState({
    teams: s.teams.map((t) => (t.id === teamId ? { ...t, memberIds: userIds } : t)),
    members: s.members.map((m) =>
      userIds.includes(m.userId)
        ? { ...m, teamIds: m.teamIds.includes(teamId) ? m.teamIds : [...m.teamIds, teamId] }
        : { ...m, teamIds: m.teamIds.filter((x) => x !== teamId) }
    )
  })
  if (add.length) await supabase.from('team_members').insert(add.map((u) => ({ team_id: teamId, user_id: u, company_id: cid })))
  if (remove.length) await supabase.from('team_members').delete().eq('team_id', teamId).in('user_id', remove)
}

/* ---------- comments ---------- */

export const fetchComments = async (taskId: string): Promise<TaskComment[]> => {
  if (!isSupabaseEnabled) return []
  const { data, error } = await supabase.from('task_comments').select('*').eq('task_id', taskId).order('created_at')
  if (error) return []
  return (data as CommentRow[]).map(rowToComment)
}

export const addComment = async (taskId: string, body: string): Promise<TaskComment | null> => {
  const me = useWorkspace.getState().me
  if (!me) return null
  const { data, error } = await supabase.from('task_comments').insert({ task_id: taskId, user_id: me, body: body.trim() }).select('*').single()
  if (error) return null
  return rowToComment(data as CommentRow)
}

export const deleteComment = async (id: string) => {
  await supabase.from('task_comments').delete().eq('id', id)
}

/* ---------- tasks seen through the workspace ---------- */

/** which tab a task belongs to on the Tasks page */
export type TaskScope = 'mine' | 'by_me' | 'team'

export const taskScope = (t: Task, me: string | null): TaskScope => {
  if (!me || !t.companyId) return 'mine'
  // mine: assigned to me, or something I created that nobody else owns yet
  if (t.assignedTo === me) return 'mine'
  // waiting for someone invited to join
  if (t.assignedInvite) return t.assignedBy === me || (!t.assignedBy && t.createdBy === me) ? 'by_me' : 'team'
  if (!t.assignedTo && (!t.createdBy || t.createdBy === me)) return 'mine'
  // handed out by me to someone else
  if (t.assignedBy === me && t.assignedTo && t.assignedTo !== me) return 'by_me'
  return 'team'
}

/** tasks of the workspace that is open (legacy tasks without a workspace stay visible) */
export const tasksForWorkspace = (tasks: Task[], activeId: string | null) =>
  activeId ? tasks.filter((t) => !t.companyId || t.companyId === activeId) : tasks
