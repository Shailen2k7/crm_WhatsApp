/**
 * Invite many people at once: paste a list of emails (from a spreadsheet,
 * an email thread, anywhere) or upload a CSV. Taskorra shows exactly what will
 * happen to each row before anything is sent.
 */
import { useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, CircleSlash, Copy, FileUp, Mail, Send, UserCheck } from 'lucide-react'
import Modal from './Modal'
import Select from './Select'
import { InviteModeSwitch, copyText } from './InviteModal'
import { ROLE_LABEL, createInvites, inviteUrl, nameFromEmail, useWorkspace, type BulkResult } from '../lib/workspace'
import type { Member, Invite, Team, WorkspaceRole } from '../types'

const ROLES: WorkspaceRole[] = ['member', 'manager', 'admin']
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const MAX = 200

type RowState = 'new' | 'member' | 'invited' | 'duplicate' | 'bad'
export interface PlanRow {
  line: number
  raw: string
  email: string
  name?: string
  role: WorkspaceRole
  teamId?: string
  state: RowState
}

/** one CSV/TSV line → cells (handles "quoted, cells") */
const cells = (line: string) => {
  const out: string[] = []
  let cur = ''
  let q = false
  for (const ch of line) {
    if (ch === '"') q = !q
    else if (!q && (ch === ',' || ch === '\t' || ch === ';')) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

const asRole = (v: string | undefined): WorkspaceRole | undefined => {
  const r = (v ?? '').trim().toLowerCase()
  return r === 'admin' || r === 'manager' || r === 'member' ? r : undefined
}

/**
 * Pasted text or a CSV → what happens to each person. A header row
 * (name / email / role / team) is understood; otherwise every email
 * address in the text is picked up, with any name written before it.
 */
export const planBulk = (
  text: string,
  defaults: { role: WorkspaceRole; teamId?: string },
  members: Member[],
  invites: Invite[],
  teams: Team[]
): PlanRow[] => {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return []
  const head = cells(lines[0]).map((c) => c.toLowerCase())
  const col = (names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)))
  const hasHeader = !EMAIL.test(lines[0]) && col(['email', 'e-mail', 'mail']) >= 0
  const ci = hasHeader
    ? { email: col(['email', 'e-mail', 'mail']), name: col(['name', 'full name']), role: col(['role']), team: col(['team', 'department']) }
    : null
  const memberEmails = new Set(members.map((m) => m.email.toLowerCase()))
  const invited = new Set(invites.filter((i) => i.status === 'pending').map((i) => i.email.toLowerCase()))
  const teamByName = new Map(teams.map((t) => [t.name.toLowerCase(), t.id]))
  const seen = new Set<string>()
  const rows: PlanRow[] = []

  const push = (line: number, raw: string, emailRaw: string, name?: string, role?: WorkspaceRole, team?: string) => {
    const email = emailRaw.trim().toLowerCase()
    const teamId = (team && teamByName.get(team.trim().toLowerCase())) || defaults.teamId
    const state: RowState = !EMAIL.test(email)
      ? 'bad'
      : memberEmails.has(email)
        ? 'member'
        : invited.has(email)
          ? 'invited'
          : seen.has(email)
            ? 'duplicate'
            : 'new'
    if (EMAIL.test(email)) seen.add(email)
    rows.push({ line, raw, email: email || raw, name: name?.trim() || undefined, role: role ?? defaults.role, teamId, state })
  }

  lines.forEach((l, i) => {
    if (ci && i === 0) return
    if (ci) {
      const c = cells(l)
      push(i + 1, l, c[ci.email] ?? '', ci.name >= 0 ? c[ci.name] : undefined, ci.role >= 0 ? asRole(c[ci.role]) : undefined, ci.team >= 0 ? c[ci.team] : undefined)
      return
    }
    // free text: every address on the line, e.g. "Priya Sharma <priya@x.com>, james@x.com"
    const found = l.match(new RegExp(EMAIL.source, 'g'))
    if (!found) {
      push(i + 1, l, l)
      return
    }
    for (const parts of l.split(/[,;\t]+/)) {
      const e = parts.match(EMAIL)?.[0]
      if (!e) continue
      const name = parts.replace(e, '').replace(/[<>"()]/g, '').trim()
      push(i + 1, l, e, name || undefined)
    }
  })
  return rows.slice(0, MAX)
}

const STATE_LABEL: Record<RowState, string> = {
  new: 'Will be invited',
  member: 'Already in the workspace',
  invited: 'Already invited',
  duplicate: 'Listed twice',
  bad: 'Not an email address'
}

export default function BulkInvite({ onClose, onOne }: { onClose: () => void; onOne: () => void }) {
  const teams = useWorkspace((s) => s.teams)
  const members = useWorkspace((s) => s.members)
  const invites = useWorkspace((s) => s.invites)
  const active = useWorkspace((s) => s.active())
  const [text, setText] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('member')
  const [teamId, setTeamId] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<BulkResult[] | null>(null)
  const [copied, setCopied] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const plan = useMemo(() => planBulk(text, { role, teamId: teamId || undefined }, members, invites, teams), [text, role, teamId, members, invites, teams])
  const fresh = plan.filter((r) => r.state === 'new')
  const skipped = plan.length - fresh.length

  const readFile = async (f: File | undefined) => {
    if (!f) return
    if (f.size > 1_000_000) {
      setError('That file is too big. Keep it under 1 MB (about 10,000 rows).')
      return
    }
    setError(null)
    setText((await f.text()).replace(/^﻿/, ''))
  }

  const send = async () => {
    if (!fresh.length || busy) return
    setBusy(true)
    setError(null)
    setProgress(0)
    try {
      const res = await createInvites(
        fresh.map((r) => ({ email: r.email, name: r.name, role: r.role, teamId: r.teamId })),
        setProgress
      )
      setResults(res)
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  /* ---------- after sending ---------- */
  if (results) {
    const emailed = results.filter((r) => r.emailed).length
    const manual = results.filter((r) => !r.emailed)
    const links = manual.map((r) => `${r.email}  ${r.token ? inviteUrl(r.token) : ''}`).join('\n')
    return (
      <Modal
        title={`${results.length} ${results.length === 1 ? 'person' : 'people'} invited`}
        onClose={onClose}
        footer={
          <button className="btn btn-primary btn-lg" onClick={onClose}>
            Done
          </button>
        }
      >
        <div className="bi-done">
          {emailed > 0 && (
            <div className="info-note">
              <Check size={16} /> {emailed} invite{emailed === 1 ? '' : 's'} emailed. When they sign up with that address they land straight in {active?.name}.
            </div>
          )}
          {manual.length > 0 && (
            <>
              <div className="conflict-note">
                <Mail size={16} />
                {manual[0].reason === 'no_email_provider' || manual[0].reason === 'local'
                  ? ` Automatic emails aren't switched on yet, so send these ${manual.length} link${manual.length === 1 ? '' : 's'} yourself.`
                  : ` ${manual.length} email${manual.length === 1 ? '' : 's'} couldn't be sent just now. Send these links yourself, or press Resend on the Team page later.`}
              </div>
              <textarea className="input bi-links" readOnly rows={Math.min(8, manual.length + 1)} value={links} onFocus={(e) => e.target.select()} />
              <button
                className={`btn ${copied ? 'btn-secondary' : 'btn-primary'}`}
                onClick={async () => {
                  setCopied(await copyText(links))
                  setTimeout(() => setCopied(false), 2000)
                }}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy all links'}
              </button>
            </>
          )}
          <p className="field-hint">You can hand them tasks right away. Each task waits in their list until they join.</p>
        </div>
      </Modal>
    )
  }

  /* ---------- paste + preview ---------- */
  return (
    <Modal
      title="Invite people"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-lg" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-lg" onClick={() => void send()} disabled={busy || !fresh.length}>
            <Send size={16} />
            {busy ? `Inviting ${progress}/${fresh.length}…` : fresh.length ? `Invite ${fresh.length} ${fresh.length === 1 ? 'person' : 'people'}` : 'Invite'}
          </button>
        </>
      }
    >
      <InviteModeSwitch many onChange={(m) => !m && onOne()} />

      <div className="field">
        <div className="bi-label">
          <label htmlFor="bi-text">Emails</label>
          <button className="link-btn" onClick={() => fileRef.current?.click()}>
            <FileUp size={14} /> Upload a CSV
          </button>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" hidden onChange={(e) => void readFile(e.target.files?.[0])} />
        </div>
        <textarea
          id="bi-text"
          className="input bi-text"
          autoFocus
          rows={5}
          placeholder={'Paste emails: one per line, or separated by commas\npriya@company.com, james@company.com\n\nA CSV with name, email, role, team columns works too'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const f = e.dataTransfer.files?.[0]
            if (f) {
              e.preventDefault()
              void readFile(f)
            }
          }}
        />
        <span className="field-hint">Straight from a spreadsheet or an email thread. We pick out the addresses. You can also drop a CSV file here.</span>
      </div>

      <div className="field-row">
        <div className="field">
          <label>Role for everyone</label>
          <Select block ariaLabel="Role" value={role} onChange={(v) => setRole(v as WorkspaceRole)} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
        </div>
        {teams.length > 0 && (
          <div className="field">
            <label>Team (optional)</label>
            <Select block ariaLabel="Team" value={teamId} onChange={setTeamId} options={[{ value: '', label: 'No team yet' }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} />
          </div>
        )}
      </div>

      {plan.length > 0 && (
        <div className="bi-preview">
          <div className="bi-sum">
            <span className="bi-pill new">
              <UserCheck size={13} /> {fresh.length} to invite
            </span>
            {skipped > 0 && (
              <span className="bi-pill skip">
                <CircleSlash size={13} /> {skipped} skipped
              </span>
            )}
            {plan.length >= MAX && <span className="bi-pill skip">First {MAX} rows only</span>}
          </div>
          <div className="bi-rows">
            {plan.map((r, i) => (
              <div key={`${r.line}-${i}`} className={`bi-row ${r.state}`}>
                <span className="bi-av">{r.state === 'bad' ? '!' : (r.name || nameFromEmail(r.email))[0]?.toUpperCase()}</span>
                <span className="bi-who">
                  <b>{r.state === 'bad' ? r.raw : r.name || nameFromEmail(r.email)}</b>
                  {r.state !== 'bad' && <small>{r.email}</small>}
                </span>
                {r.state === 'new' ? (
                  <span className="bi-meta">
                    {ROLE_LABEL[r.role]}
                    {r.teamId && ` · ${teams.find((t) => t.id === r.teamId)?.name ?? ''}`}
                  </span>
                ) : (
                  <span className="bi-meta skip">{STATE_LABEL[r.state]}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="conflict-note">
          <AlertTriangle size={16} /> {error}
        </div>
      )}
    </Modal>
  )
}
