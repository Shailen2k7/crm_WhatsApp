import { lazy, Suspense, useEffect } from 'react'
import { useState } from 'react'
import { CalendarDays, Clock, FileText, LayoutGrid, MessageCircle, NotebookPen, Settings as SettingsIcon, Sunrise, Users, X } from 'lucide-react'
import { useStore } from './store/useStore'
import { hydrateFromRemote, syncFromCloud, useAuth } from './lib/auth'
import { generateBookingSlug } from './lib/booking'
import { fetchAll } from './lib/remote'
import { isSupabaseEnabled } from './lib/supabase'
import { listenForNotifications, refreshWorkspace, rememberInviteToken, useWorkspace } from './lib/workspace'
import { goToConversation, refreshChat, startChat, stopChat, useChat, useChatUnread } from './lib/chat'
import { showToast } from './lib/notify'
import type { ViewId } from './types'
import AuthView from './views/AuthView'
import HomePage from './views/HomePage'
import DashboardView from './views/DashboardView'
import TasksView from './views/TasksView'
import RemindersView from './views/RemindersView'
import JournalView from './views/JournalView'
// the notes editor is a sizeable chunk of code: loaded the first time Notes is opened
const NotesView = lazy(() => import('./views/NotesView'))
const PlanView = lazy(() => import('./views/PlanView'))
// chat: loaded the first time the Chat page opens (the live connection runs regardless)
const ChatView = lazy(() => import('./views/ChatView'))
import CalendarView from './views/CalendarView'
import MeetingsView from './views/MeetingsView'
import AvailabilityView from './views/AvailabilityView'
import SettingsView from './views/SettingsView'
import TeamView from './views/TeamView'
import WorkspaceSwitcher from './components/WorkspaceSwitcher'
import Wordmark from './components/Wordmark'
import { NewMenu, ProfileMenu, SectionTabs } from './components/SidebarMenus'
import { SECTIONS, sectionOf } from './lib/sections'
import ScheduleModal from './components/ScheduleModal'
import TaskModal from './components/TaskModal'
import ReminderModal from './components/ReminderModal'
import MigAI from './components/MigAI'
import { FabMenu } from './components/QuickActions'
import VoiceSheet from './components/VoiceSheet'
import MeetingDetails from './components/MeetingDetails'
import ReminderToasts from './components/ReminderToasts'
import AlarmScreen from './components/AlarmScreen'
import { fireAlert, startReminderEngine } from './lib/notify'
import { hideSplash } from './lib/splash'
import { format } from 'date-fns'
import { fromDateKey, meetingStart, minToLabel } from './lib/time'
import { listenForResubscribe, claimThisDevice } from './lib/push'

/** phone bottom bar: Home · Tasks · Reminders · Meetings + "More"; the sheet jumps straight to any page */
const MOBILE_MAIN = SECTIONS.filter((s) => s.id === 'home' || s.id === 'tasks' || s.id === 'reminders' || s.id === 'meetings')
const MOBILE_MORE: { id: ViewId; label: string; icon: typeof Users }[] = [
  { id: 'chat', label: 'Chat', icon: MessageCircle },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'notes', label: 'Notes', icon: FileText },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'plan', label: 'Plan my day', icon: Sunrise },
  { id: 'availability', label: 'Booking & hours', icon: Clock },
  { id: 'journal', label: 'Journal', icon: NotebookPen },
  { id: 'settings', label: 'Settings', icon: SettingsIcon }
]

/** /app?chat=<id> — a tapped chat notification or a shared link: open that chat once signed in */
const takeChatFromUrl = () => {
  const params = new URLSearchParams(window.location.search)
  const id = params.get('chat')
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return
  params.delete('chat')
  window.history.replaceState({}, '', window.location.pathname + (params.toString() ? `?${params}` : ''))
  useChat.setState({ pendingOpen: id })
}

/** /join/<token> — an invite link; remembered until the person has signed in */
const takeInviteFromUrl = () => {
  const m = window.location.pathname.match(/^\/join\/([a-zA-Z0-9]{20,80})\/?$/)
  if (!m) return false
  rememberInviteToken(m[1])
  window.history.replaceState({}, '', '/app')
  return true
}

const useTheme = (forceLight = false) => {
  const theme = useStore((s) => s.settings.theme)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const mode = forceLight ? 'light' : theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme
      document.documentElement.setAttribute('data-theme', mode)
      const meta = document.querySelector('meta[name="theme-color"]')
      meta?.setAttribute('content', mode === 'dark' ? '#15172b' : '#6C63F7')
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme, forceLight])
}

/** Track the on-screen keyboard (iOS/Android) so sheets and panels stay above it. */
const useKeyboardInset = () => {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const update = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      root.style.setProperty('--kb', `${Math.round(kb)}px`)
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
}

export default function App() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const scheduleOpen = useStore((s) => s.scheduleOpen)
  const detailsMeetingId = useStore((s) => s.detailsMeetingId)
  const taskEditor = useStore((s) => s.taskEditor)
  const reminderEditor = useStore((s) => s.reminderEditor)
  const user = useAuth((s) => s.user)
  const authReady = useAuth((s) => s.ready)
  const restore = useAuth((s) => s.restore)
  const signOut = useAuth((s) => s.signOut)
  const [landing, setLanding] = useState(() => !takeInviteFromUrl() && window.location.pathname === '/')
  const [moreOpen, setMoreOpen] = useState(false)
  const wsAvailable = useWorkspace((s) => s.available)
  const wsLoaded = useWorkspace((s) => s.loaded)
  // individual accounts look exactly as before: the switcher and Updates only
  // appear once someone belongs to a company, and Team only inside one
  const inCompany = useWorkspace((s) => s.available && s.workspaces.some((w) => w.kind === 'company'))
  const companyOpen = useWorkspace((s) => s.available && s.workspaces.find((w) => w.id === s.activeId)?.kind === 'company')
  const activeId = useWorkspace((s) => s.activeId)
  const chatUnread = useChatUnread()
  const chatOpen = useChat((s) => s.openId !== null)
  const nav = SECTIONS.filter((s) => !s.companyOnly || companyOpen)
  const mobileMore = MOBILE_MORE.filter((n) => (n.id !== 'team' && n.id !== 'chat') || companyOpen)
  const section = sectionOf(view)
  // phones: More lights up for Calendar, Notes, Team and Settings; Plan my day etc. stay under their own tab
  const inMore = !MOBILE_MAIN.some((s) => s.id === section?.id)
  // the marketing homepage is always light; the app follows the user's theme
  useTheme(landing && !user)
  useKeyboardInset()

  useEffect(() => {
    const onPop = () => setLanding(window.location.pathname === '/')
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Only the homepage belongs in search results. The server already sends a
  // noindex header for /app and friends; this keeps the meta tag and tab
  // title in step when the route changes without a reload.
  useEffect(() => {
    // the marketing homepage shows only to signed-out visitors at "/"
    const onHomepage = landing && !user
    document.title = onHomepage ? 'Taskorra \u2014 Meetings, Tasks, Reminders & Journal in One App' : chatUnread ? `(${chatUnread}) Taskorra` : 'Taskorra'
    let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]')
    if (!robots) {
      robots = document.createElement('meta')
      robots.name = 'robots'
      document.head.appendChild(robots)
    }
    robots.content = onHomepage ? 'index, follow, max-image-preview:large, max-snippet:-1' : 'noindex'
  }, [landing, user, chatUnread])

  useEffect(() => {
    void restore()
  }, [restore])

  // the app has decided what to show — let the launch splash go
  useEffect(() => {
    if (authReady) hideSplash()
  }, [authReady])

  useEffect(() => {
    if (user) {
      startReminderEngine()
      listenForResubscribe()
    }
  }, [user])

  // team updates arrive live ("Priya assigned you a task") and refresh the tasks
  useEffect(() => {
    if (!user || !wsAvailable) return
    return listenForNotifications(user.id, () => void syncFromCloud())
  }, [user, wsAvailable])

  // e.g. an invite link that could not be used
  useEffect(() => {
    if (!user || !wsLoaded) return
    const n = useWorkspace.getState().notice
    if (n) {
      useWorkspace.setState({ notice: null })
      showToast({ kind: 'task', title: 'Invite', body: n, tag: 'invite-notice' })
    }
  }, [user, wsLoaded])

  // Team and Chat only exist inside a company workspace (e.g. after switching to the personal one)
  useEffect(() => {
    if ((view === 'team' || view === 'chat') && !companyOpen && (wsLoaded || !isSupabaseEnabled)) setView('dashboard')
  }, [view, companyOpen, wsLoaded, setView])

  // chat runs whenever a company workspace is open: messages and presence
  // arrive live on every page, not only on the Chat page
  useEffect(() => {
    if (!user || !companyOpen || !activeId) {
      stopChat()
      return
    }
    takeChatFromUrl()
    startChat(activeId, user.id)
    return stopChat
  }, [user, companyOpen, activeId])

  // a tapped chat notification (service worker) → that chat; a push while the
  // app is open but asleep → fetch what arrived
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; id?: string } | null
      if (d?.type === 'open-chat' && d.id) goToConversation(d.id)
      else if (d?.type === 'chat-new') void refreshChat()
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  // notifications allowed from any form → this device gets app-closed alerts too
  useEffect(() => {
    if (!user) return
    const connect = () => void claimThisDevice().catch(() => {})
    window.addEventListener('msos:notifications-allowed', connect)
    return () => window.removeEventListener('msos:notifications-allowed', connect)
  }, [user])

  // dev only: ?sample=1 loads preview data, ?sample=remove takes it out again
  useEffect(() => {
    if (import.meta.env.DEV && user) void import('./lib/devSample').then((m) => m.applySampleFromUrl())
  }, [user])


  // Ensure every signed-in user has a booking link
  const bookingSlug = useStore((s) => s.settings.bookingSlug)
  useEffect(() => {
    if (user && !bookingSlug) {
      useStore.getState().updateSettings({
        bookingSlug: generateBookingSlug(user.name),
        bookingEnabled: true
      })
    }
  }, [user, bookingSlug])

  // Cloud mode: pick up bookings made via the public link while the app is open
  useEffect(() => {
    if (!user || !isSupabaseEnabled) return
    const refresh = async () => {
      if (document.hidden) return
      const data = await fetchAll({ journal: false }) // photos are not re-downloaded every minute
      if (data && !data.isEmpty) {
        const s = useStore.getState()
        // meetings that just arrived from Migrizo CRM → a heads-up on this device
        const known = new Set(s.meetings.filter((m) => m.source === 'crm').map((m) => m.externalId))
        const arrived = data.meetings.filter(
          (m) => m.source === 'crm' && !known.has(m.externalId) && meetingStart(m.date, m.startMin).getTime() > Date.now()
        )
        if (arrived.length === 1) {
          const m = arrived[0]
          fireAlert({
            kind: 'scheduled',
            title: m.title,
            body: `New meeting from Migrizo CRM · ${format(fromDateKey(m.date), 'EEE d MMM')}, ${minToLabel(m.startMin)}`,
            meetLink: m.meetLink,
            tag: `crm-${m.externalId}`
          })
        } else if (arrived.length > 1) {
          fireAlert({
            kind: 'scheduled',
            title: `${arrived.length} new meetings`,
            body: 'From Migrizo CRM · added to your calendar',
            tag: `crm-batch-${Date.now()}`
          })
        }
        hydrateFromRemote(data)
      }
      void refreshWorkspace()
    }
    const t = setInterval(() => void refresh(), 60_000)
    const onVisible = () => {
      if (!document.hidden) void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [user])

  if (!authReady) return null
  if (!user) {
    if (landing) {
      return (
        <HomePage
          onStart={() => {
            window.history.pushState({}, '', '/app')
            setLanding(false)
          }}
        />
      )
    }
    return <AuthView />
  }

  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className={`app${view === 'chat' ? ' view-chat' : ''}${view === 'chat' && chatOpen ? ' chat-open' : ''}`}>
      <div className="sidebar-slot">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <span className="brand-mark"><img src="/icons/taskorra-logo.png" alt="" /></span>
            <Wordmark className="sb-label" />
          </div>
          {inCompany && <WorkspaceSwitcher />}
          <div className="sb-nav">
            {nav.map(({ id, label, icon: Icon, tabs }) => (
              <button
                key={id}
                className={`nav-item${section?.id === id ? ' active' : ''}`}
                onClick={() => setView(tabs[0].view)}
                aria-label={label}
                aria-current={section?.id === id ? 'page' : undefined}
              >
                <span className="nav-ico">
                  <Icon size={18} strokeWidth={2.1} />
                  {id === 'chat' && chatUnread > 0 && <span className="nav-badge">{chatUnread > 99 ? '99+' : chatUnread}</span>}
                </span>
                <span className="sb-label">{label}</span>
              </button>
            ))}
          </div>
          <div className="sidebar-spacer" />
          <NewMenu />
          <ProfileMenu name={user.name} email={user.email} initials={initials} onSignOut={signOut} />
        </aside>
      </div>

      <main className={`main${section && section.tabs.length > 1 ? ' has-tabs' : ''}`}>
        <SectionTabs view={view} />
        {view === 'dashboard' && <DashboardView />}
        {view === 'calendar' && <CalendarView />}
        {view === 'tasks' && <TasksView />}
        {view === 'plan' && (
          <Suspense fallback={null}>
            <PlanView />
          </Suspense>
        )}
        {view === 'reminders' && <RemindersView />}
        {view === 'journal' && <JournalView />}
        {view === 'notes' && (
          <Suspense fallback={null}>
            <NotesView />
          </Suspense>
        )}
        {view === 'meetings' && <MeetingsView />}
        {view === 'availability' && <AvailabilityView />}
        {view === 'team' && companyOpen && <TeamView />}
        {view === 'chat' && companyOpen && (
          <Suspense fallback={null}>
            <ChatView />
          </Suspense>
        )}
        {view === 'settings' && <SettingsView />}
      </main>

      <nav className="bottomnav">
        {MOBILE_MAIN.map(({ id, label, icon: Icon, tabs }) => {
          const on = !moreOpen && section?.id === id
          return (
            <button
              key={id}
              className={on ? 'active' : ''}
              onClick={() => {
                setMoreOpen(false)
                setView(tabs[0].view)
              }}
              aria-label={label}
            >
              <Icon size={21} strokeWidth={on ? 2.4 : 2} />
              {label}
            </button>
          )
        })}
        <button className={moreOpen || inMore ? 'active' : ''} onClick={() => setMoreOpen(!moreOpen)} aria-label={`More${chatUnread ? `, ${chatUnread} new messages` : ''}`}>
          <span className="nav-ico">
            <LayoutGrid size={21} strokeWidth={moreOpen || inMore ? 2.4 : 2} />
            {chatUnread > 0 && <span className="nav-badge">{chatUnread > 99 ? '99+' : chatUnread}</span>}
          </span>
          More
        </button>
      </nav>

      {moreOpen && (
        <div className="morenav" onClick={() => setMoreOpen(false)}>
          <div className="morenav-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="morenav-head">
              <span>More</span>
              <button onClick={() => setMoreOpen(false)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="morenav-grid">
              {mobileMore.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={view === id ? 'on' : ''}
                  onClick={() => {
                    setView(id)
                    setMoreOpen(false)
                  }}
                >
                  <span className="morenav-ico">
                    <Icon size={20} strokeWidth={2.1} />
                    {id === 'chat' && chatUnread > 0 && <span className="nav-badge">{chatUnread > 99 ? '99+' : chatUnread}</span>}
                  </span>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <FabMenu />

      <MigAI />
      {scheduleOpen && <ScheduleModal />}
      {taskEditor && <TaskModal key={taskEditor} />}
      {reminderEditor && <ReminderModal key={reminderEditor} />}
      {detailsMeetingId && <MeetingDetails meetingId={detailsMeetingId} />}
      <ReminderToasts />
      <AlarmScreen />
      <VoiceSheet />
    </div>
  )
}
