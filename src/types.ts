export type MeetingTypeId = 'client' | 'partner' | 'international' | 'internal' | 'personal'

export interface MeetingType {
  id: MeetingTypeId
  label: string
  color: string
}

export interface Contact {
  id: string
  name: string
  email?: string
  company?: string
}

export type ReminderMinutes = 0 | 5 | 10 | 15 | 30

export interface Meeting {
  id: string
  title: string
  personName: string
  personEmail?: string
  /** ISO date string yyyy-MM-dd */
  date: string
  /** minutes from midnight, local time */
  startMin: number
  /** duration in minutes */
  durationMin: number
  type: MeetingTypeId
  notes?: string
  meetLink?: string
  reminderMin: ReminderMinutes | null
  /** reminder keys already fired (so we don't re-notify) */
  remindersFired?: string[]
  /** server push reminder already sent (reset on reschedule) */
  pushFired?: boolean
  /** server push steps already sent, e.g. ['60','30'] (cleared when the time moves) */
  pushSent?: string[]
  /** raw meeting transcript (pasted or uploaded) */
  transcript?: string
  /** AI-generated meeting notes */
  aiNotes?: AiNotes
  /** 'crm' = mirrored from Migrizo CRM (read-only here; managed in the CRM) */
  source?: string
  /** the CRM's own meeting id, for source='crm' */
  externalId?: string
  createdAt: number
}

export const isFromCrm = (m: Pick<Meeting, 'source'>) => m.source === 'crm'

export interface AiNotes {
  /** markdown with fixed sections (Summary / Key Points / Decisions / Action Items / Follow-up) */
  content: string
  generatedAt: number
  /** true once the user hand-edits the notes */
  edited?: boolean
  /** which engine produced them */
  source: 'claude' | 'demo'
}

export interface BlockedTime {
  id: string
  /** ISO date yyyy-MM-dd */
  date: string
  startMin: number
  endMin: number
  label?: string
  /** "Plan my day": the task this block is time set aside for */
  taskId?: string
}

/** Weekly recurring availability window. day: 0=Sun..6=Sat */
export interface AvailabilityWindow {
  id: string
  day: number
  startMin: number
  endMin: number
}

export type TaskPriority = 'high' | 'medium' | 'low'
export type TaskStatus = 'todo' | 'in_progress' | 'done'

/** a step inside a task: tick it off, optionally with its own date and person */
export interface Subtask {
  id: string
  title: string
  done: boolean
  dueDate?: string
  /** team workspace: who does this step */
  assignedTo?: string
}

export interface Task {
  id: string
  title: string
  notes?: string
  priority: TaskPriority
  done: boolean
  /** optional due date yyyy-MM-dd */
  dueDate?: string
  /** optional due time, minutes from midnight (needs dueDate) */
  dueTime?: number
  subtasks?: Subtask[]
  createdAt: number
  completedAt?: number
  /** workspace this task belongs to (set once team workspaces are on) */
  companyId?: string
  /** who created it (cloud mode) */
  createdBy?: string
  /** who should do it (a member of the workspace) */
  assignedTo?: string
  /** who handed it out — filled in by the server */
  assignedBy?: string
  /** handed to someone invited but not joined yet (an invite id); becomes assignedTo when they join */
  assignedInvite?: string
  teamId?: string
  /** To do · In progress · Done (kept in step with `done`) */
  status?: TaskStatus
}

/* ---------- team workspaces ---------- */

export type WorkspaceRole = 'admin' | 'manager' | 'member'

export interface Workspace {
  id: string
  name: string
  logoUrl?: string
  size?: string
  /** 'personal' = the private space every account gets; 'company' = a team workspace */
  kind: 'company' | 'personal'
  /** the signed-in person's role here */
  role: WorkspaceRole
}

export interface Member {
  userId: string
  name: string
  email: string
  role: WorkspaceRole
  teamIds: string[]
  joinedAt: number
  /** IANA zone from their settings, for "9:40 PM for Wen" */
  timezone?: string
}

export interface Team {
  id: string
  name: string
  color?: string
  memberIds: string[]
}

/** someone invited to the workspace who hasn't joined yet (no link token) */
export interface PendingPerson {
  id: string
  email: string
  role: WorkspaceRole
  teamId?: string
  createdAt: number
}

export interface Invite {
  id: string
  /** empty for a shareable link invite */
  email: string
  role: WorkspaceRole
  teamId?: string
  token: string
  status: 'pending' | 'accepted' | 'cancelled'
  invitedBy?: string
  createdAt: number
  expiresAt: number
}

export interface TaskComment {
  id: string
  taskId: string
  userId: string
  body: string
  createdAt: number
}

export interface AppNotification {
  id: string
  kind: 'task_assigned' | 'task_done' | 'task_comment' | string
  title: string
  body: string
  taskId?: string
  actorId?: string
  companyId?: string
  readAt?: number
  createdAt: number
}

/* ---------- workspace chat ---------- */

/** dm = two people · group = a few people · team = a team's channel · general = everyone */
export type ConversationKind = 'dm' | 'group' | 'team' | 'general'

export interface Conversation {
  id: string
  companyId: string
  kind: ConversationKind
  /** group or channel name; empty for a DM (shown as the other person's name) */
  name: string
  teamId?: string
  createdBy?: string
  createdAt: number
  memberIds: string[]
  /** each member's read marker, for "Seen" */
  reads: Record<string, number>
  lastMessageAt?: number
  lastMessage?: { id: string; senderId: string; body: string; createdAt: number; deleted: boolean; files?: number }
  /** my own settings for this chat */
  lastReadAt: number
  unread: number
  muted: boolean
  pinned: boolean
}

/** a picture or file sent in a chat (stored in the chat-files bucket) */
export interface ChatAttachment {
  path: string
  name: string
  size: number
  type: string
  /** pictures: pixel size, for a steady layout before it loads */
  w?: number
  h?: number
}

export interface ChatMessage {
  id: string
  conversationId: string
  senderId: string
  body: string
  replyTo?: string
  mentions: string[]
  attachments: ChatAttachment[]
  editedAt?: number
  deletedAt?: number
  createdAt: number
  reactions: { emoji: string; userIds: string[] }[]
  /** on this device only: not saved to the server yet / the save failed */
  pending?: boolean
  failed?: boolean
}

export type PresenceStatus = 'online' | 'away' | 'dnd'

/** what a workspace-mate's device is telling everyone right now */
export interface Presence {
  status: PresenceStatus
  /** in a meeting until this time (ms) */
  meetingUntil?: number
  /** the chat they have open */
  viewing?: string | null
  at: number
}

export type RepeatKind = 'none' | 'daily' | 'weekdays' | 'weekly' | 'hourly'

/** standalone reminder (not tied to a meeting) */
export interface ReminderItem {
  id: string
  title: string
  notes?: string
  /** one-time: the day it rings · repeating: the day the series starts */
  date: string
  /** minutes from midnight, local (hourly: first ring of the day) */
  atMin: number
  /** one-time: already rang · repeating: series stopped by the user */
  fired: boolean
  repeat?: RepeatKind
  /** weekly (and optional hourly) days, 0=Sun..6=Sat */
  repeatDays?: number[]
  /** hourly: minutes between rings */
  intervalMin?: number
  /** hourly: last ring of the day (minutes from midnight) */
  untilMin?: number
  /** repeating: timestamp of the last occurrence that rang in-app */
  lastFiredAt?: number
  /** when the user pressed Stop — halts the minute-by-minute re-ring on all devices */
  alarmAckAt?: number
  /** one-time: the server's phone push is done (or no longer wanted) */
  pushFired?: boolean
  createdAt: number
}

/** where a journal entry was written (like the Apple Journal app) */
export interface JournalLocation {
  lat: number
  lng: number
  /** friendly place name, e.g. "Ahmedabad, Gujarat" */
  label?: string
}

/** a journal entry: a moment captured as photos + written or dictated text */
export interface JournalEntry {
  id: string
  text: string
  /** downscaled JPEG data URLs */
  photos: string[]
  location?: JournalLocation
  createdAt: number
  updatedAt?: number
  /** device cache only: photos weren't stored offline and haven't loaded from the cloud yet */
  photosOffline?: boolean
}

/** rich-text document saved by the notes editor (TipTap/ProseMirror JSON) */
export type NoteDoc = { type: 'doc'; content?: unknown[] }

/** a Notion-style note: an emoji, a title and block content */
export interface Note {
  id: string
  title: string
  /** emoji shown next to the title */
  icon?: string
  /** page cover: a gradient key ("g1"…"g8") or a small image data URL */
  cover?: string
  content: NoteDoc
  /** plain-text copy of the content, for search and list previews */
  plain?: string
  pinned?: boolean
  /** the page this one sits inside (pages can nest) */
  parentId?: string
  /** workspace this page belongs to; empty = the personal space */
  companyId?: string
  /** team page: every workspace member can read and edit it */
  shared?: boolean
  /** the meeting this page holds the notes for */
  meetingId?: string
  /** the task this page is attached to */
  taskId?: string
  createdBy?: string
  updatedBy?: string
  createdAt: number
  updatedAt: number
}

/** fields understood from a spoken sentence (Mig) — used to prefill forms */
export interface VoiceFields {
  type: string
  title?: string
  person?: string
  date?: string
  time?: string
  durationMin?: number
  priority?: string
  dueDate?: string
  notes?: string
  repeat?: string
  days?: number[]
  intervalMin?: number
  untilTime?: string
  text?: string
}

export type ThemeMode = 'light' | 'dark' | 'system'

export interface Settings {
  name: string
  timezone: string
  meetLink: string
  defaultDurationMin: number
  defaultReminderMin: ReminderMinutes
  workStartMin: number
  workEndMin: number
  theme: ThemeMode
  /** public booking page slug (/book/<slug>); generated on first sign-in */
  bookingSlug?: string
  bookingEnabled?: boolean
  /** public booking window (minutes from midnight, host-local) */
  bookingStartMin?: number
  bookingEndMin?: number
  /** weekdays bookable via the public link; 0=Sun..6=Sat */
  bookingDays?: number[]
  /** the workspace open on this account (cloud mode) */
  activeCompanyId?: string
}

export type ViewId = 'dashboard' | 'calendar' | 'tasks' | 'reminders' | 'journal' | 'notes' | 'meetings' | 'availability' | 'team' | 'settings' | 'plan' | 'chat'
export type CalendarMode = 'day' | 'week' | 'month'
