// Scheduled: every minute, pushes to all registered devices — works with the app closed.
//
//  Meetings   → three reminders: 1 hour, 30 minutes and 5 minutes before.
//  Reminders  → one notification at the reminder's time (a snoozed reminder gets
//               one more at its snooze time). No repeating.
//  Tasks      → two digests on the due day: morning (9–12) and afternoon (16–19).
//  Assigned   → when someone hands you a task: a push and an email, once
//               (several at once are grouped into one).
//
// Each section is independent — a failure in one never blocks the others.
import { env, rest, restGet, sendToSubs, wallLabel, wallToUtc } from '../lib/push-core.mjs'
import { emailConfigured, emailLayout, escapeHtml as esc, sendEmail } from '../lib/mailer.mjs'

const MEETING_STEPS = [
  { min: 60, key: 'r60', lead: 'Meeting in 1 hour' },
  { min: 30, key: 'r30', lead: 'Meeting in 30 min' },
  { min: 5, key: 'r5', lead: 'Meeting starting now' }
]
// a reminder is sent ONCE, but may go out up to 15 min late if a scheduled run was delayed — late beats never
const SEND_WINDOW_MS = 15 * 60_000
const MEETING_WINDOW_MS = 5 * 60_000

export default async () => {
  const cfg = env()
  if (!cfg) return new Response('push not configured', { status: 200 })

  const now = Date.now()
  const dateKey = (d) => d.toISOString().slice(0, 10)
  const from = dateKey(new Date(now - 86_400_000))
  const to = dateKey(new Date(now + 86_400_000))
  const stats = { meetings: 0, alarms: 0, digests: 0, assigned: 0, emails: 0, sent: 0, errors: [] }
  const section = async (name, fn) => {
    try {
      await fn()
    } catch (err) {
      stats.errors.push(`${name}: ${err?.message ?? err}`)
    }
  }

  // ---- shared: timezones + subscriptions are fetched lazily, once ----
  let tzByUser = null
  const tzOf = async (uid) => {
    if (!tzByUser) {
      const settings = await restGet(cfg, `settings?select=user_id,timezone`)
      tzByUser = new Map(settings.map((s) => [s.user_id, s.timezone || 'UTC']))
    }
    return tzByUser.get(uid) ?? 'UTC'
  }
  let subsAll = null
  const subsOf = async (uid) => {
    if (!subsAll) subsAll = await restGet(cfg, `push_subscriptions?select=endpoint,subscription,user_id`)
    return subsAll.filter((s) => s.user_id === uid)
  }
  const push = async (uid, payload) => {
    const mine = await subsOf(uid)
    if (mine.length) stats.sent += await sendToSubs(cfg, mine, payload)
  }
  const nowInTz = (tz) => {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(new Date(now)).map((p) => [p.type, p.value])
      )
      return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        min: (parts.hour === '24' ? 0 : Number(parts.hour)) * 60 + Number(parts.minute)
      }
    } catch {
      const d = new Date(now)
      return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }
    }
  }
  const clock = (tz, date, min) => wallLabel(date, min).split(', ').pop() // "3:00 PM" (the day label itself contains a comma)

  // ================= meetings: 1 h · 30 min · 5 min =================
  await section('meetings', async () => {
    const meetings = await restGet(
      cfg,
      `meetings?select=*&reminder_min=not.is.null&date=gte.${from}&date=lte.${to}`
    )
    for (const m of meetings ?? []) {
      const sentKeys = Array.isArray(m.push_sent) ? m.push_sent : []
      if (sentKeys.length >= MEETING_STEPS.length) continue
      const tz = await tzOf(m.user_id)
      const start = wallToUtc(tz, m.date, m.start_min)
      for (const step of MEETING_STEPS) {
        if (sentKeys.includes(step.key)) continue
        const fireAt = start - step.min * 60_000
        if (now < fireAt || now >= fireAt + MEETING_WINDOW_MS || now >= start + 60_000) continue
        // mark first so an overlapping run can't double-send
        sentKeys.push(step.key)
        await rest(cfg, `meetings?id=eq.${m.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ push_sent: sentKeys, push_fired: true })
        })
        stats.meetings++
        await push(m.user_id, {
          kind: 'meeting',
          title: m.title,
          body:
            `${step.lead} · ${m.person_name} · ${clock(tz, m.date, m.start_min)}` +
            (m.meet_link ? (step.min <= 5 ? '\nTap to join the call' : '\nMeet link ready — tap to open') : ''),
          tag: `meeting-${m.id}-${step.key}`,
          url: m.meet_link || undefined
        })
      }
    }
  })

  // ================= one-time reminders: one notification =================
  await section('reminders', async () => {
    const rows = (
      await restGet(cfg, `reminders?select=*&push_fired=eq.false&date=gte.${from}&date=lte.${to}`)
    ).filter((r) => !r.repeat || r.repeat === 'none')
    for (const r of rows) {
      const tz = await tzOf(r.user_id)
      const at = wallToUtc(tz, r.date, r.at_min)
      if (now < at || now >= at + SEND_WINDOW_MS) continue
      if ((Number(r.alarm_ack_at) || 0) >= at) continue // already dismissed
      // mark first so an overlapping run can't send it twice
      await rest(cfg, `reminders?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ push_fired: true }) })
      stats.alarms++
      await push(r.user_id, {
        kind: 'reminder',
        title: r.title,
        body: `Reminder · ${r.notes && r.notes.trim() ? r.notes.trim() : clock(tz, r.date, r.at_min)}`,
        tag: `rem-${r.id}`,
        ack: { id: r.id }
      })
    }
  })

  // ================= repeating reminders: ring until Stop =================
  await section('repeating', async () => {
    let rows = []
    try {
      rows = await restGet(cfg, `reminders?select=*&fired=eq.false&repeat=neq.none`)
    } catch {
      return
    }
    const dowOf = (key) => {
      const [y, mo, d] = key.split('-').map(Number)
      return new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
    }
    const occursOn = (r, key) => {
      if (key < r.date) return false
      const dow = dowOf(key)
      if (r.repeat === 'daily') return true
      if (r.repeat === 'weekdays') return dow >= 1 && dow <= 5
      if (r.repeat === 'weekly') return (r.repeat_days ?? []).includes(dow)
      if (r.repeat === 'hourly') return !(r.repeat_days ?? []).length || r.repeat_days.includes(dow)
      return false
    }
    const timesOf = (r) => {
      if (r.repeat !== 'hourly') return [r.at_min]
      const step = Math.max(15, r.interval_min ?? 60)
      const end = Math.min(r.until_min ?? 1260, 1439)
      const out = []
      for (let x = r.at_min; x <= end; x += step) out.push(x)
      // same rule as the app: a first ring after the end time still rings once
      return out.length ? out : [r.at_min]
    }
    for (const r of rows) {
      const tz = await tzOf(r.user_id)
      const local = nowInTz(tz)
      if (!occursOn(r, local.date)) continue
      const past = timesOf(r).filter((x) => x <= local.min)
      if (!past.length) continue
      const occMin = past[past.length - 1]
      const occUtc = wallToUtc(tz, local.date, occMin)
      if (now - occUtc >= SEND_WINDOW_MS) continue
      if ((Number(r.alarm_ack_at) || 0) >= occUtc) continue // already dismissed
      if ((Number(r.last_push_at) || 0) >= occUtc) continue // this occurrence was already sent
      await rest(cfg, `reminders?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ last_push_at: occUtc }) })
      stats.alarms++
      await push(r.user_id, {
        kind: 'reminder',
        title: r.title,
        body: `Repeating reminder · ${r.notes && r.notes.trim() ? r.notes.trim() : clock(tz, local.date, occMin)}`,
        tag: `rem-${r.id}-${occUtc}`,
        ack: { id: r.id, occ: occUtc }
      })
    }
  })

  // ================= snoozed reminders: one more notification =================
  await section('snoozed', async () => {
    let rows = []
    try {
      rows = await restGet(
        cfg,
        `reminders?select=*&snooze_until=gte.${now - SEND_WINDOW_MS}&snooze_until=lte.${now}`
      )
    } catch {
      return // snooze column not added yet
    }
    for (const r of rows) {
      const at = Number(r.snooze_until)
      if ((Number(r.alarm_ack_at) || 0) >= at) continue // already sent, dismissed, or snoozed again
      // mark it sent (an ack later than the snooze time) before pushing
      await rest(cfg, `reminders?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ alarm_ack_at: now }) })
      stats.alarms++
      await push(r.user_id, {
        kind: 'reminder',
        title: r.title,
        body: `Reminder · ${r.notes && r.notes.trim() ? r.notes.trim() : 'Snooze is over'}`,
        tag: `rem-${r.id}-s${at}`,
        ack: { id: r.id, occ: at }
      })
    }
  })

  // ================= tasks: morning + afternoon digests =================
  await section('tasks', async () => {
    const taskRows = await restGet(
      cfg,
      `tasks?select=*&done=eq.false&due_date=not.is.null&due_date=lte.${to}`
    )
    // a task assigned to someone goes into THEIR digest, not the creator's
    const byUser = new Map()
    for (const t of taskRows ?? []) {
      const owner = t.assigned_to || t.user_id
      const list = byUser.get(owner) ?? []
      list.push(t)
      byUser.set(owner, list)
    }
    for (const [uid, list] of byUser) {
      const tz = await tzOf(uid)
      const local = nowInTz(tz)
      const morning = local.min >= 9 * 60 && local.min < 12 * 60
      const afternoon = local.min >= 16 * 60 && local.min < 19 * 60
      if (!morning && !afternoon) continue
      const markCol = morning ? 'due_push_date' : 'due_push2_date'
      const due = list.filter((t) => t.due_date <= local.date && t[markCol] !== local.date)
      if (!due.length) continue
      const overdue = due.filter((t) => t.due_date < local.date).length
      // mark first (overlap protection)
      await rest(cfg, `tasks?id=in.(${due.map((t) => t.id).join(',')})`, {
        method: 'PATCH',
        body: JSON.stringify({ [markCol]: local.date })
      })
      stats.digests++
      const others = due.slice(1, 4).map((t) => t.title).join('\n')
      const more = due.length > 4 ? `\n…and ${due.length - 4} more` : ''
      await push(uid, {
        kind: 'task',
        title: due.length === 1 ? due[0].title : `${due[0].title} + ${due.length - 1} more`,
        body:
          (morning ? 'Tasks due today' : 'Tasks still open today') +
          (overdue ? ` · ${overdue} overdue` : '') +
          (others ? `\n${others}` : '') +
          more,
        tag: `due-${morning ? 'am' : 'pm'}-${local.date}`
      })
    }
  })

  // ================= tasks handed to someone: push + email, once =================
  await section('assigned', async () => {
    let rows = []
    try {
      rows = await restGet(
        cfg,
        `notifications?select=id,user_id,company_id,title,body,task_id,actor_id&kind=eq.task_assigned&sent_at=is.null` +
          `&created_at=gte.${new Date(now - 30 * 60_000).toISOString()}&order=created_at.asc&limit=100`
      )
    } catch {
      return // sent_at column not added yet (Phase 15 database update)
    }
    if (!rows.length) return
    // mark first (overlap protection): each one goes out once, even if a run is slow
    await rest(cfg, `notifications?id=in.(${rows.map((r) => r.id).join(',')})`, {
      method: 'PATCH',
      body: JSON.stringify({ sent_at: new Date(now).toISOString() })
    })
    const byUser = new Map()
    for (const n of rows) byUser.set(n.user_id, [...(byUser.get(n.user_id) ?? []), n])

    const site = process.env.URL && process.env.URL.startsWith('https://') ? process.env.URL : 'https://meetingauth.netlify.app'
    const canEmail = emailConfigured()
    for (const [uid, list] of byUser) {
      stats.assigned += list.length
      const one = list.length === 1
      await push(uid, {
        kind: 'task',
        title: one ? list[0].title : `${list.length} new tasks for you`,
        body: one ? list[0].body : list.slice(0, 4).map((n) => n.body).join('\n') + (list.length > 4 ? `\n…and ${list.length - 4} more` : ''),
        tag: `assigned-${list[0].id}`
      })
      if (!canEmail) continue
      try {
        const [person] = await restGet(cfg, `profiles?select=email,name&user_id=eq.${uid}`)
        if (!person?.email) continue
        const ids = list.map((n) => n.task_id).filter(Boolean)
        const tasks = ids.length ? await restGet(cfg, `tasks?select=id,title,due_date,due_min,priority&id=in.(${ids.join(',')})`) : []
        const [company] = list[0].company_id ? await restGet(cfg, `companies?select=name&id=eq.${list[0].company_id}`) : []
        const [actor] = list[0].actor_id ? await restGet(cfg, `profiles?select=email,name&user_id=eq.${list[0].actor_id}`) : []
        const due = (t) =>
          !t?.due_date
            ? 'No due date'
            : typeof t.due_min === 'number'
              ? wallLabel(t.due_date, t.due_min)
              : new Date(`${t.due_date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
        const where = company?.name ? ` in ${company.name}` : ''
        const first = (person.name || '').split(' ')[0]
        const rowsHtml = list.slice(0, 10).map((n) => {
          const t = tasks.find((x) => x.id === n.task_id)
          return [esc(due(t)), `${esc(n.body)}${t?.priority === 'high' ? ' <b style="color:#e5484d">· Important</b>' : ''}`]
        })
        await sendEmail({
          to: person.email,
          replyTo: actor?.email || undefined,
          subject: one ? `${list[0].title}: ${list[0].body}` : `${list.length} new tasks for you${where}`,
          html: emailLayout({
            heading: one ? esc(list[0].body) : `${list.length} new tasks for you`,
            intro: `${first ? `Hi ${esc(first)}, ` : ''}${esc(one ? list[0].title : 'your team handed you some work')}${esc(where)}.`,
            rows: rowsHtml,
            button: { href: `${site}/app`, label: one ? 'Open the task' : 'Open my tasks' },
            footer: 'You get this email when someone assigns you a task in Taskorra.'
          }),
          text:
            `${one ? list[0].title : `${list.length} new tasks for you${where}`}\n\n` +
            list.map((n) => `• ${n.body} (${due(tasks.find((x) => x.id === n.task_id))})`).join('\n') +
            `\n\nOpen Taskorra: ${site}/app`
        })
        stats.emails++
      } catch (err) {
        // never log provider details: they can contain account information
        stats.errors.push(`assigned email: ${err?.code || 'failed'}`)
      }
    }
  })

  const summary = `meetings ${stats.meetings} · alarms ${stats.alarms} · digests ${stats.digests} · assigned ${stats.assigned} · emails ${stats.emails} · pushes ${stats.sent}` +
    (stats.errors.length ? ` · errors: ${stats.errors.join(' | ')}` : '')
  if (stats.sent || stats.errors.length) console.log('push-reminders:', summary)
  return new Response(summary, { status: 200 })
}

export const config = { schedule: '* * * * *' }
