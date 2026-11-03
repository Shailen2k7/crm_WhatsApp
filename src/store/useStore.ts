import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type {
  AvailabilityWindow,
  BlockedTime,
  CalendarMode,
  JournalEntry,
  Note,
  NoteDoc,
  Meeting,
  ReminderItem,
  Settings,
  Task,
  ViewId,
  VoiceFields
} from '../types'
import { defaultSettings, seedAvailability, seedBlocked, seedMeetings, seedReminders, seedTasks } from '../lib/seed'
import { remote, replaceAll } from '../lib/remote'
import { toDateKey } from '../lib/time'
import { useWorkspace } from '../lib/workspace'

/** `done` and `status` always agree: whichever one a change touches wins */
const syncStatus = (patch: Partial<Task>, before?: Task): Partial<Task> => {
  const out = { ...patch }
  if ('status' in out && out.status) {
    const done = out.status === 'done'
    if (done !== (before?.done ?? false) || !('done' in out)) {
      out.done = done
      out.completedAt = done ? (before?.completedAt ?? Date.now()) : undefined
    }
  } else if ('done' in out && out.done !== undefined) {
    out.status = out.done ? 'done' : before?.status === 'done' || !before?.status ? 'todo' : before.status
  }
  return out
}

/**
 * Assigning to a member releases an invited-person placeholder and vice versa.
 * The invite column is only sent when it is (or was) in use, so saves keep
 * working before that database update has been run.
 */
const fixInvitePatch = (patch: Partial<Task>, before?: Task): Partial<Task> => {
  const out = { ...patch }
  if (out.assignedInvite) out.assignedTo = undefined
  else if (out.assignedTo && before?.assignedInvite) out.assignedInvite = undefined
  if ('assignedInvite' in out && !out.assignedInvite && !before?.assignedInvite) delete out.assignedInvite
  return out
}

interface ScheduleDraft {
  date?: string
  startMin?: number
  durationMin?: number
  meetingId?: string // when editing
}

export interface HydrateData {
  meetings: Meeting[]
  blocked: BlockedTime[]
  availability: AvailabilityWindow[]
  tasks: Task[]
  reminders: ReminderItem[]
  journal?: JournalEntry[]
  notes?: Note[]
  settings: Settings
}

interface AppState {
  meetings: Meeting[]
  blocked: BlockedTime[]
  availability: AvailabilityWindow[]
  tasks: Task[]
  reminders: ReminderItem[]
  journal: JournalEntry[]
  notes: Note[]
  settings: Settings
  /** set while signed in; used for cloud sync rows that need it explicitly */
  syncUserId: string | null

  // UI state (not persisted via partialize)
  view: ViewId
  calendarMode: CalendarMode
  calendarDate: string
  scheduleOpen: boolean
  scheduleDraft: ScheduleDraft | null
  detailsMeetingId: string | null
  /** task editor: 'new' or a task id */
  taskEditor: string | null
  /** reminder editor: 'new' or a reminder id */
  reminderEditor: string | null
  /** prefilled title when creating a reminder from a task */
  reminderPrefill: string | null
  /** fields understood by voice, waiting for the form that opens next ("Edit") */
  voicePrefill: VoiceFields | null
  setVoicePrefill: (v: VoiceFields | null) => void

  setView: (v: ViewId) => void
  setCalendarMode: (m: CalendarMode) => void
  setCalendarDate: (d: string) => void

  setSyncUserId: (id: string | null) => void
  hydrateAll: (data: HydrateData) => void

  openSchedule: (draft?: ScheduleDraft) => void
  closeSchedule: () => void
  openDetails: (id: string | null) => void
  openTaskEditor: (id: string | 'new') => void
  closeTaskEditor: () => void
  openReminderEditor: (id: string | 'new') => void
  openReminderFor: (title: string) => void
  closeReminderEditor: () => void

  addTask: (t: Task) => void
  updateTask: (id: string, patch: Partial<Task>) => void
  toggleTask: (id: string) => void
  deleteTask: (id: string) => void

  addJournalEntry: (e: JournalEntry) => void
  updateJournalEntry: (id: string, patch: Partial<JournalEntry>) => void
  deleteJournalEntry: (id: string) => void

  addNote: (n: Note) => void
  updateNote: (id: string, patch: Partial<Note>) => void
  deleteNote: (id: string) => void

  addReminderItem: (r: ReminderItem) => void
  updateReminderItem: (id: string, patch: Partial<ReminderItem>) => void
  deleteReminderItem: (id: string) => void
  markReminderItemFired: (id: string) => void

  addMeeting: (m: Meeting) => void
  updateMeeting: (id: string, patch: Partial<Meeting>) => void
  deleteMeeting: (id: string) => void
  markReminderFired: (id: string, key: string) => void

  addBlocked: (b: BlockedTime) => void
  updateBlocked: (id: string, patch: Partial<BlockedTime>) => void
  deleteBlocked: (id: string) => void

  addAvailability: (w: AvailabilityWindow) => void
  deleteAvailability: (id: string) => void

  updateSettings: (patch: Partial<Settings>) => void
  resetDemoData: () => void
  /** wipe all meetings and blocked time (availability + settings stay) */
  clearAllData: () => void
}

/* ------------------------------------------------------------------ */
/*  Data guard: one malformed record (a missing date, a number where    */
/*  text belongs) used to crash the whole app into a white screen.      */
/*  Records are checked as they load; anything unusable is skipped on   */
/*  screen only — nothing is ever deleted from the cloud.               */
/* ------------------------------------------------------------------ */

const MEETING_TYPE_IDS: Meeting['type'][] = ['client', 'partner', 'international', 'internal', 'personal']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const text = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as T[]) : [])

const skipped = (kind: string, before: number, after: number) => {
  if (after < before) console.warn(`Taskorra: skipped ${before - after} unreadable ${kind} record(s)`)
}

export const cleanData = <D extends Partial<Pick<AppState, 'meetings' | 'blocked' | 'availability' | 'tasks' | 'reminders' | 'journal' | 'notes'>>>(d: D): D => {
  const out = { ...d }
  if ('meetings' in d) {
    const raw = list<Meeting>(d.meetings)
    out.meetings = raw
      .filter((m) => typeof m.id === 'string' && isDate(m.date) && isNum(m.startMin) && isNum(m.durationMin))
      .map((m) => ({
        ...m,
        title: text(m.title, 'Untitled meeting'),
        personName: text(m.personName),
        type: MEETING_TYPE_IDS.includes(m.type) ? m.type : 'client'
      }))
    skipped('meeting', raw.length, out.meetings.length)
  }
  if ('reminders' in d) {
    const raw = list<ReminderItem>(d.reminders)
    out.reminders = raw
      .filter((r) => typeof r.id === 'string' && isDate(r.date) && isNum(r.atMin))
      .map((r) => ({ ...r, title: text(r.title, 'Reminder') }))
    skipped('reminder', raw.length, out.reminders.length)
  }
  if ('tasks' in d) {
    const raw = list<Task>(d.tasks)
    out.tasks = raw
      .filter((t) => typeof t.id === 'string')
      .map((t) => ({
        ...t,
        title: text(t.title, 'Untitled task'),
        dueDate: isDate(t.dueDate) ? t.dueDate : undefined,
        status: t.status === 'in_progress' || t.status === 'done' || t.status === 'todo' ? t.status : t.done ? 'done' : 'todo',
        dueTime: isNum(t.dueTime) && t.dueTime >= 0 && t.dueTime < 1440 ? t.dueTime : undefined,
        subtasks: Array.isArray(t.subtasks)
          ? t.subtasks.filter((x) => x && typeof x === 'object' && typeof x.id === 'string').map((x) => ({ ...x, title: text(x.title), done: !!x.done }))
          : undefined
      }))
    skipped('task', raw.length, out.tasks.length)
  }
  if ('blocked' in d) {
    out.blocked = list<BlockedTime>(d.blocked).filter((b) => isDate(b.date) && isNum(b.startMin) && isNum(b.endMin))
  }
  if ('availability' in d) {
    out.availability = list<AvailabilityWindow>(d.availability).filter((w) => isNum(w.day) && isNum(w.startMin) && isNum(w.endMin))
  }
  if ('journal' in d) {
    const raw = list<JournalEntry>(d.journal)
    out.journal = raw
      .filter((e) => typeof e.id === 'string' && isNum(e.createdAt))
      .map((e) => ({ ...e, text: text(e.text), photos: Array.isArray(e.photos) ? e.photos.filter((p) => typeof p === 'string') : [] }))
    skipped('journal', raw.length, out.journal.length)
  }
  if ('notes' in d) {
    const raw = list<Note>(d.notes)
    const isDoc = (c: unknown): c is NoteDoc => !!c && typeof c === 'object' && (c as NoteDoc).type === 'doc'
    out.notes = raw
      .filter((n) => typeof n.id === 'string' && isNum(n.createdAt))
      .map((n) => ({
        ...n,
        title: text(n.title),
        plain: text(n.plain),
        updatedAt: isNum(n.updatedAt) ? n.updatedAt : n.createdAt,
        content: isDoc(n.content) ? n.content : { type: 'doc' }
      }))
    skipped('notes', raw.length, out.notes.length)
  }
  return out
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      meetings: seedMeetings(),
      blocked: seedBlocked(),
      availability: seedAvailability(),
      tasks: seedTasks(),
      reminders: seedReminders(),
      journal: [],
      notes: [],
      settings: defaultSettings(),
      syncUserId: null,

      view: 'dashboard',
      calendarMode: 'week',
      calendarDate: toDateKey(new Date()),
      scheduleOpen: false,
      scheduleDraft: null,
      detailsMeetingId: null,
      taskEditor: null,
      reminderEditor: null,
      reminderPrefill: null,
      voicePrefill: null,
      setVoicePrefill: (voicePrefill) => set({ voicePrefill }),

      setView: (view) => set({ view, detailsMeetingId: null }),
      setCalendarMode: (calendarMode) => set({ calendarMode }),
      setCalendarDate: (calendarDate) => set({ calendarDate }),

      setSyncUserId: (syncUserId) => set({ syncUserId }),
      hydrateAll: (data) =>
        set({
          ...cleanData({
            meetings: data.meetings,
            blocked: data.blocked,
            availability: data.availability,
            tasks: data.tasks,
            reminders: data.reminders,
            ...(data.journal ? { journal: data.journal } : {}),
            ...(data.notes ? { notes: data.notes } : {})
          }),
          settings: data.settings
        }),

      openSchedule: (draft) => set({ scheduleOpen: true, scheduleDraft: draft ?? null, detailsMeetingId: null }),
      closeSchedule: () => set({ scheduleOpen: false, scheduleDraft: null }),
      openDetails: (detailsMeetingId) => set({ detailsMeetingId }),
      openTaskEditor: (taskEditor) => set({ taskEditor }),
      closeTaskEditor: () => set({ taskEditor: null }),
      openReminderEditor: (reminderEditor) => set({ reminderEditor, reminderPrefill: null }),
      openReminderFor: (title) => set({ reminderEditor: 'new', reminderPrefill: title }),
      closeReminderEditor: () => set({ reminderEditor: null, reminderPrefill: null }),

      addTask: (t) => {
        // a new task lives in the workspace that is open and, unless it was
        // handed to someone, belongs to the person who wrote it
        const ws = useWorkspace.getState()
        const task: Task = {
          ...t,
          createdBy: t.createdBy ?? ws.me ?? undefined,
          companyId: t.companyId ?? (ws.available ? (ws.activeId ?? undefined) : undefined),
          // handed to someone invited but not joined yet → nobody holds it until they join
          assignedTo: t.assignedInvite ? undefined : (t.assignedTo ?? (ws.available && ws.activeId ? (ws.me ?? undefined) : undefined)),
          // the server records who handed it out; mirror that here so "Assigned by me" is right straight away
          assignedBy: t.assignedBy ?? ((t.assignedTo && t.assignedTo !== ws.me) || t.assignedInvite ? (ws.me ?? undefined) : undefined),
          status: t.status ?? (t.done ? 'done' : 'todo')
        }
        set((s) => ({ tasks: [...s.tasks, task] }))
        remote.insertTask(task)
      },
      updateTask: (id, patch) => {
        const before = get().tasks.find((t) => t.id === id)
        const full = syncStatus(fixInvitePatch(patch, before), before)
        // handing it to someone new: mirror the server, which records who assigned it
        const me = useWorkspace.getState().me
        if ((full.assignedTo && full.assignedTo !== before?.assignedTo) || (full.assignedInvite && full.assignedInvite !== before?.assignedInvite)) full.assignedBy = me ?? before?.assignedBy
        set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...full } : t)) }))
        remote.updateTask(id, full)
      },
      toggleTask: (id) => {
        const t = get().tasks.find((x) => x.id === id)
        if (!t) return
        const patch = syncStatus({ done: !t.done, completedAt: !t.done ? Date.now() : undefined }, t)
        set((s) => ({ tasks: s.tasks.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))
        remote.updateTask(id, patch)
      },
      deleteTask: (id) => {
        set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }))
        remote.deleteTask(id)
      },

      addJournalEntry: (e) => {
        set((s) => ({ journal: [...s.journal, e] }))
        remote.insertJournal(e)
      },
      updateJournalEntry: (id, patch) => {
        const before = get().journal.find((e) => e.id === id)
        set((s) => ({ journal: s.journal.map((e) => (e.id === id ? { ...e, ...patch } : e)) }))
        // An entry opened from the device cache has no photos yet (they live in
        // the cloud). Never let saving it send an empty photo list that would
        // wipe the real photos — only the other fields go up.
        if (before?.photosOffline && 'photos' in patch) {
          const { photos: _keep, ...rest } = patch
          remote.updateJournal(id, rest)
        } else {
          remote.updateJournal(id, patch)
        }
      },
      deleteJournalEntry: (id) => {
        set((s) => ({ journal: s.journal.filter((e) => e.id !== id) }))
        remote.deleteJournal(id)
      },

      addNote: (n) => {
        // a new page lives in the workspace that is open and belongs to its writer
        const ws = useWorkspace.getState()
        const inCompany = ws.available && !!ws.activeId && ws.workspaces.find((w) => w.id === ws.activeId)?.kind === 'company'
        const note: Note = {
          ...n,
          createdBy: n.createdBy ?? ws.me ?? undefined,
          companyId: n.companyId ?? (inCompany ? (ws.activeId ?? undefined) : undefined)
        }
        set((s) => ({ notes: [...s.notes, note] }))
        remote.insertNote(note)
      },
      updateNote: (id, patch) => {
        set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }))
        remote.updateNote(id, patch)
      },
      deleteNote: (id) => {
        set((s) => ({ notes: s.notes.filter((n) => n.id !== id) }))
        remote.deleteNote(id)
      },

      addReminderItem: (r) => {
        set((s) => ({ reminders: [...s.reminders, r] }))
        remote.insertReminder(r)
      },
      updateReminderItem: (id, patch) => {
        set((s) => ({ reminders: s.reminders.map((r) => (r.id === id ? { ...r, ...patch } : r)) }))
        remote.updateReminder(id, patch)
      },
      deleteReminderItem: (id) => {
        set((s) => ({ reminders: s.reminders.filter((r) => r.id !== id) }))
        remote.deleteReminder(id)
      },
      markReminderItemFired: (id) => {
        set((s) => ({ reminders: s.reminders.map((r) => (r.id === id ? { ...r, fired: true } : r)) }))
        remote.updateReminder(id, { fired: true })
      },

      addMeeting: (m) => {
        set((s) => ({ meetings: [...s.meetings, m] }))
        remote.insertMeeting(m)
      },
      updateMeeting: (id, patch) => {
        set((s) => ({
          meetings: s.meetings.map((m) => (m.id === id ? { ...m, ...patch } : m))
        }))
        remote.updateMeeting(id, patch)
      },
      deleteMeeting: (id) => {
        set((s) => ({
          meetings: s.meetings.filter((m) => m.id !== id),
          detailsMeetingId: s.detailsMeetingId === id ? null : s.detailsMeetingId
        }))
        remote.deleteMeeting(id)
      },
      markReminderFired: (id, key) => {
        set((s) => ({
          meetings: s.meetings.map((m) =>
            m.id === id ? { ...m, remindersFired: [...(m.remindersFired ?? []), key] } : m
          )
        }))
        const fired = get().meetings.find((m) => m.id === id)?.remindersFired
        if (fired) remote.updateMeeting(id, { remindersFired: fired })
      },

      addBlocked: (b) => {
        set((s) => ({ blocked: [...s.blocked, b] }))
        remote.insertBlocked(b)
      },
      updateBlocked: (id, patch) => {
        set((s) => ({
          blocked: s.blocked.map((b) => (b.id === id ? { ...b, ...patch } : b))
        }))
        remote.updateBlocked(id, patch)
      },
      deleteBlocked: (id) => {
        set((s) => ({ blocked: s.blocked.filter((b) => b.id !== id) }))
        remote.deleteBlocked(id)
      },

      addAvailability: (w) => {
        set((s) => ({ availability: [...s.availability, w] }))
        remote.insertAvailability(w)
      },
      deleteAvailability: (id) => {
        set((s) => ({ availability: s.availability.filter((w) => w.id !== id) }))
        remote.deleteAvailability(id)
      },

      updateSettings: (patch) => {
        set((s) => ({ settings: { ...s.settings, ...patch } }))
        const { settings, syncUserId } = get()
        if (syncUserId) remote.upsertSettings(settings, syncUserId)
      },
      resetDemoData: () => {
        set({
          meetings: seedMeetings(),
          blocked: seedBlocked(),
          availability: seedAvailability(),
          tasks: seedTasks(),
          reminders: seedReminders(),
          journal: [],
          settings: defaultSettings()
        })
        const { syncUserId } = get()
        if (syncUserId) void replaceAll(get(), syncUserId)
      },
      // only what the button promises: meetings and blocked slots. Tasks,
      // reminders, the journal, availability and settings are never touched.
      clearAllData: () => {
        const { meetings, blocked } = get()
        set({ meetings: [], blocked: [] })
        meetings.forEach((m) => remote.deleteMeeting(m.id))
        blocked.forEach((b) => remote.deleteBlocked(b.id))
      }
    }),
    {
      name: 'meeting-scheduler-os',
      // a full device cache (5 MB on phones) must never crash a save: the data
      // is already safe in the cloud, so a failed cache write is only logged
      storage: createJSONStorage(() => ({
        getItem: (k) => localStorage.getItem(k),
        removeItem: (k) => localStorage.removeItem(k),
        setItem: (k, v) => {
          try {
            localStorage.setItem(k, v)
          } catch (err) {
            console.warn('Taskorra: device cache is full — data stays in the cloud', err)
          }
        }
      })),
      // saved data from this device is checked too, so a bad record can't stop the app opening
      merge: (persisted, current) => ({ ...current, ...cleanData((persisted ?? {}) as Partial<AppState>) }),
      partialize: (s) => ({
        meetings: s.meetings,
        blocked: s.blocked,
        availability: s.availability,
        tasks: s.tasks,
        reminders: s.reminders,
        // cloud mode: cache the journal WITHOUT its photos (they are the bulk of
        // the data and come straight from the cloud); local-only mode keeps them
        journal: s.syncUserId
          ? s.journal.map((e) => ({ ...e, photos: [], photosOffline: e.photosOffline || e.photos.length > 0 }))
          : s.journal,
        notes: s.notes,
        settings: s.settings
      })
    }
  )
)

// Dev-only: expose the store for debugging/testing in the console
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__store = useStore
}

/** Is [startMin, startMin+duration) fully inside an availability window on `date`? */
export const isWithinAvailability = (
  availability: AvailabilityWindow[],
  date: string,
  startMin: number,
  durationMin: number
): boolean => {
  const day = new Date(`${date}T00:00:00`).getDay()
  const end = startMin + durationMin
  return availability.some((w) => w.day === day && w.startMin <= startMin && w.endMin >= end)
}

/** Is [startMin, startMin+duration) on `date` free of other meetings + blocks? */
export const checkConflict = (
  meetings: Meeting[],
  blocked: BlockedTime[],
  date: string,
  startMin: number,
  durationMin: number,
  ignoreMeetingId?: string
): { conflict: boolean; reason?: string } => {
  const end = startMin + durationMin
  for (const m of meetings) {
    if (m.id === ignoreMeetingId || m.date !== date) continue
    const mEnd = m.startMin + m.durationMin
    if (startMin < mEnd && end > m.startMin) {
      return { conflict: true, reason: `Overlaps "${m.title}"` }
    }
  }
  for (const b of blocked) {
    if (b.date !== date) continue
    if (startMin < b.endMin && end > b.startMin) {
      return { conflict: true, reason: `Overlaps blocked time${b.label ? ` (${b.label})` : ''}` }
    }
  }
  return { conflict: false }
}
