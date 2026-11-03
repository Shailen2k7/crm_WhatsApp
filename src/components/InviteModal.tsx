import { useState } from 'react'
import { AlertTriangle, Check, Copy, Mail, Send, User, Users } from 'lucide-react'
import Modal from './Modal'
import Select from './Select'
import BulkInvite from './BulkInvite'
import { ROLE_HELP, ROLE_LABEL, createInvite, emailInvite, inviteUrl, useWorkspace } from '../lib/workspace'
import type { Invite, WorkspaceRole } from '../types'

const ROLES: WorkspaceRole[] = ['member', 'manager', 'admin']

export const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Admin: invite one person by email; the invite is emailed to them. */
export default function InviteModal({ onClose, many = false }: { onClose: () => void; many?: boolean }) {
  const [bulk, setBulk] = useState(many)
  if (bulk) return <BulkInvite onClose={onClose} onOne={() => setBulk(false)} />
  return <OneInvite onClose={onClose} onMany={() => setBulk(true)} />
}

/** one person, or many at once */
export function InviteModeSwitch({ many, onChange }: { many: boolean; onChange: (many: boolean) => void }) {
  return (
    <div className="segmented inv-mode" role="tablist">
      <button role="tab" aria-selected={!many} className={!many ? 'active' : ''} onClick={() => onChange(false)}>
        <User size={14} /> One person
      </button>
      <button role="tab" aria-selected={many} className={many ? 'active' : ''} onClick={() => onChange(true)}>
        <Users size={14} /> Many people
      </button>
    </div>
  )
}

function OneInvite({ onClose, onMany }: { onClose: () => void; onMany: () => void }) {
  const teams = useWorkspace((s) => s.teams)
  const active = useWorkspace((s) => s.active())
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('member')
  const [teamId, setTeamId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<Invite | null>(null)
  // why the email didn't go out, when it didn't
  const [sent, setSent] = useState<{ ok: boolean; reason?: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const [touched, setTouched] = useState(false)

  const create = async () => {
    setTouched(true)
    if (busy || !valid) return
    setBusy(true)
    setError(null)
    try {
      const inv = await createInvite({ email: email.trim(), role, teamId: teamId || undefined })
      const r = await emailInvite(inv.token)
      setSent({ ok: r.sent, reason: r.reason })
      setMade(inv)
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  const link = made ? inviteUrl(made.token) : ''
  const mailto = made
    ? `mailto:${made.email}?subject=${encodeURIComponent(`Join ${active?.name ?? 'our workspace'} on Taskorra`)}&body=${encodeURIComponent(
        `Hi,\n\nI've invited you to join ${active?.name ?? 'our workspace'} on Taskorra. Open this link to accept:\n${link}\n\nSee you there!`
      )}`
    : ''

  return (
    <Modal
      title={made ? (sent?.ok ? 'Invite sent' : 'Invite created') : 'Invite people'}
      onClose={onClose}
      footer={
        made ? (
          <>
            <button
              className="btn btn-secondary btn-lg"
              onClick={() => {
                setMade(null)
                setSent(null)
                setEmail('')
                setTouched(false)
                setCopied(false)
              }}
            >
              Invite another
            </button>
            <button className="btn btn-primary btn-lg" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-secondary btn-lg" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary btn-lg" onClick={create} disabled={busy}>
              <Send size={16} />
              {busy ? 'Sending…' : 'Send invite'}
            </button>
          </>
        )
      }
    >
      {made ? (
        <div className="inv-done">
          {sent?.ok ? (
            <div className="info-note">
              <Check size={16} /> Invite emailed to {made.email}. When they sign up with that address they land straight in {active?.name}.
            </div>
          ) : (
            <div className="conflict-note">
              <Mail size={16} />
              {sent?.reason === 'no_email_provider'
                ? ` Automatic emails aren't switched on yet, so send ${made.email} this link yourself. When they sign up with that email they join ${active?.name}.`
                : ` The email to ${made.email} couldn't be sent just now. Send them this link instead, or press Resend on the Team page later.`}
            </div>
          )}
          <div className="inv-link">
            <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button
              className={`btn ${copied ? 'btn-secondary' : 'btn-primary'}`}
              onClick={async () => {
                setCopied(await copyText(link))
                setTimeout(() => setCopied(false), 2000)
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {!sent?.ok && (
            <a className="btn btn-secondary" href={mailto}>
              <Send size={15} /> Open in your email app
            </a>
          )}
        </div>
      ) : (
        <>
          <InviteModeSwitch many={false} onChange={(m) => m && onMany()} />
          <div className="field">
            <label>Email</label>
            <input
              className="input"
              type="email"
              autoFocus
              required
              autoComplete="off"
              placeholder="person@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => email.trim() && setTouched(true)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            {touched && !valid ? (
              <span className="field-hint red">{email.trim() ? "That doesn't look like an email address." : 'Enter the email address of the person you are inviting.'}</span>
            ) : (
              <span className="field-hint">We email them a link to join. They sign up with this address.</span>
            )}
          </div>
          <div className="field">
            <label>Role</label>
            <div className="role-pick">
              {ROLES.map((r) => (
                <button key={r} className={`role-opt${role === r ? ' on' : ''}`} onClick={() => setRole(r)}>
                  <b>{ROLE_LABEL[r]}</b>
                  <span>{ROLE_HELP[r]}</span>
                </button>
              ))}
            </div>
          </div>
          {teams.length > 0 && (
            <div className="field">
              <label>Team (optional)</label>
              <Select block ariaLabel="Team" value={teamId} onChange={setTeamId} options={[{ value: '', label: 'No team yet' }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} />
            </div>
          )}
          {error && (
            <div className="conflict-note">
              <AlertTriangle size={16} /> {error}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
