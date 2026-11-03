import { useEffect, useState } from 'react'
import PinnedPages from '../components/PinnedPages'
import { formatDistanceToNowStrict } from 'date-fns'
import {
  AlertTriangle,
  Building2,
  Check,
  CloudOff,
  Copy,
  Link2,
  LogOut,
  Mail,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X
} from 'lucide-react'
import { useStore } from '../store/useStore'
import {
  COMPANY_SIZES,
  ROLE_HELP,
  ROLE_LABEL,
  cancelInvite,
  createTeam,
  deleteTeam,
  emailInvite,
  initialsOf,
  inviteUrl,
  loadWorkspace,
  removeMember,
  renameTeam,
  resendInvite,
  setMemberRole,
  setTeamMembers,
  updateCompany,
  useWorkspace
} from '../lib/workspace'
import { isSupabaseEnabled } from '../lib/supabase'
import { messagePerson } from '../lib/chat'
import Select from '../components/Select'
import Modal from '../components/Modal'
import InviteModal, { copyText } from '../components/InviteModal'
import CreateCompanyModal, { LogoPicker } from '../components/CreateCompanyModal'
import { WorkspaceMark } from '../components/WorkspaceSwitcher'
import type { Member, Team, WorkspaceRole } from '../types'

const ROLES: WorkspaceRole[] = ['admin', 'manager', 'member']

export default function TeamView() {
  const available = useWorkspace((s) => s.available)
  const loaded = useWorkspace((s) => s.loaded)
  const me = useWorkspace((s) => s.me)
  const workspaces = useWorkspace((s) => s.workspaces)
  const activeId = useWorkspace((s) => s.activeId)
  const members = useWorkspace((s) => s.members)
  const teams = useWorkspace((s) => s.teams)
  const invites = useWorkspace((s) => s.invites)
  const tasks = useStore((s) => s.tasks)
  const active = workspaces.find((w) => w.id === activeId)
  const isAdmin = active?.role === 'admin'

  const [inviting, setInviting] = useState<false | 'one' | 'many'>(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (available) void loadWorkspace()
  }, [available, activeId])

  if (!available && (loaded || !isSupabaseEnabled)) {
    return (
      <div className="page" style={{ maxWidth: 680 }}>
        <Header />
        <div className="card settings-rows team-off">
          <CloudOff size={26} />
          <b>Team workspaces are not switched on yet</b>
          <span>
            {isSupabaseEnabled
              ? 'Run the latest supabase/schema.sql in your Supabase project, then sign out and back in.'
              : 'Team features need the cloud account (Supabase). Everything else works as usual.'}
          </span>
        </div>
      </div>
    )
  }
  if (!active) return null

  const openCount = (uid: string) => tasks.filter((t) => !t.done && t.assignedTo === uid).length
  const admins = members.filter((m) => m.role === 'admin').length

  return (
    <div className="page page-wide team-page">
      <Header
        right={
          isAdmin && active.kind === 'company' ? (
            <div className="team-head-btns">
              <button className="btn btn-secondary" onClick={() => setInviting('many')} title="Paste a list of emails or upload a CSV">
                <Users size={16} /> Add many at once
              </button>
              <button className="btn btn-primary" onClick={() => setInviting('one')}>
                <UserPlus size={16} /> Invite people
              </button>
            </div>
          ) : undefined
        }
      />

      <div className="team-hero card">
        <WorkspaceMark ws={active} size={46} />
        <div className="team-hero-text">
          <b>{active.name}</b>
          <span>
            {active.kind === 'personal' ? 'Your personal space · just you' : `${members.length} ${members.length === 1 ? 'person' : 'people'}`}
            {active.kind === 'company' && teams.length > 0 && ` · ${teams.length} ${teams.length === 1 ? 'team' : 'teams'}`}
            {' · you are '}
            <span className={`role-badge ${active.role}`}>{ROLE_LABEL[active.role]}</span>
          </span>
        </div>
        {active.kind === 'personal' && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Building2 size={16} /> Create a company workspace
          </button>
        )}
      </div>

      {active.kind === 'personal' && (
        <div className="team-intro">
          <Users size={18} />
          <div>
            <b>Work with your team</b>
            <span>Create a company workspace, invite people by email or link, give them roles and assign tasks to each other. Your personal space stays exactly as it is.</span>
          </div>
        </div>
      )}

      {error && (
        <div className="conflict-note" style={{ marginBottom: 16 }}>
          <AlertTriangle size={16} /> {error}
          <button className="link-btn" style={{ marginLeft: 'auto' }} onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* ---------- people ---------- */}
      <section className="settings-group">
        <div className="settings-group-title">People</div>
        <div className="card team-table">
          <div className="tm-row tm-th">
            <span>Name</span>
            <span>Role</span>
            <span>Teams</span>
            <span>Open tasks</span>
            <span />
          </div>
          {members.map((m) => (
            <MemberRow key={m.userId} m={m} me={me} isAdmin={isAdmin} teams={teams} openTasks={openCount(m.userId)} lastAdmin={m.role === 'admin' && admins === 1} onError={setError} />
          ))}
        </div>
      </section>

      {/* ---------- pending invites ---------- */}
      {isAdmin && active.kind === 'company' && (
        <section className="settings-group">
          <div className="settings-group-title">Pending invites</div>
          {invites.length === 0 ? (
            <div className="card team-empty">
              <Mail size={18} />
              <span>No one is waiting to join. </span>
              <button className="link-btn" onClick={() => setInviting('one')}>
                Invite someone
              </button>
              <span>or</span>
              <button className="link-btn" onClick={() => setInviting('many')}>
                paste a whole list
              </button>
            </div>
          ) : (
            <div className="card team-table">
              {invites.map((inv) => (
                <InviteRow
                  key={inv.id}
                  inv={inv}
                  teamName={teams.find((t) => t.id === inv.teamId)?.name}
                  waiting={tasks.filter((t) => !t.done && t.assignedInvite === inv.id).length}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ---------- teams ---------- */}
      {active.kind === 'company' && <TeamsSection teams={teams} members={members} isAdmin={isAdmin} onError={setError} />}

      {active.kind === 'company' && <PinnedPages isAdmin={isAdmin} />}

      {/* ---------- workspace settings ---------- */}
      {isAdmin && active.kind === 'company' && <WorkspaceSettings name={active.name} size={active.size} logo={active.logoUrl} onError={setError} />}

      {active.kind === 'company' && me && !(active.role === 'admin' && admins === 1) && (
        <section className="settings-group">
          <div className="settings-group-title">Leave</div>
          <div className="card settings-rows">
            <LeaveButton onError={setError} />
          </div>
        </section>
      )}

      {inviting && <InviteModal many={inviting === 'many'} onClose={() => setInviting(false)} />}
      {creating && <CreateCompanyModal onClose={() => setCreating(false)} />}
    </div>
  )
}

function Header({ right }: { right?: React.ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">Team</h1>
        <p className="page-subtitle">Who is in this workspace, what they can do, and which teams they belong to</p>
      </div>
      {right}
    </div>
  )
}

/* ================= members ================= */

function MemberRow({
  m,
  me,
  isAdmin,
  teams,
  openTasks,
  lastAdmin,
  onError
}: {
  m: Member
  me: string | null
  isAdmin: boolean
  teams: Team[]
  openTasks: number
  lastAdmin: boolean
  onError: (e: string) => void
}) {
  const [confirm, setConfirm] = useState(false)
  const [editTeams, setEditTeams] = useState(false)
  const name = m.name || m.email.split('@')[0]
  const myTeams = teams.filter((t) => m.teamIds.includes(t.id))

  const changeRole = async (role: string) => {
    try {
      await setMemberRole(m.userId, role as WorkspaceRole)
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const remove = async () => {
    try {
      await removeMember(m.userId)
    } catch (e) {
      onError((e as Error).message)
      setConfirm(false)
    }
  }

  return (
    <div className="tm-row">
      <span className="tm-who">
        <span className="user-avatar">{initialsOf(m.name, m.email)}</span>
        <span className="tm-who-text">
          <b>
            {name}
            {m.userId === me && <em> (you)</em>}
          </b>
          <small>{m.email}</small>
        </span>
      </span>
      <span>
        {isAdmin && !(lastAdmin && m.userId === me) ? (
          <Select ariaLabel="Role" value={m.role} onChange={(v) => void changeRole(v)} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
        ) : (
          <span className={`role-badge ${m.role}`} title={ROLE_HELP[m.role]}>
            {ROLE_LABEL[m.role]}
          </span>
        )}
      </span>
      <span className="tm-teams">
        {myTeams.length === 0 && <span className="tdd-muted">—</span>}
        {myTeams.map((t) => (
          <span key={t.id} className="tm-chip">
            {t.name}
          </span>
        ))}
        {isAdmin && teams.length > 0 && (
          <button className="tm-edit" onClick={() => setEditTeams(true)} aria-label="Edit teams" title="Edit teams">
            <Pencil size={12} />
          </button>
        )}
      </span>
      <span className="tm-count">
        <b>{openTasks}</b> open
      </span>
      <span className="tm-actions">
        {m.userId !== me && (
          <button className="tm-msg" onClick={() => void messagePerson(m.userId)} title={`Message ${name}`} aria-label={`Message ${name}`}>
            <MessageCircle size={14} />
          </button>
        )}
        {isAdmin && m.userId !== me && (
          <button className={`tm-remove${confirm ? ' on' : ''}`} onClick={() => (confirm ? void remove() : setConfirm(true))} onBlur={() => setConfirm(false)} title="Remove from workspace">
            <UserMinus size={14} />
            {confirm && 'Remove?'}
          </button>
        )}
      </span>
      {editTeams && <MemberTeamsModal m={m} teams={teams} onClose={() => setEditTeams(false)} />}
    </div>
  )
}

function MemberTeamsModal({ m, teams, onClose }: { m: Member; teams: Team[]; onClose: () => void }) {
  const toggle = (t: Team) => {
    const has = t.memberIds.includes(m.userId)
    void setTeamMembers(t.id, has ? t.memberIds.filter((u) => u !== m.userId) : [...t.memberIds, m.userId])
  }
  return (
    <Modal title={`Teams for ${m.name || m.email}`} onClose={onClose} footer={<button className="btn btn-primary btn-lg" onClick={onClose}>Done</button>}>
      <div className="check-list">
        {teams.map((t) => {
          const on = t.memberIds.includes(m.userId)
          return (
            <button key={t.id} className={`check-item${on ? ' on' : ''}`} onClick={() => toggle(t)}>
              <span className={`tdd-box${on ? ' on' : ''}`}>{on && <Check size={12} strokeWidth={3.4} />}</span>
              {t.name}
              <small>{t.memberIds.length} {t.memberIds.length === 1 ? 'person' : 'people'}</small>
            </button>
          )
        })}
      </div>
    </Modal>
  )
}

/* ================= invites ================= */

function InviteRow({
  inv,
  teamName,
  waiting
}: {
  inv: { id: string; email: string; role: WorkspaceRole; token: string; expiresAt: number }
  teamName?: string
  /** open tasks already handed to them */
  waiting: number
}) {
  const [copied, setCopied] = useState(false)
  const [resent, setResent] = useState<string | null>(null)
  const link = inviteUrl(inv.token)

  const resend = async () => {
    const fresh = await resendInvite(inv.id)
    if (!fresh) return
    if (fresh.email) {
      const r = await emailInvite(fresh.token)
      setResent(r.sent ? 'Email sent again' : 'Link renewed — share it again')
    } else setResent('Link renewed for 14 days')
    setTimeout(() => setResent(null), 2500)
  }

  return (
    <div className="tm-row inv-row">
      <span className="tm-who">
        <span className="user-avatar inv-avatar">{inv.email ? <Mail size={14} /> : <Link2 size={14} />}</span>
        <span className="tm-who-text">
          <b>{inv.email || 'Shareable link'}</b>
          <small>
            {teamName ? `${teamName} · ` : ''}
            {waiting > 0 && <span className="inv-waiting">{waiting} task{waiting === 1 ? '' : 's'} waiting · </span>}
            {inv.expiresAt > Date.now() ? `expires in ${formatDistanceToNowStrict(inv.expiresAt)}` : 'expired'}
          </small>
        </span>
      </span>
      <span>
        <span className={`role-badge ${inv.role}`}>{ROLE_LABEL[inv.role]}</span>
      </span>
      <span className="inv-actions">
        {resent ? (
          <span className="inv-ok">
            <Check size={13} /> {resent}
          </span>
        ) : (
          <>
            <button
              className="btn btn-secondary btn-sm"
              onClick={async () => {
                setCopied(await copyText(link))
                setTimeout(() => setCopied(false), 1800)
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy link'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => void resend()}>
              <RefreshCw size={13} /> Resend
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                // tasks waiting for them go back to unassigned (the server does the same)
                useStore.setState((st) => ({ tasks: st.tasks.map((t) => (t.assignedInvite === inv.id ? { ...t, assignedInvite: undefined } : t)) }))
                void cancelInvite(inv.id)
              }}
              title={waiting ? `Cancel invite. Their ${waiting} task${waiting === 1 ? '' : 's'} become unassigned` : 'Cancel invite'}
            >
              <X size={14} /> Cancel
            </button>
          </>
        )}
      </span>
    </div>
  )
}

/* ================= teams ================= */

function TeamsSection({ teams, members, isAdmin, onError }: { teams: Team[]; members: Member[]; isAdmin: boolean; onError: (e: string) => void }) {
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<Team | null>(null)

  const add = async () => {
    if (!name.trim()) return
    try {
      await createTeam(name)
      setName('')
    } catch (e) {
      onError((e as Error).message)
    }
  }

  return (
    <section className="settings-group">
      <div className="settings-group-title">Teams</div>
      {teams.length === 0 && !isAdmin && (
        <div className="card team-empty">
          <Users size={18} />
          <span>No teams yet.</span>
        </div>
      )}
      <div className="team-grid">
        {teams.map((t) => (
          <div key={t.id} className="card team-card">
            <div className="team-card-head">
              <b>{t.name}</b>
              {isAdmin && (
                <button className="btn btn-ghost btn-icon" onClick={() => setEditing(t)} aria-label="Edit team" title="Edit team">
                  <Pencil size={14} />
                </button>
              )}
            </div>
            <div className="team-card-people">
              {t.memberIds.length === 0 ? (
                <span className="tdd-muted">Nobody yet</span>
              ) : (
                <>
                  <span className="avatar-stack">
                    {t.memberIds.slice(0, 5).map((uid) => {
                      const m = members.find((x) => x.userId === uid)
                      return (
                        <span key={uid} className="user-avatar" title={m?.name || m?.email}>
                          {initialsOf(m?.name ?? '', m?.email ?? '')}
                        </span>
                      )
                    })}
                  </span>
                  <span>
                    {t.memberIds.length} {t.memberIds.length === 1 ? 'person' : 'people'}
                  </span>
                </>
              )}
            </div>
          </div>
        ))}
        {isAdmin && (
          <div className="card team-card team-card-new">
            <label>New team</label>
            <div className="team-new-row">
              <input className="input" placeholder="e.g. Sales, Tech, Ops" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} maxLength={40} />
              <button className="btn btn-primary" onClick={add} disabled={!name.trim()} aria-label="Add team">
                <Plus size={16} strokeWidth={2.6} />
              </button>
            </div>
          </div>
        )}
      </div>
      {editing && <TeamEditModal team={teams.find((t) => t.id === editing.id) ?? editing} members={members} onClose={() => setEditing(null)} />}
    </section>
  )
}

function TeamEditModal({ team, members, onClose }: { team: Team; members: Member[]; onClose: () => void }) {
  const [name, setName] = useState(team.name)
  const [confirm, setConfirm] = useState(false)
  const toggle = (uid: string) => {
    const has = team.memberIds.includes(uid)
    void setTeamMembers(team.id, has ? team.memberIds.filter((u) => u !== uid) : [...team.memberIds, uid])
  }
  return (
    <Modal
      title="Edit team"
      onClose={onClose}
      footer={
        <>
          <button
            className="btn btn-danger"
            style={{ flex: '0 0 auto' }}
            onClick={() => {
              if (!confirm) return setConfirm(true)
              void deleteTeam(team.id)
              onClose()
            }}
          >
            <Trash2 size={16} />
            {confirm && 'Delete?'}
          </button>
          <button className="btn btn-secondary btn-lg" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-lg"
            disabled={!name.trim()}
            onClick={() => {
              if (name.trim() !== team.name) void renameTeam(team.id, name)
              onClose()
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label>Team name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </div>
      <div className="field">
        <label>People in this team</label>
        <div className="check-list">
          {members.map((m) => {
            const on = team.memberIds.includes(m.userId)
            return (
              <button key={m.userId} className={`check-item${on ? ' on' : ''}`} onClick={() => toggle(m.userId)}>
                <span className={`tdd-box${on ? ' on' : ''}`}>{on && <Check size={12} strokeWidth={3.4} />}</span>
                {m.name || m.email}
                <small>{ROLE_LABEL[m.role]}</small>
              </button>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

/* ================= workspace settings ================= */

function WorkspaceSettings({ name, size, logo, onError }: { name: string; size?: string; logo?: string; onError: (e: string) => void }) {
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])
  const save = async (patch: { name?: string; size?: string | null; logoUrl?: string | null }) => {
    try {
      await updateCompany(patch)
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return (
    <section className="settings-group">
      <div className="settings-group-title">Workspace</div>
      <div className="card settings-rows">
        <div className="field">
          <label>Company name</label>
          <input className="input" value={draft} maxLength={80} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft.trim() && draft.trim() !== name && void save({ name: draft })} />
        </div>
        <div className="field">
          <label>Company size</label>
          <div className="chip-row">
            {COMPANY_SIZES.map((s) => (
              <button key={s} className={`chip${size === s ? ' active' : ''}`} onClick={() => void save({ size: s })}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <LogoPicker value={logo} onChange={(v) => void save({ logoUrl: v ?? null })} name={name} />
      </div>
    </section>
  )
}

function LeaveButton({ onError }: { onError: (e: string) => void }) {
  const [confirm, setConfirm] = useState(false)
  const setView = useStore((s) => s.setView)
  const me = useWorkspace((s) => s.me)
  const leave = async () => {
    if (!me) return
    try {
      await removeMember(me)
      setView('dashboard')
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ flex: 1, fontSize: 13.5, color: 'var(--text-secondary)' }}>Leave this workspace. Tasks you created stay with the team; your personal space is untouched.</span>
      <button className="btn btn-danger" onClick={() => (confirm ? void leave() : setConfirm(true))} onBlur={() => setConfirm(false)}>
        <LogOut size={15} /> {confirm ? 'Leave for sure?' : 'Leave workspace'}
      </button>
    </div>
  )
}
