/**
 * DEV-ONLY sample data, for previewing the app with realistic content.
 *
 *   http://localhost:5173/app?sample=1       → adds sample journal, meetings, tasks, reminders
 *   http://localhost:5173/app?sample=remove  → removes ONLY those sample items
 *
 * Purely additive: existing items are never touched. Every sample id starts
 * with "sample-" so re-running doesn't duplicate and removal is exact.
 * Loaded only by `import.meta.env.DEV` builds and refused when a real
 * database is connected, so it can never reach production data.
 */
import { useStore } from '../store/useStore'
import { isSupabaseEnabled } from './supabase'
import { useWorkspace } from './workspace'
import { useAuth } from './auth'
import { useChat } from './chat'
import type { ChatMessage, Conversation, JournalEntry, Meeting, NoteDoc, ReminderItem, Task } from '../types'

const PREFIX = 'sample-'

/* ---------- painted placeholder photos (canvas, no files) ---------- */

type Ctx2D = CanvasRenderingContext2D
const W = 1200
const H = 800
let seed = 42
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647

const canvas = (w = W, h = H): [HTMLCanvasElement, Ctx2D] => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d') as Ctx2D]
}
const grad = (x: Ctx2D, stops: [number, string][], x0: number, y0: number, x1: number, y1: number) => {
  const g = x.createLinearGradient(x0, y0, x1, y1)
  stops.forEach(([o, c]) => g.addColorStop(o, c))
  return g
}
const hills = (x: Ctx2D, w: number, h: number, base: number, amp: number, col: string, k = 1) => {
  x.fillStyle = col
  x.beginPath()
  x.moveTo(0, h)
  for (let i = 0; i <= w; i += 20) x.lineTo(i, base + Math.sin((i / 180) * k) * amp + Math.sin(i / 63 + k) * amp * 0.35)
  x.lineTo(w, h)
  x.closePath()
  x.fill()
}
const jpg = (c: HTMLCanvasElement) => c.toDataURL('image/jpeg', 0.8)

const PAINT: Record<string, () => string> = {
  sunset: () => {
    const [c, x] = canvas()
    x.fillStyle = grad(x, [[0, '#2b1e5a'], [0.45, '#e2557a'], [0.62, '#f9a861']], 0, 0, 0, H * 0.62)
    x.fillRect(0, 0, W, H)
    x.fillStyle = '#ffd58a'
    x.beginPath()
    x.arc(W * 0.55, H * 0.58, 70, 0, 7)
    x.fill()
    x.fillStyle = grad(x, [[0, '#3a2f6b'], [1, '#120f2e']], 0, H * 0.6, 0, H)
    x.fillRect(0, H * 0.6, W, H * 0.4)
    for (let i = 0; i < 40; i++) {
      x.fillStyle = `rgba(255,200,140,${0.15 + rnd() * 0.4})`
      x.fillRect(W * 0.55 - 120 + rnd() * 240, H * 0.62 + i * 7, 40 + rnd() * 80, 2)
    }
    return jpg(c)
  },
  mountains: () => {
    const [c, x] = canvas()
    x.fillStyle = grad(x, [[0, '#9fd3f0'], [1, '#e8f4fb']], 0, 0, 0, H)
    x.fillRect(0, 0, W, H)
    hills(x, W, H, H * 0.45, 90, '#8aa6c8', 2)
    hills(x, W, H, H * 0.58, 70, '#5d7aa6', 3.3)
    hills(x, W, H, H * 0.72, 50, '#2f4a6e', 1.7)
    return jpg(c)
  },
  city: () => {
    const [c, x] = canvas()
    x.fillStyle = grad(x, [[0, '#0b1030'], [1, '#3b2a6e']], 0, 0, 0, H)
    x.fillRect(0, 0, W, H)
    for (let i = 0; i < 120; i++) {
      x.fillStyle = `rgba(255,255,255,${rnd() * 0.8})`
      x.fillRect(rnd() * W, rnd() * H * 0.45, 2, 2)
    }
    let px = 0
    while (px < W) {
      const bw = 50 + rnd() * 90
      const bh = 180 + rnd() * 380
      x.fillStyle = '#141a3c'
      x.fillRect(px, H - bh, bw, bh)
      for (let wy = H - bh + 14; wy < H - 10; wy += 22)
        for (let wx = px + 8; wx < px + bw - 10; wx += 16)
          if (rnd() > 0.45) {
            x.fillStyle = rnd() > 0.5 ? '#ffd27a' : '#a7c4ff'
            x.fillRect(wx, wy, 7, 10)
          }
      px += bw + 4
    }
    return jpg(c)
  },
  forest: () => {
    const [c, x] = canvas()
    x.fillStyle = grad(x, [[0, '#d8f0d2'], [1, '#7fb98a']], 0, 0, 0, H)
    x.fillRect(0, 0, W, H)
    ;['#5d9a6c', '#3b7752', '#1f4d36'].forEach((col, layer) => {
      for (let i = 0; i < 14; i++) {
        const tx = rnd() * W
        const th = 200 + layer * 90 + rnd() * 120
        const ty = H - 60 + layer * 20
        x.fillStyle = col
        x.beginPath()
        x.moveTo(tx, ty - th)
        x.lineTo(tx - 45 - layer * 10, ty)
        x.lineTo(tx + 45 + layer * 10, ty)
        x.fill()
      }
    })
    x.fillStyle = '#1a3a28'
    x.fillRect(0, H - 40, W, 40)
    return jpg(c)
  },
  coffee: () => {
    const [c, x] = canvas()
    x.fillStyle = grad(x, [[0, '#f3e6d6'], [1, '#d9bfa0']], 0, 0, 0, H)
    x.fillRect(0, 0, W, H)
    x.fillStyle = '#b98d63'
    x.fillRect(0, 560, W, 240)
    x.fillStyle = '#fffaf3'
    x.beginPath()
    x.ellipse(600, 600, 250, 60, 0, 0, 7)
    x.fill()
    x.fillStyle = '#ffffff'
    x.fillRect(450, 340, 300, 250)
    x.beginPath()
    x.ellipse(600, 340, 150, 40, 0, 0, 7)
    x.fill()
    x.fillStyle = '#6b3f22'
    x.beginPath()
    x.ellipse(600, 345, 130, 30, 0, 0, 7)
    x.fill()
    x.strokeStyle = '#fff'
    x.lineWidth = 26
    x.beginPath()
    x.arc(770, 460, 62, -1.3, 1.3)
    x.stroke()
    return jpg(c)
  },
  beach: () => {
    const [c, x] = canvas()
    x.fillStyle = grad(x, [[0, '#7fd0f0'], [1, '#c9ecf8']], 0, 0, 0, H * 0.5)
    x.fillRect(0, 0, W, H * 0.5)
    x.fillStyle = grad(x, [[0, '#1b9fc4'], [1, '#57c7d9']], 0, H * 0.5, 0, H * 0.68)
    x.fillRect(0, H * 0.5, W, H * 0.18)
    x.fillStyle = '#f1dcae'
    x.fillRect(0, H * 0.68, W, H * 0.32)
    x.fillStyle = '#fff'
    x.beginPath()
    x.arc(980, 130, 60, 0, 7)
    x.fill()
    x.fillStyle = '#e25d5d'
    x.beginPath()
    x.moveTo(300, 520)
    x.lineTo(160, 600)
    x.lineTo(440, 600)
    x.fill()
    x.fillStyle = '#5b4636'
    x.fillRect(296, 520, 8, 180)
    return jpg(c)
  },
  aurora: () => {
    const [c, x] = canvas()
    x.fillStyle = grad(x, [[0, '#050a1f'], [1, '#10284a']], 0, 0, 0, H)
    x.fillRect(0, 0, W, H)
    x.globalCompositeOperation = 'lighter'
    for (let b = 0; b < 4; b++) {
      x.strokeStyle = `rgba(${b % 2 ? '90,255,180' : '120,140,255'},0.16)`
      x.lineWidth = 80
      x.beginPath()
      for (let i = 0; i <= W; i += 30) x.lineTo(i, 220 + b * 40 + Math.sin(i / 160 + b) * 70)
      x.stroke()
    }
    x.globalCompositeOperation = 'source-over'
    hills(x, W, H, H * 0.75, 40, '#06101f', 2.4)
    return jpg(c)
  },
  desk: () => {
    const [c, x] = canvas()
    x.fillStyle = '#e9e4dc'
    x.fillRect(0, 0, W, H)
    x.fillStyle = '#2a2d45'
    x.fillRect(280, 170, 640, 400)
    x.fillStyle = grad(x, [[0, '#7b73f9'], [1, '#14b8cd']], 300, 190, 900, 550)
    x.fillRect(300, 190, 600, 360)
    x.fillStyle = '#1f2135'
    x.fillRect(240, 570, 720, 26)
    x.fillStyle = '#4f8a5b'
    x.beginPath()
    x.ellipse(1040, 520, 60, 90, 0, 0, 7)
    x.fill()
    x.fillStyle = '#c9764f'
    x.fillRect(1000, 560, 80, 90)
    return jpg(c)
  },
  dunes: () => {
    const [c, x] = canvas()
    x.fillStyle = grad(x, [[0, '#ffcf8f'], [1, '#ffe9c7']], 0, 0, 0, H * 0.5)
    x.fillRect(0, 0, W, H)
    hills(x, W, H, H * 0.5, 60, '#e9a95c', 1.2)
    hills(x, W, H, H * 0.62, 70, '#d98d43', 2.1)
    hills(x, W, H, H * 0.78, 50, '#b86d2c', 1.5)
    return jpg(c)
  },
  flowers: () => {
    const [c, x] = canvas()
    x.fillStyle = grad(x, [[0, '#fde2e8'], [1, '#f7c2d0']], 0, 0, 0, H)
    x.fillRect(0, 0, W, H)
    for (let i = 0; i < 10; i++) {
      const fx = 120 + rnd() * 960
      const fy = 160 + rnd() * 460
      x.strokeStyle = '#5b9a6a'
      x.lineWidth = 6
      x.beginPath()
      x.moveTo(fx, fy)
      x.lineTo(fx, H)
      x.stroke()
      x.fillStyle = ['#ff6f91', '#ffb347', '#c18cff', '#ff8fab'][i % 4]
      for (let p = 0; p < 6; p++) {
        x.beginPath()
        x.ellipse(fx + Math.cos(p) * 28, fy + Math.sin(p) * 28, 24, 14, p, 0, 7)
        x.fill()
      }
      x.fillStyle = '#ffd35a'
      x.beginPath()
      x.arc(fx, fy, 14, 0, 7)
      x.fill()
    }
    return jpg(c)
  }
}

/* ---------- the sample content ---------- */

const dayKey = (offset: number) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const ago = (days: number, h: number, m: number) => {
  const t = new Date()
  t.setDate(t.getDate() - days)
  t.setHours(h, m, 0, 0)
  return t.getTime()
}

const JOURNAL: [string, number, number, number, string, string[]][] = [
  ['j1', 0, 7, 40, 'Sunrise run by the lake — 6 km before work. Cleared my head before the big product review today.', ['mountains']],
  ['j2', 0, 13, 10, 'Team lunch to celebrate the Pacifica deal closing. Wei joined on video from Singapore. Proud of this team!', ['desk', 'coffee']],
  ['j3', 1, 21, 5, 'Quiet Sunday evening. Finished "The Psychology of Money" — the chapter on enough really stuck with me. Three things I am grateful for: family, health, the new office.', []],
  ['j4', 1, 18, 30, 'Sunset at the beach with the kids. They built a sandcastle with a moat and a "VIP parking" lot.', ['beach', 'sunset']],
  ['j5', 2, 10, 15, 'Visited the Dholera industrial site. Road access is excellent; the price per sq. yard is fair. Need to compare with the Sanand option before Friday.', ['dunes']],
  ['j6', 3, 8, 20, 'Best flat white in town at the new café on CG Road. Planned the Q4 roadmap on a napkin — will turn it into slides tomorrow.', ['coffee']],
  ['j7', 4, 22, 45, 'Late night at the office, skyline looked unreal. Shipped the booking-link feature — 14 meetings booked through it on day one.', ['city']],
  ['j8', 5, 16, 0, 'Weekend hike through the forest trail. No phone signal for 4 hours and it was perfect.', ['forest', 'mountains', 'flowers']],
  ['j9', 6, 6, 30, "Mom's garden is in full bloom. She insisted I take some marigolds home.", ['flowers']],
  ['j10', 7, 23, 10, 'Watched a documentary on the northern lights — adding Norway to the 2027 travel list. Goal: save 15% more each month.', ['aurora']],
  ['j11', 8, 19, 20, 'Weekly reflection: closed 12 tasks, 9 meetings, missed the gym twice. Next week: protect mornings for deep work.', []]
]

const MEETINGS: Omit<Meeting, 'meetLink' | 'reminderMin' | 'remindersFired' | 'createdAt'>[] = [
  { id: 'm1', title: 'Q4 Roadmap Planning', personName: 'Priya Sharma', personEmail: 'priya@example.com', date: dayKey(1), startMin: 600, durationMin: 60, type: 'internal', notes: 'Finalise OKRs and hiring plan.' },
  { id: 'm2', title: 'Dholera Site Discussion', personName: 'Rajesh Patel', personEmail: 'rajesh@example.com', date: dayKey(1), startMin: 900, durationMin: 45, type: 'client', notes: 'Compare Dholera vs Sanand plots, pricing per sq. yard.' },
  { id: 'm3', title: 'Investor Update Call', personName: 'Sarah Mitchell', personEmail: 'sarah@example.com', date: dayKey(2), startMin: 1110, durationMin: 30, type: 'international', notes: 'Share September metrics and runway.' },
  { id: 'm4', title: 'Design Review — Journal', personName: 'Mansi Desai', personEmail: 'mansi@example.com', date: dayKey(3), startMin: 690, durationMin: 45, type: 'internal', notes: 'Review card grid, composer and ringtone UX.' },
  { id: 'm5', title: 'Partnership Kickoff', personName: 'Daniel Kim', personEmail: 'daniel@example.com', date: dayKey(4), startMin: 540, durationMin: 60, type: 'partner', notes: 'APAC distribution agreement — first steps.' },
  { id: 'm6', title: 'Coffee with Arjun', personName: 'Arjun Mehta', personEmail: 'arjun@example.com', date: dayKey(6), startMin: 510, durationMin: 30, type: 'personal', notes: 'Catch-up at the CG Road café.' },
  { id: 'm7', title: 'Vendor Negotiation', personName: 'Kavita Rao', personEmail: 'kavita@example.com', date: dayKey(-2), startMin: 840, durationMin: 30, type: 'client', notes: 'Agreed 12% discount on the annual contract.' },
  { id: 'm8', title: 'Weekly Team Standup', personName: 'Engineering Team', personEmail: 'eng@example.com', date: dayKey(-3), startMin: 570, durationMin: 30, type: 'internal', notes: 'Shipped booking links; journal next.' }
]

const TASKS: Omit<Task, 'createdAt'>[] = [
  { id: 't1', title: 'Prepare investor update deck', notes: 'September metrics + runway slide.', priority: 'high', done: false, dueDate: dayKey(1) },
  { id: 't2', title: 'Compare Dholera vs Sanand plot pricing', notes: 'Per sq. yard, road access, zoning.', priority: 'high', done: false, dueDate: dayKey(0) },
  { id: 't3', title: 'Review Journal designs', priority: 'medium', done: false, dueDate: dayKey(2) },
  { id: 't4', title: 'Renew car insurance', priority: 'medium', done: false, dueDate: dayKey(-1) },
  { id: 't5', title: 'Book flights for Singapore trip', notes: 'Prefer a morning flight, window seat.', priority: 'medium', done: false, dueDate: dayKey(5) },
  { id: 't6', title: 'Send thank-you note to Kavita', priority: 'low', done: false, dueDate: dayKey(0) },
  { id: 't7', title: 'Read "Atomic Habits" chapter 4', priority: 'low', done: false },
  { id: 't8', title: 'Plan Norway 2027 trip budget', priority: 'low', done: false },
  { id: 't9', title: 'Update team OKR sheet', priority: 'medium', done: true, dueDate: dayKey(-1), completedAt: Date.now() - 5 * 3_600_000 },
  { id: 't10', title: 'Pay electricity bill', priority: 'high', done: true, dueDate: dayKey(-2), completedAt: Date.now() - 26 * 3_600_000 }
]

const REMINDERS: Omit<ReminderItem, 'createdAt' | 'fired'>[] = [
  { id: 'r1', title: 'Drink a glass of water', repeat: 'hourly', intervalMin: 60, untilMin: 21 * 60, date: dayKey(0), atMin: 540 },
  { id: 'r2', title: 'Pick up the kids from school', repeat: 'weekdays', date: dayKey(0), atMin: 900 },
  { id: 'r3', title: 'Take vitamins', repeat: 'daily', date: dayKey(0), atMin: 480 },
  { id: 'r4', title: 'Call mom', repeat: 'weekly', repeatDays: [0], date: dayKey(0), atMin: 1080 },
  { id: 'r5', title: 'Gym — leg day', repeat: 'weekly', repeatDays: [1, 3, 5], date: dayKey(0), atMin: 390 },
  { id: 'r6', title: 'Send the investor deck to Sarah', notes: 'Attach September metrics.', date: dayKey(1), atMin: 1020 },
  { id: 'r7', title: 'Pay credit card bill', date: dayKey(3), atMin: 600 },
  { id: 'r8', title: "Arjun's birthday — send wishes", date: dayKey(6), atMin: 540 }
]

/* ---------- notes (Notion-style pages) ---------- */

const PARA = (text: string) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })
const HEAD = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] })
const TODO = (items: [string, boolean][]) => ({
  type: 'taskList',
  content: items.map(([text, checked]) => ({ type: 'taskItem', attrs: { checked }, content: [PARA(text)] }))
})
const UL = (items: string[]) => ({ type: 'bulletList', content: items.map((t) => ({ type: 'listItem', content: [PARA(t)] })) })
const QUOTE = (text: string) => ({ type: 'blockquote', content: [PARA(text)] })
const doc = (...content: unknown[]): NoteDoc => ({ type: 'doc', content })
const plainOf = (d: NoteDoc): string => {
  const walk = (n: unknown): string => {
    const x = n as { text?: string; content?: unknown[] }
    return x.text ?? (x.content ?? []).map(walk).join(' ')
  }
  return walk(d).replace(/\s+/g, ' ').trim()
}

const NOTES: [string, string, string, boolean, number, NoteDoc][] = [
  [
    'n1', 'Q4 launch plan', '🚀', true, 2,
    doc(
      HEAD(2, 'Goal'),
      PARA('Ship the booking link to every customer by the end of November, with zero regressions on reminders.'),
      HEAD(2, 'Milestones'),
      TODO([['Finalise pricing page copy', true], ['Email templates signed off', true], ['Beta with 20 customers', false], ['Public launch post', false]]),
      HEAD(2, 'Risks'),
      UL(['Calendar invites arriving late on some mail apps', 'Support load in the first week']),
      QUOTE('Launch when it is boring, not when it is exciting.')
    )
  ],
  [
    'n2', '1:1 with Priya — 28 Oct', '💬', false, 26,
    doc(
      PARA('Priya is covering the sales pipeline review while James is out.'),
      HEAD(3, 'Talked about'),
      UL(['Hiring: two interviews next week', 'Northwind renewal is on track', 'She wants more time for the onboarding deck']),
      HEAD(3, 'Actions'),
      TODO([['Send her the Q3 numbers', false], ['Book the onboarding workshop', false]])
    )
  ],
  [
    'n3', 'Reading list', '📚', false, 120,
    doc(
      UL(['Shape Up — Basecamp', 'The Mom Test — Rob Fitzpatrick', 'Working Backwards — Bryar & Carr']),
      PARA(''),
      PARA('Next: something on pricing.')
    )
  ]
]

/* ---------- apply / remove ---------- */

const addSample = () => {
  const s = useStore.getState()
  const now = Date.now()
  const has = (list: { id: string }[], id: string) => list.some((x) => x.id === PREFIX + id)
  const link = s.settings.meetLink || undefined
  let n = 0

  for (const [id, d, h, m, text, photos] of JOURNAL) {
    if (has(s.journal, id)) continue
    const entry: JournalEntry = { id: PREFIX + id, text, photos: photos.map((p) => PAINT[p]()), createdAt: ago(d, h, m) }
    s.addJournalEntry(entry)
    n++
  }
  for (const [id, title, icon, pinned, hoursAgo, content] of NOTES) {
    if (has(s.notes, id)) continue
    const at = now - hoursAgo * 3_600_000
    s.addNote({ id: PREFIX + id, title, icon, pinned, content, plain: plainOf(content), createdAt: at - 86_400_000, updatedAt: at })
    n++
  }
  for (const m of MEETINGS) {
    if (has(s.meetings, m.id)) continue
    s.addMeeting({ ...m, id: PREFIX + m.id, meetLink: link, reminderMin: 15, remindersFired: [], createdAt: now })
    n++
  }
  for (const t of TASKS) {
    if (has(s.tasks, t.id)) continue
    s.addTask({ ...t, id: PREFIX + t.id, createdAt: now - 3 * 86_400_000 })
    n++
  }
  for (const r of REMINDERS) {
    if (has(s.reminders, r.id)) continue
    // lastFiredAt = now so repeating samples don't start ringing the moment they're added
    s.addReminderItem({ ...r, id: PREFIX + r.id, fired: false, createdAt: now, ...(r.repeat ? { lastFiredAt: now } : {}) })
    n++
  }
  return n
}

const removeSample = () => {
  const s = useStore.getState()
  const mine = (x: { id: string }) => x.id.startsWith(PREFIX)
  let n = 0
  s.journal.filter(mine).forEach((x) => (s.deleteJournalEntry(x.id), n++))
  s.notes.filter(mine).forEach((x) => (s.deleteNote(x.id), n++))
  s.meetings.filter(mine).forEach((x) => (s.deleteMeeting(x.id), n++))
  s.tasks.filter(mine).forEach((x) => (s.deleteTask(x.id), n++))
  s.reminders.filter(mine).forEach((x) => (s.deleteReminderItem(x.id), n++))
  return n
}

/**
 * ?team=demo — previews the team workspace screens in local mode with a
 * made-up company (people, teams, invites, updates). Nothing is saved.
 */
const addTeamDemo = () => {
  // the signed-in local account, so chat (which keys on the real user id) sees the same person
  const me = useAuth.getState().user?.id ?? useStore.getState().syncUserId ?? 'local-me'
  const ids = { priya: 'sample-u-priya', james: 'sample-u-james', wen: 'sample-u-wen', co: 'sample-co', sales: 'sample-t-sales', tech: 'sample-t-tech' }
  useWorkspace.setState({
    available: true,
    loaded: true,
    me,
    activeId: ids.co,
    workspaces: [
      { id: ids.co, name: 'Northwind Ltd', kind: 'company', role: 'admin', size: '11–50' },
      { id: 'sample-personal', name: 'My space', kind: 'personal', role: 'admin' }
    ],
    members: [
      { userId: me, name: 'Shailen Pathak', email: 'shailen@northwind.io', role: 'admin', teamIds: [ids.tech], joinedAt: Date.now() - 30 * 864e5 },
      { userId: ids.priya, name: 'Priya Sharma', email: 'priya@northwind.io', role: 'manager', teamIds: [ids.sales, ids.tech], joinedAt: Date.now() - 20 * 864e5 },
      { userId: ids.james, name: 'James Miller', email: 'james@northwind.io', role: 'member', teamIds: [ids.sales], joinedAt: Date.now() - 10 * 864e5 },
      { userId: ids.wen, name: 'Wen Li', email: 'wen@northwind.io', role: 'member', teamIds: [], joinedAt: Date.now() - 2 * 864e5 }
    ],
    teams: [
      { id: ids.sales, name: 'Sales', memberIds: [ids.priya, ids.james] },
      { id: ids.tech, name: 'Tech', memberIds: [me, ids.priya] }
    ],
    invites: [
      { id: 'sample-i1', email: 'amara@northwind.io', role: 'member', teamId: ids.sales, token: 'a'.repeat(64), status: 'pending', createdAt: Date.now() - 864e5, expiresAt: Date.now() + 13 * 864e5 },
      { id: 'sample-i2', email: '', role: 'manager', token: 'b'.repeat(64), status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 14 * 864e5 }
    ],
    pendingOn: true,
    pending: [{ id: 'sample-i1', email: 'amara@northwind.io', role: 'member', teamId: ids.sales, createdAt: Date.now() - 864e5 }],
    notifications: [
      { id: 'sample-n1', kind: 'task_assigned', title: 'Priya assigned you a task', body: 'Prepare the Q4 pricing deck', taskId: undefined, createdAt: Date.now() - 12 * 60e3 },
      { id: 'sample-n2', kind: 'task_comment', title: 'James commented on “Renew domain”', body: 'Done on my side — can you check DNS?', createdAt: Date.now() - 3 * 36e5, readAt: Date.now() - 36e5 },
      { id: 'sample-n3', kind: 'task_done', title: 'Wen completed a task', body: 'Share meeting notes', createdAt: Date.now() - 864e5, readAt: Date.now() - 864e5 }
    ]
  })
  // hand the existing tasks around the team so every tab has something in it
  const s = useStore.getState()
  const people = [me, ids.priya, ids.james, ids.wen]
  useStore.setState({
    tasks: s.tasks.map((t, i) => ({
      ...t,
      companyId: ids.co,
      createdBy: i % 3 === 0 ? ids.priya : me,
      assignedTo: people[i % 4],
      assignedBy: i % 4 === 0 ? me : i % 3 === 0 ? ids.priya : me,
      teamId: i % 2 ? ids.sales : ids.tech,
      status: t.done ? 'done' : i % 5 === 1 ? 'in_progress' : 'todo'
    }))
  })
  addChatDemo(me, ids)
}

/** sample chats for the ?team=demo preview: a DM, a group, the team channels and #general */
const addChatDemo = (me: string, ids: Record<string, string>) => {
  const now = Date.now()
  const min = (n: number) => now - n * 60e3
  const conv = (id: string, kind: Conversation['kind'], name: string, memberIds: string[], extra: Partial<Conversation> = {}): Conversation => ({
    id,
    companyId: ids.co,
    kind,
    name,
    createdAt: now - 20 * 864e5,
    memberIds,
    reads: Object.fromEntries(memberIds.map((u) => [u, now])),
    lastReadAt: now,
    unread: 0,
    muted: false,
    pinned: false,
    ...extra
  })
  const msg = (conversationId: string, senderId: string, body: string, at: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id: `sample-m-${conversationId}-${at}`,
    conversationId,
    senderId,
    body,
    createdAt: at,
    mentions: [],
    attachments: [],
    reactions: [],
    ...extra
  })
  const c = { general: 'sample-c-general', tech: 'sample-c-tech', sales: 'sample-c-sales', priya: 'sample-c-priya', wen: 'sample-c-wen', launch: 'sample-c-launch' }
  const messages: Record<string, ChatMessage[]> = {
    [c.priya]: [
      msg(c.priya, ids.priya, 'Morning! Did you get a chance to look at the Q4 pricing deck?', min(62)),
      msg(c.priya, me, 'Yes — the numbers on slide 4 look right now. One thing: can we add the annual plan?', min(58)),
      msg(c.priya, ids.priya, 'Good call. I’ll add it before the client call.', min(55), { reactions: [{ emoji: '👍', userIds: [me] }] }),
      msg(c.priya, ids.priya, 'Also, are you free at 3 for a quick sync? https://meet.google.com/abc-defg-hij', min(4)),
      msg(c.priya, ids.priya, 'No rush if you’re heads-down 🙂', min(3))
    ],
    [c.wen]: [
      msg(c.wen, me, 'Welcome to the team, Wen! Shout if anything is unclear.', min(60 * 26)),
      msg(c.wen, ids.wen, 'Thanks! Getting set up now. Where do the meeting notes live?', min(60 * 25)),
      msg(c.wen, me, 'Notes → Team pages. There’s one per client.', min(60 * 25 - 2), { reactions: [{ emoji: '🙏', userIds: [ids.wen] }] })
    ],
    [c.launch]: [
      msg(c.launch, ids.james, 'Launch checklist is in Notes. @Shailen Pathak can you own the domain renewal?', min(60 * 5), { mentions: [me] }),
      msg(c.launch, me, 'On it — renewing today.', min(60 * 5 - 6)),
      msg(c.launch, ids.priya, 'Design review moved to Thursday 11:00.', min(40))
    ],
    [c.tech]: [
      msg(c.tech, ids.priya, 'Deploy went out at 10:10. Watching the logs.', min(60 * 3)),
      msg(c.tech, me, 'All green on my side 🎉', min(60 * 3 - 5), { reactions: [{ emoji: '🎉', userIds: [ids.priya] }] })
    ],
    [c.sales]: [msg(c.sales, ids.james, 'Northwind renewal signed! 🥳', min(60 * 30), { reactions: [{ emoji: '🎉', userIds: [me, ids.priya, ids.wen] }, { emoji: '👏', userIds: [ids.priya] }] })],
    [c.general]: [
      msg(c.general, ids.priya, 'Reminder: office is closed Friday for the public holiday.', min(60 * 50)),
      msg(c.general, ids.wen, 'Hello everyone! Happy to be here 👋', min(60 * 24)),
      msg(c.general, me, 'Welcome Wen! 🎉', min(60 * 24 - 3))
    ]
  }
  const last = (id: string) => {
    const m = messages[id][messages[id].length - 1]
    return { lastMessageAt: m.createdAt, lastMessage: { id: m.id, senderId: m.senderId, body: m.body, createdAt: m.createdAt, deleted: false } }
  }
  const everyone = [me, ids.priya, ids.james, ids.wen]
  useChat.setState({
    companyId: ids.co,
    me,
    ready: true,
    connected: true,
    conversations: [
      conv(c.priya, 'dm', '', [me, ids.priya], { ...last(c.priya), unread: 2, lastReadAt: min(50), reads: { [me]: min(50), [ids.priya]: now } }),
      conv(c.launch, 'group', 'Launch week', [me, ids.priya, ids.james], { ...last(c.launch), unread: 1, lastReadAt: min(60 * 4), pinned: true }),
      conv(c.general, 'general', 'general', everyone, last(c.general)),
      conv(c.tech, 'team', 'Tech', [me, ids.priya], { ...last(c.tech), teamId: ids.tech }),
      conv(c.sales, 'team', 'Sales', [ids.priya, ids.james], { ...last(c.sales), teamId: ids.sales }),
      conv(c.wen, 'dm', '', [me, ids.wen], { ...last(c.wen), reads: { [me]: now, [ids.wen]: now } })
    ],
    messages,
    hasMore: {},
    presence: {
      [me]: { status: 'online', viewing: null, at: now },
      [ids.priya]: { status: 'online', meetingUntil: now + 25 * 60e3, viewing: null, at: now },
      [ids.james]: { status: 'online', viewing: null, at: now },
      [ids.wen]: { status: 'away', viewing: null, at: now }
    },
    lastSeen: { [ids.wen]: min(35) },
    dnd: {}
  })
  // sample people live in other time zones, for "9:40 PM for Wen"
  useWorkspace.setState((s) => ({
    members: s.members.map((m) => (m.userId === ids.wen ? { ...m, timezone: 'Asia/Shanghai' } : m.userId === ids.james ? { ...m, timezone: 'America/New_York' } : m.userId === ids.priya ? { ...m, timezone: 'Europe/London' } : m))
  }))
}

/** Reads ?sample=1 / ?sample=remove, applies it once, then cleans the URL. */
export const applySampleFromUrl = () => {
  const params = new URLSearchParams(window.location.search)
  if (params.get('team') === 'demo' && !isSupabaseEnabled) {
    params.delete('team')
    window.history.replaceState({}, '', window.location.pathname + (params.toString() ? `?${params}` : ''))
    addTeamDemo()
    useStore.getState().setView('team')
    console.info('[sample] team demo on (not saved)')
  }
  const mode = params.get('sample')
  if (!mode) return
  params.delete('sample')
  const qs = params.toString()
  window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
  if (isSupabaseEnabled) {
    // never write sample data into a real database
    console.warn('[sample] skipped: a real database is connected')
    return
  }
  if (mode === 'remove') {
    console.info(`[sample] removed ${removeSample()} sample items — your own data was not touched`)
    useStore.getState().setView('dashboard')
  } else {
    console.info(`[sample] added ${addSample()} sample items`)
    useStore.getState().setView('journal')
  }
}
