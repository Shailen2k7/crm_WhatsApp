/**
 * The app's main places. Each sidebar item is a section; related pages sit
 * inside it as tabs (Tasks → Tasks · Plan my day), so nothing
 * was removed, just grouped where people expect it.
 */
import { BellRing, CalendarDays, FileText, House, ListTodo, MessageCircle, Users, Video } from 'lucide-react'
import type { ViewId } from '../types'

export type SectionId = 'home' | 'tasks' | 'reminders' | 'meetings' | 'calendar' | 'notes' | 'chat' | 'team'

export interface Section {
  id: SectionId
  label: string
  icon: typeof House
  /** the pages inside, first one opens by default */
  tabs: { view: ViewId; label: string; hint: string }[]
  companyOnly?: boolean
}

export const SECTIONS: Section[] = [
  { id: 'home', label: 'Home', icon: House, tabs: [{ view: 'dashboard', label: 'Home', hint: 'Your day at a glance' }] },
  {
    id: 'tasks',
    label: 'Tasks',
    icon: ListTodo,
    tabs: [
      { view: 'tasks', label: 'Tasks', hint: 'Everything to do, as a list or a board' },
      { view: 'plan', label: 'Plan my day', hint: 'Put your tasks into today’s hours' }
    ]
  },
  { id: 'reminders', label: 'Reminders', icon: BellRing, tabs: [{ view: 'reminders', label: 'Reminders', hint: 'Things that ring at a time' }] },
  {
    id: 'meetings',
    label: 'Meetings',
    icon: Video,
    tabs: [
      { view: 'meetings', label: 'Meetings', hint: 'Book, join and look back' },
      { view: 'availability', label: 'Booking & hours', hint: 'When people can book you' }
    ]
  },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays, tabs: [{ view: 'calendar', label: 'Calendar', hint: 'Meetings, reminders and planned time' }] },
  {
    id: 'notes',
    label: 'Notes',
    icon: FileText,
    tabs: [
      { view: 'notes', label: 'Pages', hint: 'Docs, meeting notes and plans' },
      { view: 'journal', label: 'Journal', hint: 'Your private diary' }
    ]
  },
  { id: 'chat', label: 'Chat', icon: MessageCircle, companyOnly: true, tabs: [{ view: 'chat', label: 'Chat', hint: 'Message anyone in the workspace' }] },
  { id: 'team', label: 'Team', icon: Users, companyOnly: true, tabs: [{ view: 'team', label: 'Team', hint: 'People, invites and team pages' }] }
]

/** which section a page lives in (Settings sits outside, in the profile menu) */
export const sectionOf = (view: ViewId): Section | undefined => SECTIONS.find((s) => s.tabs.some((t) => t.view === view))
