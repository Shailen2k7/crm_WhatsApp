import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatDistanceToNowStrict, format } from 'date-fns'
import { CalendarDays, Check, FileText, GripVertical, Plus, Send, Sparkles, Trash2, X } from 'lucide-react'
import Modal from './Modal'
import Select from './Select'
import { useStore } from '../store/useStore'
import { notifyTask } from '../lib/notify'
import { addComment, deleteComment, fetchComments, initialsOf, useWorkspace } from '../lib/workspace'
import { breakDown } from '../lib/mig'
import { newSubtask, subtaskProgress } from '../lib/tasks'
import { assignFromKey, personKey, personName, personOptions, resolveMention, usePeople } from '../lib/people'
import { fromDateKey, hhmmToMin, minToHHmm, toDateKey } from '../lib/time'
import MicButton from './MicButton'
import VoiceButton from './VoiceButton'
import type { Note, Subtask, Task, TaskComment, TaskPriority, TaskStatus, VoiceFields } from '../types'

const PRIORITIES: { id: TaskPriority; label: string }[] = [
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' }
]

export const STATUSES: { id: TaskStatus; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'done', label: 'Done' }
]

export default function TaskModal() {
  const taskEditor = useStore((s) => s.taskEditor)
  const closeTaskEditor = useStore((s) => s.closeTaskEditor)
  const tasks = useStore((s) => s.tasks)
  const addTask = useStore((s) => s.addTask)
  const updateTask = useStore((s) => s.updateTask)
  const deleteTask = useStore((s) => s.deleteTask)

  // team workspace: who it is for, which team, where it stands
  const wsOn = useWorkspace((s) => s.available)
  const me = useWorkspace((s) => s.me)
  const teams = useWorkspace((s) => s.teams)
  const memberName = useWorkspace((s) => s.memberName)
  const isCompany = useWorkspace((s) => s.workspaces.find((w) => w.id === s.activeId)?.kind === 'company')
  const teamMode = wsOn && isCompany

  const editing = taskEditor && taskEditor !== 'new' ? tasks.find((t) => t.id === taskEditor) : undefined

  const [title, setTitle] = useState(editing?.title ?? '')
  const [notes, setNotes] = useState(editing?.notes ?? '')
  // the task box grows to show the whole task, and re-fits when the popup changes width
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const fitTitle = () => {
    const el = titleRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }
  useLayoutEffect(fitTitle, [title])
  useEffect(() => {
    const el = titleRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let w = el.offsetWidth
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth !== w) {
        w = el.offsetWidth
        fitTitle()
      }
    })
    ro.observe(el)
    const t = setTimeout(fitTitle, 250)
    return () => {
      ro.disconnect()
      clearTimeout(t)
    }
  }, [])
  const [priority, setPriority] = useState<TaskPriority>(editing?.priority ?? 'medium')
  const [dueDate, setDueDate] = useState(editing?.dueDate ?? '')
  const [dueTime, setDueTime] = useState<string>(editing?.dueTime !== undefined ? minToHHmm(editing.dueTime) : '')
  const [status, setStatus] = useState<TaskStatus>(editing?.status ?? (editing?.done ? 'done' : 'todo'))
  const { people, showLoad } = usePeople()
  // a person key: a user id, or "invite:<id>" for someone invited who hasn't joined yet
  const [assignee, setAssignee] = useState(editing ? personKey(editing) : (me ?? ''))
  const [teamId, setTeamId] = useState(editing?.teamId ?? '')
  const [subtasks, setSubtasks] = useState<Subtask[]>(editing?.subtasks ?? [])
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  /** put fields understood from voice into the form */
  const applyVoice = (f: VoiceFields) => {
    if (f.title?.trim()) setTitle(f.title.trim())
    if (f.priority === 'high' || f.priority === 'medium' || f.priority === 'low') setPriority(f.priority)
    if (f.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(f.dueDate)) setDueDate(f.dueDate)
    if (f.time && /^\d{2}:\d{2}$/.test(f.time)) setDueTime(f.time)
    if (f.notes?.trim()) setNotes(f.notes.trim())
  }
  useEffect(() => {
    const pre = useStore.getState().voicePrefill
    if (!editing && pre?.type === 'create_task') {
      applyVoice(pre)
      useStore.getState().setVoicePrefill(null)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // steps edited while the popup is open save straight away when editing
  const persistSubtasks = (list: Subtask[]) => {
    setSubtasks(list)
    if (editing) updateTask(editing.id, { subtasks: list })
  }

  const save = () => {
    if (!title.trim()) return
    // "@Priya" typed in the task picks her and comes out of the title
    const mention = teamMode ? resolveMention(people, title) : null
    const finalTitle = mention?.text || title.trim()
    const who = mention?.key ?? assignee
    const teamFields = teamMode ? { ...assignFromKey(who), teamId: teamId || undefined, status } : { status }
    const when = { dueDate: dueDate || undefined, dueTime: dueDate && dueTime ? hhmmToMin(dueTime) : undefined }
    if (editing) {
      updateTask(editing.id, {
        title: finalTitle,
        notes: notes.trim() || undefined,
        priority,
        subtasks,
        ...when,
        ...teamFields
      })
      const updated = useStore.getState().tasks.find((x) => x.id === editing.id)
      if (updated) notifyTask('updated', updated)
    } else {
      const t: Task = {
        id: crypto.randomUUID(),
        title: finalTitle,
        notes: notes.trim() || undefined,
        priority,
        done: status === 'done',
        subtasks: subtasks.length ? subtasks : undefined,
        createdAt: Date.now(),
        ...when,
        ...teamFields
      }
      addTask(t)
      notifyTask('created', t)
    }
    closeTaskEditor()
  }

  const assigneeOptions = personOptions(people, showLoad)
  // steps go to people who have joined (a step's person is a label only)
  const stepOptions = personOptions(people.filter((p) => !p.invited), false, false)
  const someoneElse = teamMode && assignee && assignee !== me

  return (
    <Modal
      title={editing ? 'Edit Task' : 'New Task'}
      onClose={closeTaskEditor}
      footer={
        <>
          {editing && (
            <button
              className="btn btn-danger"
              style={{ flex: '0 0 auto' }}
              onClick={() => {
                if (confirmingDelete) {
                  notifyTask('deleted', editing)
                  deleteTask(editing.id)
                  closeTaskEditor()
                } else setConfirmingDelete(true)
              }}
            >
              <Trash2 size={16} />
              {confirmingDelete && (subtasks.length ? `Delete with ${subtasks.length} steps?` : 'Delete?')}
            </button>
          )}
          <button className="btn btn-secondary btn-lg" onClick={closeTaskEditor}>
            Cancel
          </button>
          <button className="btn btn-primary btn-lg" onClick={save} disabled={!title.trim()}>
            {editing ? 'Save Task' : someoneElse ? 'Assign Task' : 'Add Task'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Task</label>
        <div className="mic-field">
          <textarea
            className="input input-grow"
            rows={1}
            autoFocus
            placeholder={teamMode ? 'Type the task. Add @name to assign it' : 'Type, or tap the mic and say it'}
            value={title}
            onChange={(e) => {
              const v = e.target.value.replace(/\n/g, ' ')
              setTitle(v)
              const m = teamMode && v.includes('@') ? resolveMention(people, v) : null
              if (m) setAssignee(m.key)
            }}
            title={title || undefined}
            ref={titleRef}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                save()
              }
            }}
          />
          <VoiceButton mode="task" onFill={applyVoice} label="Say the task" />
        </div>
      </div>

      {teamMode && (
        <div className="field-row">
          <div className="field">
            <label>Assign to</label>
            <Select block ariaLabel="Assign to" value={assignee} onChange={setAssignee} options={assigneeOptions} searchable={people.length > 8} />
          </div>
          {teams.length > 0 && (
            <div className="field">
              <label>Team</label>
              <Select block ariaLabel="Team" value={teamId} onChange={setTeamId} options={[{ value: '', label: 'No team' }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} />
            </div>
          )}
        </div>
      )}

      <div className="field-row">
        <div className="field">
          <label>Status</label>
          <div className="chip-row">
            {STATUSES.map((s) => (
              <button key={s.id} className={`chip status-chip st-${s.id}${status === s.id ? ' active' : ''}`} onClick={() => setStatus(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Priority</label>
          <div className="chip-row">
            {PRIORITIES.map((p) => (
              <button key={p.id} className={`chip prio-chip prio-${p.id}${priority === p.id ? ' active' : ''}`} onClick={() => setPriority(p.id)}>
                <span className={`prio-dot prio-${p.id}`} />
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="field">
        <label>Due (optional)</label>
        <div className="tm-due">
          <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="Due date" />
          {dueDate && <input className="input tm-time" type="time" step={300} value={dueTime} onChange={(e) => setDueTime(e.target.value)} aria-label="Due time" />}
          {dueDate && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                setDueDate('')
                setDueTime('')
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <SubtaskEditor
        title={title}
        notes={notes}
        list={subtasks}
        onChange={persistSubtasks}
        teamMode={teamMode}
        assigneeOptions={stepOptions}
        memberName={memberName}
        onAllDone={() => {
          if (status !== 'done') setStatus('done')
        }}
      />

      <div className="field">
        <label>Details (optional)</label>
        <div className="mic-field area">
          <textarea className="input" placeholder="Details, links, context…" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <MicButton value={notes} onChange={setNotes} label="Dictate details" />
        </div>
      </div>

      {editing && <AttachedPages task={editing} onClose={closeTaskEditor} />}

      {editing && teamMode && editing.assignedInvite && (
        <p className="task-by">
          Waiting for <b>{personName(people, personKey(editing))}</b> to join. It moves to their list the moment they accept the invite.
        </p>
      )}
      {editing && teamMode && editing.assignedBy && editing.assignedTo && editing.assignedBy !== editing.assignedTo && (
        <p className="task-by">
          Assigned to <b>{memberName(editing.assignedTo)}</b> by <b>{memberName(editing.assignedBy)}</b>
        </p>
      )}

      {editing && teamMode && <Comments taskId={editing.id} />}
    </Modal>
  )
}

/* ================= steps (subtasks) ================= */

function SubtaskEditor({
  title,
  notes,
  list,
  onChange,
  teamMode,
  assigneeOptions,
  memberName,
  onAllDone
}: {
  title: string
  notes: string
  list: Subtask[]
  onChange: (list: Subtask[]) => void
  teamMode: boolean
  assigneeOptions: { value: string; label: string }[]
  memberName: (id: string) => string
  onAllDone: () => void
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [suggest, setSuggest] = useState<{ steps: string[]; picked: boolean[]; ai: boolean } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const addRef = useRef<HTMLInputElement>(null)
  const todayKey = toDateKey(new Date())
  const progress = subtaskProgress({ subtasks: list })

  const add = () => {
    const t = draft.trim()
    if (!t) return
    onChange([...list, newSubtask(t)])
    setDraft('')
    addRef.current?.focus()
  }

  const patch = (id: string, p: Partial<Subtask>) => {
    const next = list.map((s) => (s.id === id ? { ...s, ...p } : s))
    onChange(next)
    if ('done' in p && next.length && next.every((s) => s.done)) onAllDone()
  }
  const remove = (id: string) => onChange(list.filter((s) => s.id !== id))

  const move = (from: string, to: string) => {
    if (from === to) return
    const a = list.findIndex((s) => s.id === from)
    const b = list.findIndex((s) => s.id === to)
    if (a < 0 || b < 0) return
    const next = [...list]
    const [item] = next.splice(a, 1)
    next.splice(b, 0, item)
    onChange(next)
  }

  const askMig = async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    const r = await breakDown(title, notes)
    const fresh = r.steps.filter((s) => !list.some((x) => x.title.toLowerCase() === s.toLowerCase()))
    setSuggest({ steps: fresh, picked: fresh.map(() => true), ai: r.ai })
    setBusy(false)
  }
  const acceptSuggest = () => {
    if (!suggest) return
    onChange([...list, ...suggest.steps.filter((_, i) => suggest.picked[i]).map((s) => newSubtask(s))])
    setSuggest(null)
  }
  const pickedCount = suggest ? suggest.picked.filter(Boolean).length : 0

  return (
    <div className="field st-field">
      <label className="st-label">
        <span>
          Steps
          {progress.total > 0 && (
            <span className="st-count">
              {progress.done}/{progress.total}
            </span>
          )}
        </span>
        <button type="button" className="st-mig" onClick={askMig} disabled={!title.trim() || busy} title="Mig suggests the steps">
          <Sparkles size={13} />
          {busy ? 'Thinking…' : 'Break it down'}
        </button>
      </label>

      {progress.total > 0 && (
        <div className="st-bar" aria-hidden>
          <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
        </div>
      )}

      {list.length > 0 && (
        <ul className="st-list">
          {list.map((s) => (
            <li
              key={s.id}
              className={`st-item${s.done ? ' done' : ''}${overId === s.id && dragId !== s.id ? ' over' : ''}${dragId === s.id ? ' dragging' : ''}`}
              draggable
              onDragStart={(e) => {
                setDragId(s.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                e.preventDefault()
                if (overId !== s.id) setOverId(s.id)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId) move(dragId, s.id)
                setDragId(null)
                setOverId(null)
              }}
              onDragEnd={() => {
                setDragId(null)
                setOverId(null)
              }}
            >
              <span className="st-grip" aria-hidden>
                <GripVertical size={14} />
              </span>
              <button type="button" className={`td-check sm${s.done ? ' on' : ''}`} onClick={() => patch(s.id, { done: !s.done })} aria-label={s.done ? 'Mark step not done' : 'Mark step done'}>
                <Check size={12} strokeWidth={3.2} />
              </button>
              <input
                className="st-title"
                value={s.title}
                onChange={(e) => patch(s.id, { title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addRef.current?.focus()
                  }
                  if (e.key === 'Backspace' && !s.title) {
                    e.preventDefault()
                    remove(s.id)
                  }
                }}
                aria-label="Step"
              />
              <span className="st-meta">
                {s.dueDate && (
                  <span className={`td-chip${!s.done && s.dueDate < todayKey ? ' red' : ''}`}>
                    <CalendarDays size={11} />
                    {format(fromDateKey(s.dueDate), 'd MMM')}
                  </span>
                )}
                {teamMode && s.assignedTo && <span className="td-chip">{memberName(s.assignedTo)}</span>}
                <button type="button" className={`st-more${openId === s.id ? ' on' : ''}`} onClick={() => setOpenId(openId === s.id ? null : s.id)} aria-label="Step options">
                  …
                </button>
                <button type="button" className="st-x" onClick={() => remove(s.id)} aria-label="Remove step">
                  <X size={13} />
                </button>
              </span>
              {openId === s.id && (
                <div className="st-opts">
                  <label>
                    <CalendarDays size={13} /> Due
                    <input type="date" className="input st-date" value={s.dueDate ?? ''} onChange={(e) => patch(s.id, { dueDate: e.target.value || undefined })} />
                  </label>
                  {teamMode && (
                    <label>
                      Who
                      <Select ariaLabel="Who does this step" value={s.assignedTo ?? ''} onChange={(v) => patch(s.id, { assignedTo: v || undefined })} options={[{ value: '', label: 'Anyone' }, ...assigneeOptions]} />
                    </label>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="st-add">
        <Plus size={15} />
        <input
          ref={addRef}
          placeholder={list.length ? 'Add another step' : 'Add a step, then press Enter'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          aria-label="New step"
        />
        {draft.trim() && (
          <button type="button" className="st-add-btn" onClick={add}>
            Add
          </button>
        )}
      </div>

      {suggest && (
        <div className="st-suggest">
          <div className="st-suggest-head">
            <Sparkles size={14} />
            <b>{suggest.ai ? 'Mig suggests these steps' : 'Suggested steps'}</b>
            <button type="button" className="btn-icon" onClick={() => setSuggest(null)} aria-label="Dismiss suggestions">
              <X size={15} />
            </button>
          </div>
          {suggest.steps.length === 0 ? (
            <p className="st-suggest-empty">All the suggested steps are already in the list.</p>
          ) : (
            <>
              {suggest.steps.map((s, i) => (
                <label key={i} className={`st-suggest-item${suggest.picked[i] ? ' on' : ''}`}>
                  <input type="checkbox" checked={suggest.picked[i]} onChange={() => setSuggest({ ...suggest, picked: suggest.picked.map((p, j) => (j === i ? !p : p)) })} />
                  <span>{s}</span>
                </label>
              ))}
              <div className="st-suggest-foot">
                <button type="button" className="btn btn-primary" onClick={acceptSuggest} disabled={pickedCount === 0}>
                  Add {pickedCount} step{pickedCount === 1 ? '' : 's'}
                </button>
                <span className="tdd-muted">Untick any you don't want.</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* ================= pages attached to this task ================= */

function AttachedPages({ task, onClose }: { task: Task; onClose: () => void }) {
  const notes = useStore((s) => s.notes)
  const addNote = useStore((s) => s.addNote)
  const updateNote = useStore((s) => s.updateNote)
  const setView = useStore((s) => s.setView)
  const me = useWorkspace((s) => s.me)
  const activeId = useWorkspace((s) => s.activeId)
  const inCompany = useWorkspace((s) => s.available && !!s.activeId && s.workspaces.find((w) => w.id === s.activeId)?.kind === 'company')
  const [picking, setPicking] = useState(false)

  const attached = useMemo(() => notes.filter((n) => n.taskId === task.id), [notes, task.id])
  const candidates = useMemo(
    () =>
      notes
        .filter((n) => !n.taskId && !n.meetingId && (inCompany ? n.companyId === activeId && (n.shared || n.createdBy === me) : !n.companyId))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 12),
    [notes, inCompany, activeId, me]
  )

  const openPage = (id: string) => {
    onClose()
    setView('notes')
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('msos:note-open', { detail: { id } })), 60)
  }

  const createPage = () => {
    const now = Date.now()
    const n: Note = {
      id: crypto.randomUUID(),
      title: task.title.slice(0, 120),
      icon: '✅',
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      plain: '',
      taskId: task.id,
      shared: inCompany && !!task.companyId,
      createdAt: now,
      updatedAt: now
    }
    addNote(n)
    openPage(n.id)
  }

  return (
    <div className="field tm-pages">
      <label className="st-label">
        <span>
          Pages
          {attached.length > 0 && <span className="st-count">{attached.length}</span>}
        </span>
        <span className="tm-pages-actions">
          {candidates.length > 0 && (
            <button type="button" className="st-mig" onClick={() => setPicking((v) => !v)}>
              Attach existing
            </button>
          )}
          <button type="button" className="st-mig" onClick={createPage}>
            <Plus size={13} /> New page
          </button>
        </span>
      </label>
      {attached.length === 0 && !picking && <p className="tm-pages-hint">A brief, a checklist, meeting prep — keep a page with this task.</p>}
      {attached.length > 0 && (
        <div className="tm-page-list">
          {attached.map((n) => (
            <div key={n.id} className="tm-page" role="button" tabIndex={0} onClick={() => openPage(n.id)} onKeyDown={(e) => e.key === 'Enter' && openPage(n.id)}>
              <span className="tm-page-ico">{n.icon ?? <FileText size={15} />}</span>
              <span className="tm-page-title">{n.title || 'Untitled'}</span>
              {n.shared && <span className="nt-pill team">Team</span>}
              <button
                type="button"
                className="tm-page-x"
                onClick={(e) => {
                  e.stopPropagation()
                  updateNote(n.id, { taskId: undefined })
                }}
                aria-label="Detach page"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {picking && (
        <div className="tm-page-pick">
          {candidates.map((n) => (
            <button
              type="button"
              key={n.id}
              className="tm-page"
              onClick={() => {
                updateNote(n.id, { taskId: task.id })
                setPicking(false)
              }}
            >
              <span className="tm-page-ico">{n.icon ?? <FileText size={15} />}</span>
              <span className="tm-page-title">{n.title || 'Untitled'}</span>
              <span className="tdd-muted">{formatDistanceToNowStrict(n.updatedAt, { addSuffix: true })}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ================= comments ================= */

function Comments({ taskId }: { taskId: string }) {
  const me = useWorkspace((s) => s.me)
  const memberName = useWorkspace((s) => s.memberName)
  const member = useWorkspace((s) => s.member)
  const [list, setList] = useState<TaskComment[] | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void fetchComments(taskId).then((c) => alive && setList(c))
    return () => {
      alive = false
    }
  }, [taskId])

  const post = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    const c = await addComment(taskId, text)
    if (c) {
      setList((l) => [...(l ?? []), c])
      setText('')
    }
    setBusy(false)
  }

  const remove = (id: string) => {
    setList((l) => (l ?? []).filter((c) => c.id !== id))
    void deleteComment(id)
  }

  return (
    <div className="cmt">
      <label className="cmt-title">Comments {list && list.length > 0 && <span>{list.length}</span>}</label>
      <div className="cmt-list">
        {list === null && <span className="tdd-muted">Loading…</span>}
        {list?.length === 0 && <span className="tdd-muted">No comments yet.</span>}
        {list?.map((c) => {
          const m = member(c.userId)
          return (
            <div key={c.id} className={`cmt-item${c.userId === me ? ' mine' : ''}`}>
              <span className="user-avatar">{c.userId === me ? 'Me' : initialsOf(m?.name ?? '', m?.email ?? '')}</span>
              <div className="cmt-bubble">
                <div className="cmt-meta">
                  <b>{memberName(c.userId)}</b>
                  <small>{formatDistanceToNowStrict(c.createdAt, { addSuffix: true })}</small>
                  {c.userId === me && (
                    <button onClick={() => remove(c.id)} aria-label="Delete comment" title="Delete">
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                <p>{c.body}</p>
              </div>
            </div>
          )
        })}
      </div>
      <div className="cmt-add">
        <input
          className="input"
          placeholder="Write a comment…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void post()
            }
          }}
          maxLength={1000}
        />
        <button className="btn btn-primary btn-icon" onClick={() => void post()} disabled={!text.trim() || busy} aria-label="Post comment">
          <Send size={15} />
        </button>
      </div>
    </div>
  )
}
