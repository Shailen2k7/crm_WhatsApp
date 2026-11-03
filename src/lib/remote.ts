import { isSupabaseEnabled, supabase } from './supabase'
import type { AiNotes, AvailabilityWindow, BlockedTime, JournalEntry, Meeting, Note, NoteDoc, ReminderItem, Settings, Task } from '../types'

/**
 * Write-through persistence to Supabase (cloud mode).
 * The zustand store stays the single source of truth for the UI; every
 * mutation calls one of these fire-and-forget writers. All tables carry
 * `user_id default auth.uid()` + RLS policies, so no user id is passed here.
 *
 * `active` is flipped by the auth layer on sign-in/sign-out so local mode and
 * the signed-out state are clean no-ops.
 */

let active = false
let syncUser: string | null = null
export const setRemoteActive = (v: boolean, userId: string | null = null) => {
  active = v && isSupabaseEnabled
  syncUser = active ? userId : null
  settingsLoaded = false
  outbox = syncUser ? loadOutbox(syncUser) : []
  if (active) void flushOutbox()
}
const on = () => active

/* ---------- outbox: every change is kept until the cloud has it ----------
 * Writes go out in order, one at a time. A write that fails because the
 * connection dropped stays queued (also across app restarts) and is retried
 * when the device is back online, every 20 s, and before each refresh — so a
 * change made on a train is never lost, and the refresh never replaces local
 * changes the cloud hasn't seen yet.
 */
type Op = {
  table: string
  kind: 'insert' | 'update' | 'delete' | 'upsert'
  id?: string
  row?: Record<string, unknown>
  label: string
  /** failed tries while the device was online */
  tries?: number
}
type DbResult = { error: { message: string; code?: string } | null; status: number }

let outbox: Op[] = []
/** bumped on every local change, so a refresh can tell if one happened meanwhile */
let writeCount = 0
let flushing: Promise<void> | null = null
let again = false
let retryTimer: ReturnType<typeof setTimeout> | null = null
let storeWarned = false

// key name kept from before the rename so changes waiting on a device aren't stranded
const outboxKey = (uid: string) => `actora-outbox-${uid}`
const loadOutbox = (uid: string): Op[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(outboxKey(uid)) ?? '[]')
    return Array.isArray(raw) ? (raw as Op[]) : []
  } catch {
    return []
  }
}
const saveOutbox = () => {
  if (!syncUser) return
  try {
    if (outbox.length) localStorage.setItem(outboxKey(syncUser), JSON.stringify(outbox))
    else localStorage.removeItem(outboxKey(syncUser))
  } catch {
    // device storage full (e.g. a journal entry with big photos): still retried while the app is open
    if (!storeWarned) console.warn('[sync] pending changes kept in memory only (device storage is full)')
    storeWarned = true
  }
}

const exec = (op: Op): PromiseLike<DbResult> => {
  const q = supabase.from(op.table)
  if (op.kind === 'insert') return q.insert(op.row ?? {})
  if (op.kind === 'upsert') return q.upsert(op.row ?? {})
  if (op.kind === 'update') return q.update(op.row ?? {}).eq('id', op.id ?? '')
  return q.delete().eq('id', op.id ?? '')
}

/** worth retrying: offline, server busy or the sign-in token being refreshed */
const isTransient = (res: DbResult) =>
  (typeof navigator !== 'undefined' && navigator.onLine === false) ||
  res.status === 0 ||
  res.status === 401 ||
  res.status === 408 ||
  res.status === 429 ||
  res.status >= 500 ||
  res.error?.code === 'PGRST301' ||
  /fetch|network|load failed|timed? ?out/i.test(res.error?.message ?? '')

const retryLater = () => {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flushOutbox()
  }, 20_000)
}

/** 'retry' when the network failed and the rest waits for the next try */
const drain = async (): Promise<'done' | 'retry'> => {
  while (active && outbox.length) {
    const op = outbox[0]
    let res: DbResult
    try {
      res = await exec(op)
    } catch (e) {
      res = { error: { message: String(e) }, status: 0 }
    }
    // an insert that reached the server before the connection dropped is already there
    const duplicate = op.kind === 'insert' && res.error?.code === '23505'
    if (res.error && !duplicate) {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      if (!offline) op.tries = (op.tries ?? 0) + 1
      // online but failing for ~10 minutes: give up on this one so the rest can go
      if (isTransient(res) && (op.tries ?? 0) < 30) {
        saveOutbox()
        retryLater()
        return 'retry'
      }
      console.error(`[sync] ${op.label} failed:`, res.error.message)
    }
    if (outbox[0] === op) outbox.shift()
    saveOutbox()
  }
  return 'done'
}

/** sends everything waiting, in order; resolves when done or when the network gives up */
export const flushOutbox = (): Promise<void> => {
  if (!active) return Promise.resolve()
  if (flushing) {
    // a send is finishing: make sure it picks up what just arrived
    again = true
    return flushing
  }
  flushing = (async () => {
    do {
      again = false
      if ((await drain()) === 'retry') break
    } while (again)
  })().finally(() => (flushing = null))
  return flushing
}

/** true while some change hasn't reached the cloud yet */
export const hasPendingWrites = () => outbox.length > 0

const enqueue = (op: Op) => {
  if (!on()) return
  outbox.push(op)
  writeCount++
  saveOutbox()
  void flushOutbox()
}

if (typeof window !== 'undefined') window.addEventListener('online', () => void flushOutbox())

/* settings are written whole, so never before this device has seen the cloud's
   copy — otherwise a brand-new phone would overwrite them with defaults */
let settingsLoaded = false

/* ---------- row mappers ---------- */

type MeetingRow = {
  id: string
  title: string
  person_name: string
  person_email: string | null
  date: string
  start_min: number
  duration_min: number
  type: string
  notes: string | null
  meet_link: string | null
  reminder_min: number | null
  reminders_fired: string[]
  push_fired: boolean
  transcript: string | null
  ai_notes: AiNotes | null
  source?: string | null
  external_id?: string | null
  created_at: string
}

const meetingToRow = (m: Meeting) => ({
  id: m.id,
  title: m.title,
  person_name: m.personName,
  person_email: m.personEmail ?? null,
  date: m.date,
  start_min: m.startMin,
  duration_min: m.durationMin,
  type: m.type,
  notes: m.notes ?? null,
  meet_link: m.meetLink ?? null,
  reminder_min: m.reminderMin,
  reminders_fired: m.remindersFired ?? [],
  push_fired: m.pushFired ?? false,
  transcript: m.transcript ?? null,
  ai_notes: m.aiNotes ?? null,
  // only sent for CRM meetings, so normal saves work even before the database update
  ...(m.source ? { source: m.source, external_id: m.externalId ?? null } : {}),
  created_at: new Date(m.createdAt).toISOString()
})

const rowToMeeting = (r: MeetingRow): Meeting => ({
  id: r.id,
  title: r.title,
  personName: r.person_name,
  personEmail: r.person_email ?? undefined,
  date: r.date,
  startMin: r.start_min,
  durationMin: r.duration_min,
  type: r.type as Meeting['type'],
  notes: r.notes ?? undefined,
  meetLink: r.meet_link ?? undefined,
  reminderMin: r.reminder_min as Meeting['reminderMin'],
  remindersFired: r.reminders_fired ?? [],
  pushFired: r.push_fired ?? false,
  transcript: r.transcript ?? undefined,
  aiNotes: r.ai_notes ?? undefined,
  source: r.source ?? undefined,
  externalId: r.external_id ?? undefined,
  createdAt: Date.parse(r.created_at)
})

const MEETING_PATCH_MAP: Record<string, string> = {
  title: 'title',
  personName: 'person_name',
  personEmail: 'person_email',
  date: 'date',
  startMin: 'start_min',
  durationMin: 'duration_min',
  type: 'type',
  notes: 'notes',
  meetLink: 'meet_link',
  reminderMin: 'reminder_min',
  remindersFired: 'reminders_fired',
  pushFired: 'push_fired',
  pushSent: 'push_sent',
  transcript: 'transcript',
  aiNotes: 'ai_notes'
}

const mapPatch = (patch: Record<string, unknown>, map: Record<string, string>) => {
  const row: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    const col = map[k]
    if (col) row[col] = v === undefined ? null : v
  }
  return row
}

type BlockedRow = { id: string; date: string; start_min: number; end_min: number; label: string | null
  task_id?: string | null
}

const blockedToRow = (b: BlockedTime) => ({
  id: b.id,
  date: b.date,
  start_min: b.startMin,
  end_min: b.endMin,
  label: b.label ?? null,
  // only once set, so plain blocks save even before the database update
  ...(b.taskId ? { task_id: b.taskId } : {})
})

const rowToBlocked = (r: BlockedRow): BlockedTime => ({
  id: r.id,
  date: r.date,
  startMin: r.start_min,
  endMin: r.end_min,
  label: r.label ?? undefined,
  taskId: r.task_id ?? undefined
})

const BLOCKED_PATCH_MAP: Record<string, string> = {
  date: 'date',
  startMin: 'start_min',
  endMin: 'end_min',
  label: 'label',
  taskId: 'task_id'
}

type AvailRow = { id: string; day: number; start_min: number; end_min: number }

const availToRow = (w: AvailabilityWindow) => ({
  id: w.id,
  day: w.day,
  start_min: w.startMin,
  end_min: w.endMin
})

const rowToAvail = (r: AvailRow): AvailabilityWindow => ({
  id: r.id,
  day: r.day,
  startMin: r.start_min,
  endMin: r.end_min
})

type TaskRow = {
  id: string
  title: string
  notes: string | null
  priority: string
  done: boolean
  due_date: string | null
  created_at: string
  completed_at: string | null
  user_id?: string
  company_id?: string | null
  assigned_to?: string | null
  assigned_by?: string | null
  team_id?: string | null
  status?: string | null
  due_min?: number | null
  subtasks?: unknown
  assigned_invite?: string | null
}

const taskToRow = (t: Task) => ({
  id: t.id,
  title: t.title,
  notes: t.notes ?? null,
  priority: t.priority,
  done: t.done,
  due_date: t.dueDate ?? null,
  // newer columns go up only once they are used, so plain saves never break
  ...(t.dueTime !== undefined ? { due_min: t.dueTime } : {}),
  ...(t.subtasks?.length ? { subtasks: t.subtasks } : {}),
  // team columns go up only once the task has a workspace (i.e. the team
  // database update has been run), so plain saves never break
  ...(t.companyId
    ? {
        company_id: t.companyId,
        assigned_to: t.assignedTo ?? null,
        // invited-person column only once used, so saves work before the database update
        ...(t.assignedInvite ? { assigned_invite: t.assignedInvite } : {}),
        team_id: t.teamId ?? null,
        status: t.status ?? (t.done ? 'done' : 'todo')
      }
    : {}),
  created_at: new Date(t.createdAt).toISOString(),
  completed_at: t.completedAt ? new Date(t.completedAt).toISOString() : null
})

const rowToTask = (r: TaskRow): Task => ({
  id: r.id,
  title: r.title,
  notes: r.notes ?? undefined,
  priority: (r.priority as Task['priority']) || 'medium',
  done: r.done,
  dueDate: r.due_date ?? undefined,
  dueTime: typeof r.due_min === 'number' ? r.due_min : undefined,
  subtasks: Array.isArray(r.subtasks) ? (r.subtasks as Task['subtasks']) : undefined,
  createdAt: Date.parse(r.created_at),
  completedAt: r.completed_at ? Date.parse(r.completed_at) : undefined,
  createdBy: r.user_id ?? undefined,
  companyId: r.company_id ?? undefined,
  assignedTo: r.assigned_to ?? undefined,
  assignedBy: r.assigned_by ?? undefined,
  assignedInvite: r.assigned_invite ?? undefined,
  teamId: r.team_id ?? undefined,
  status: (r.status as Task['status']) ?? (r.done ? 'done' : 'todo')
})

const TASK_PATCH_MAP: Record<string, string> = {
  title: 'title',
  notes: 'notes',
  priority: 'priority',
  done: 'done',
  dueDate: 'due_date',
  dueTime: 'due_min',
  subtasks: 'subtasks',
  completedAt: 'completed_at',
  assignedTo: 'assigned_to',
  assignedInvite: 'assigned_invite',
  teamId: 'team_id',
  status: 'status'
}

type ReminderRow = {
  id: string
  title: string
  notes: string | null
  date: string
  at_min: number
  fired: boolean
  repeat?: string | null
  repeat_days?: number[] | null
  interval_min?: number | null
  until_min?: number | null
  last_fired_at?: number | null
  alarm_ack_at?: number | null
  created_at: string
}

const reminderToRow = (r: ReminderItem) => ({
  id: r.id,
  title: r.title,
  notes: r.notes ?? null,
  date: r.date,
  at_min: r.atMin,
  fired: r.fired,
  // repeat columns are sent only for repeating reminders, so one-time reminders
  // keep saving even if the database update hasn't been run yet
  ...(r.repeat && r.repeat !== 'none'
    ? {
        repeat: r.repeat,
        repeat_days: r.repeatDays ?? null,
        interval_min: r.intervalMin ?? null,
        until_min: r.untilMin ?? null,
        last_fired_at: r.lastFiredAt ?? null
      }
    : {}),
  created_at: new Date(r.createdAt).toISOString()
})

const rowToReminder = (r: ReminderRow): ReminderItem => ({
  id: r.id,
  title: r.title,
  notes: r.notes ?? undefined,
  date: r.date,
  atMin: r.at_min,
  fired: r.fired,
  repeat: (r.repeat as ReminderItem['repeat']) ?? 'none',
  repeatDays: r.repeat_days ?? undefined,
  intervalMin: r.interval_min ?? undefined,
  untilMin: r.until_min ?? undefined,
  lastFiredAt: r.last_fired_at ? Number(r.last_fired_at) : undefined,
  alarmAckAt: r.alarm_ack_at ? Number(r.alarm_ack_at) : undefined,
  createdAt: Date.parse(r.created_at)
})

const REMINDER_PATCH_MAP: Record<string, string> = {
  title: 'title',
  notes: 'notes',
  date: 'date',
  atMin: 'at_min',
  fired: 'fired',
  repeat: 'repeat',
  repeatDays: 'repeat_days',
  intervalMin: 'interval_min',
  untilMin: 'until_min',
  lastFiredAt: 'last_fired_at',
  alarmAckAt: 'alarm_ack_at',
  pushFired: 'push_fired'
}

type JournalRow = {
  id: string
  text: string
  photos: string[] | null
  location?: { lat: number; lng: number; label?: string } | null
  created_at: string
  updated_at: string | null
}

const journalToRow = (e: JournalEntry) => ({
  id: e.id,
  text: e.text,
  photos: e.photos,
  // sent only when set, so saves keep working before the database update
  ...(e.location ? { location: e.location } : {}),
  created_at: new Date(e.createdAt).toISOString(),
  updated_at: e.updatedAt ? new Date(e.updatedAt).toISOString() : null
})

const rowToJournal = (r: JournalRow): JournalEntry => ({
  id: r.id,
  text: r.text ?? '',
  photos: r.photos ?? [],
  location: r.location ?? undefined,
  createdAt: Date.parse(r.created_at),
  updatedAt: r.updated_at ? Date.parse(r.updated_at) : undefined
})

type NoteRow = {
  id: string
  title: string
  icon: string | null
  content: NoteDoc | null
  plain: string | null
  pinned: boolean | null
  created_at: string
  updated_at: string | null
  user_id?: string
  company_id?: string | null
  shared?: boolean | null
  parent_id?: string | null
  cover?: string | null
  meeting_id?: string | null
  task_id?: string | null
  updated_by?: string | null
}

const noteToRow = (n: Note) => ({
  id: n.id,
  title: n.title,
  icon: n.icon ?? null,
  content: n.content,
  plain: n.plain ?? '',
  pinned: !!n.pinned,
  // newer columns go up only once they are used, so plain saves never break
  ...(n.companyId ? { company_id: n.companyId, shared: !!n.shared } : {}),
  ...(n.parentId ? { parent_id: n.parentId } : {}),
  ...(n.cover ? { cover: n.cover } : {}),
  ...(n.meetingId ? { meeting_id: n.meetingId } : {}),
  ...(n.taskId ? { task_id: n.taskId } : {}),
  created_at: new Date(n.createdAt).toISOString(),
  updated_at: new Date(n.updatedAt).toISOString()
})

const rowToNote = (r: NoteRow): Note => ({
  id: r.id,
  title: r.title ?? '',
  icon: r.icon ?? undefined,
  cover: r.cover ?? undefined,
  content: r.content && typeof r.content === 'object' ? r.content : { type: 'doc' },
  plain: r.plain ?? '',
  pinned: !!r.pinned,
  parentId: r.parent_id ?? undefined,
  companyId: r.company_id ?? undefined,
  shared: !!r.shared,
  meetingId: r.meeting_id ?? undefined,
  taskId: r.task_id ?? undefined,
  createdBy: r.user_id ?? undefined,
  updatedBy: r.updated_by ?? undefined,
  createdAt: Date.parse(r.created_at),
  updatedAt: r.updated_at ? Date.parse(r.updated_at) : Date.parse(r.created_at)
})

type SettingsRow = {
  name: string
  timezone: string
  meet_link: string
  default_duration_min: number
  default_reminder_min: number
  work_start_min: number
  work_end_min: number
  theme: string
  booking_slug: string | null
  booking_enabled: boolean | null
  booking_start_min: number | null
  booking_end_min: number | null
  booking_days: number[] | null
  active_company_id?: string | null
}

const settingsToRow = (s: Settings) => ({
  name: s.name,
  timezone: s.timezone,
  meet_link: s.meetLink,
  default_duration_min: s.defaultDurationMin,
  default_reminder_min: s.defaultReminderMin,
  work_start_min: s.workStartMin,
  work_end_min: s.workEndMin,
  theme: s.theme,
  booking_slug: s.bookingSlug ?? null,
  booking_enabled: s.bookingEnabled ?? true,
  booking_start_min: s.bookingStartMin ?? 540,
  booking_end_min: s.bookingEndMin ?? 1200,
  booking_days: s.bookingDays ?? [1, 2, 3, 4, 5],
  // only once workspaces are on (the column exists then)
  ...(s.activeCompanyId ? { active_company_id: s.activeCompanyId } : {})
})

const rowToSettings = (r: SettingsRow): Settings => ({
  name: r.name,
  timezone: r.timezone,
  meetLink: r.meet_link,
  defaultDurationMin: r.default_duration_min,
  defaultReminderMin: r.default_reminder_min as Settings['defaultReminderMin'],
  workStartMin: r.work_start_min,
  workEndMin: r.work_end_min,
  theme: r.theme as Settings['theme'],
  bookingSlug: r.booking_slug ?? undefined,
  bookingEnabled: r.booking_enabled ?? true,
  bookingStartMin: r.booking_start_min ?? 540,
  bookingEndMin: r.booking_end_min ?? 1200,
  bookingDays: r.booking_days ?? [1, 2, 3, 4, 5],
  activeCompanyId: r.active_company_id ?? undefined
})

/* ---------- write-through ops (queued in the outbox) ---------- */

export const remote = {
  insertMeeting: (m: Meeting) => {
    if (!on()) return
    enqueue({ table: 'meetings', kind: 'insert', row: meetingToRow(m), label: 'insert meeting' })
  },
  updateMeeting: (id: string, patch: Partial<Meeting>) => {
    if (!on()) return
    const row = mapPatch(patch, MEETING_PATCH_MAP)
    if (Object.keys(row).length === 0) return
    enqueue({ table: 'meetings', kind: 'update', id, row, label: 'update meeting' })
  },
  deleteMeeting: (id: string) => {
    if (!on()) return
    enqueue({ table: 'meetings', kind: 'delete', id, label: 'delete meeting' })
  },
  insertBlocked: (b: BlockedTime) => {
    if (!on()) return
    enqueue({ table: 'blocked_times', kind: 'insert', row: blockedToRow(b), label: 'insert blocked' })
  },
  updateBlocked: (id: string, patch: Partial<BlockedTime>) => {
    if (!on()) return
    const row = mapPatch(patch, BLOCKED_PATCH_MAP)
    if (Object.keys(row).length === 0) return
    enqueue({ table: 'blocked_times', kind: 'update', id, row, label: 'update blocked' })
  },
  deleteBlocked: (id: string) => {
    if (!on()) return
    enqueue({ table: 'blocked_times', kind: 'delete', id, label: 'delete blocked' })
  },
  insertAvailability: (w: AvailabilityWindow) => {
    if (!on()) return
    enqueue({ table: 'availability_windows', kind: 'insert', row: availToRow(w), label: 'insert availability' })
  },
  deleteAvailability: (id: string) => {
    if (!on()) return
    enqueue({ table: 'availability_windows', kind: 'delete', id, label: 'delete availability' })
  },
  insertTask: (t: Task) => {
    if (!on()) return
    enqueue({ table: 'tasks', kind: 'insert', row: taskToRow(t), label: 'insert task' })
  },
  updateTask: (id: string, patch: Partial<Task>) => {
    if (!on()) return
    const row = mapPatch(patch, TASK_PATCH_MAP)
    if ('completed_at' in row && typeof row.completed_at === 'number')
      row.completed_at = new Date(row.completed_at as number).toISOString()
    if (Object.keys(row).length === 0) return
    enqueue({ table: 'tasks', kind: 'update', id, row, label: 'update task' })
  },
  deleteTask: (id: string) => {
    if (!on()) return
    enqueue({ table: 'tasks', kind: 'delete', id, label: 'delete task' })
  },
  insertReminder: (r: ReminderItem) => {
    if (!on()) return
    enqueue({ table: 'reminders', kind: 'insert', row: reminderToRow(r), label: 'insert reminder' })
  },
  updateReminder: (id: string, patch: Partial<ReminderItem>) => {
    if (!on()) return
    const row = mapPatch(patch, REMINDER_PATCH_MAP)
    if (Object.keys(row).length === 0) return
    enqueue({ table: 'reminders', kind: 'update', id, row, label: 'update reminder' })
  },
  deleteReminder: (id: string) => {
    if (!on()) return
    enqueue({ table: 'reminders', kind: 'delete', id, label: 'delete reminder' })
  },
  insertJournal: (e: JournalEntry) => {
    if (!on()) return
    enqueue({ table: 'journal_entries', kind: 'insert', row: journalToRow(e), label: 'insert journal' })
  },
  updateJournal: (id: string, patch: Partial<JournalEntry>) => {
    if (!on()) return
    const row: Record<string, unknown> = {}
    if ('text' in patch) row.text = patch.text ?? ''
    if ('photos' in patch) row.photos = patch.photos ?? []
    if ('location' in patch) row.location = patch.location ?? null
    if ('updatedAt' in patch) row.updated_at = patch.updatedAt ? new Date(patch.updatedAt).toISOString() : null
    if (Object.keys(row).length === 0) return
    enqueue({ table: 'journal_entries', kind: 'update', id, row, label: 'update journal' })
  },
  deleteJournal: (id: string) => {
    if (!on()) return
    enqueue({ table: 'journal_entries', kind: 'delete', id, label: 'delete journal' })
  },
  insertNote: (n: Note) => {
    if (!on()) return
    enqueue({ table: 'notes', kind: 'insert', row: noteToRow(n), label: 'insert note' })
  },
  updateNote: (id: string, patch: Partial<Note>) => {
    if (!on()) return
    const row: Record<string, unknown> = {}
    if ('title' in patch) row.title = patch.title ?? ''
    if ('icon' in patch) row.icon = patch.icon ?? null
    if ('content' in patch) row.content = patch.content
    if ('plain' in patch) row.plain = patch.plain ?? ''
    if ('pinned' in patch) row.pinned = !!patch.pinned
    if ('shared' in patch) row.shared = !!patch.shared
    if ('parentId' in patch) row.parent_id = patch.parentId ?? null
    if ('cover' in patch) row.cover = patch.cover ?? null
    if ('meetingId' in patch) row.meeting_id = patch.meetingId ?? null
    if ('taskId' in patch) row.task_id = patch.taskId ?? null
    if ('updatedAt' in patch && patch.updatedAt) row.updated_at = new Date(patch.updatedAt).toISOString()
    if (Object.keys(row).length === 0) return
    enqueue({ table: 'notes', kind: 'update', id, row, label: 'update note' })
  },
  deleteNote: (id: string) => {
    if (!on()) return
    enqueue({ table: 'notes', kind: 'delete', id, label: 'delete note' })
  },
  upsertSettings: (s: Settings, userId: string) => {
    if (!on() || !settingsLoaded) return
    enqueue({ table: 'settings', kind: 'upsert', row: { user_id: userId, ...settingsToRow(s) }, label: 'upsert settings' })
  }
}

/* ---------- bulk ops used at sign-in ---------- */

export interface RemoteData {
  meetings: Meeting[]
  blocked: BlockedTime[]
  availability: AvailabilityWindow[]
  tasks: Task[]
  reminders: ReminderItem[]
  /** undefined while the journal table hasn't been created yet */
  journal?: JournalEntry[]
  /** undefined until the notes table has been created */
  notes?: Note[]
  settings: Settings | null
  isEmpty: boolean
}

/** Fetch everything this user owns (RLS scopes the queries). */
/**
 * `journal: false` skips the journal (its photos are by far the heaviest data):
 * the once-a-minute background refresh uses it so phones aren't re-downloading
 * every photo all day. The journal is loaded on sign-in and whenever it changes.
 */
/** just the journal (its photos are the heaviest data) — loaded last, in the background */
export const fetchJournal = async (): Promise<JournalEntry[] | null> => {
  if (!isSupabaseEnabled) return null
  // counted before sending, so a change made at any point during the refresh wins
  const writesBefore = writeCount
  await flushOutbox()
  const { data, error } = await supabase.from('journal_entries').select('*')
  if (error) return null
  if (stale(writesBefore)) return null
  return ((data ?? []) as JournalRow[]).map(rowToJournal)
}

/** a fetched copy is out of date when local changes are still waiting or were made meanwhile */
const stale = (writesBefore: number) => {
  const old = on() && (outbox.length > 0 || writeCount !== writesBefore)
  if (old) console.info('[sync] refresh skipped: local changes are still saving')
  return old
}

export const fetchAll = async (opts: { journal?: boolean } = {}): Promise<RemoteData | null> => {
  if (!isSupabaseEnabled) return null
  // counted before sending, so a change made at any point during the refresh wins
  const writesBefore = writeCount
  await flushOutbox()
  const withJournal = opts.journal !== false
  const [meetings, blocked, availability, tasks, reminders, settings, journal, notes] = await Promise.all([
    supabase.from('meetings').select('*'),
    supabase.from('blocked_times').select('*'),
    supabase.from('availability_windows').select('*'),
    supabase.from('tasks').select('*'),
    supabase.from('reminders').select('*'),
    supabase.from('settings').select('*').maybeSingle(),
    // tolerated separately: the table may not exist until schema.sql is re-run
    withJournal ? supabase.from('journal_entries').select('*') : Promise.resolve({ data: [], error: null }),
    // same: notes arrive with a later database update
    supabase.from('notes').select('*')
  ])
  const err =
    meetings.error ?? blocked.error ?? availability.error ?? tasks.error ?? reminders.error ?? settings.error
  if (err) {
    console.error('[sync] fetch failed:', err.message)
    return null
  }
  if (stale(writesBefore)) return null
  if (on()) settingsLoaded = true
  const data: RemoteData = {
    meetings: ((meetings.data ?? []) as MeetingRow[]).map(rowToMeeting),
    blocked: ((blocked.data ?? []) as BlockedRow[]).map(rowToBlocked),
    availability: ((availability.data ?? []) as AvailRow[]).map(rowToAvail),
    tasks: ((tasks.data ?? []) as TaskRow[]).map(rowToTask),
    reminders: ((reminders.data ?? []) as ReminderRow[]).map(rowToReminder),
    journal: !withJournal || journal.error ? undefined : ((journal.data ?? []) as JournalRow[]).map(rowToJournal),
    notes: notes.error ? undefined : ((notes.data ?? []) as NoteRow[]).map(rowToNote),
    settings: settings.data ? rowToSettings(settings.data as SettingsRow) : null,
    isEmpty: false
  }
  data.isEmpty =
    data.meetings.length === 0 &&
    data.blocked.length === 0 &&
    data.availability.length === 0 &&
    data.tasks.length === 0 &&
    data.reminders.length === 0 &&
    (data.journal?.length ?? 0) === 0 &&
    (data.notes?.length ?? 0) === 0 &&
    data.settings === null
  return data
}

/** Replace everything this user owns with the given state (seed / reset). */
export const replaceAll = async (
  state: {
    meetings: Meeting[]
    blocked: BlockedTime[]
    availability: AvailabilityWindow[]
    tasks: Task[]
    reminders: ReminderItem[]
    journal?: JournalEntry[]
    notes?: Note[]
    settings: Settings
  },
  userId: string
): Promise<void> => {
  if (!isSupabaseEnabled) return
  // entries loaded from the device cache carry no photos — rewriting the
  // journal from them would wipe the real photos, so leave it untouched
  const touchJournal = !(state.journal ?? []).some((e) => e.photosOffline)
  await Promise.all([
    supabase.from('meetings').delete().eq('user_id', userId),
    supabase.from('blocked_times').delete().eq('user_id', userId),
    supabase.from('availability_windows').delete().eq('user_id', userId),
    supabase.from('tasks').delete().eq('user_id', userId),
    supabase.from('reminders').delete().eq('user_id', userId),
    touchJournal ? supabase.from('journal_entries').delete().eq('user_id', userId) : Promise.resolve({ error: null }),
    state.notes ? supabase.from('notes').delete().eq('user_id', userId) : Promise.resolve({ error: null })
  ])
  const results = await Promise.all([
    state.meetings.length
      ? supabase.from('meetings').insert(state.meetings.map(meetingToRow))
      : Promise.resolve({ error: null }),
    state.blocked.length
      ? supabase.from('blocked_times').insert(state.blocked.map(blockedToRow))
      : Promise.resolve({ error: null }),
    state.availability.length
      ? supabase.from('availability_windows').insert(state.availability.map(availToRow))
      : Promise.resolve({ error: null }),
    state.tasks.length
      ? supabase.from('tasks').insert(state.tasks.map(taskToRow))
      : Promise.resolve({ error: null }),
    state.reminders.length
      ? supabase.from('reminders').insert(state.reminders.map(reminderToRow))
      : Promise.resolve({ error: null }),
    touchJournal && state.journal?.length
      ? supabase.from('journal_entries').insert(state.journal.map(journalToRow))
      : Promise.resolve({ error: null }),
    state.notes?.length ? supabase.from('notes').insert(state.notes.map(noteToRow)) : Promise.resolve({ error: null }),
    supabase.from('settings').upsert({ user_id: userId, ...settingsToRow(state.settings) })
  ])
  for (const r of results) {
    if (r.error) console.error('[sync] seed failed:', r.error.message)
  }
}
