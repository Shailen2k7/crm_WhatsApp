// =============================================================================
// SYSTEM HEALTH — does the automation actually WORK right now?
// -----------------------------------------------------------------------------
// Every failure this system has had was silent. Enrolment stopped dead at a
// page boundary; a chase ran twelve hours behind; a first message was rejected
// and written off. Nothing went red. The app looked fine, and the only way
// anyone found out was a customer who never got messaged.
//
// So this asks the questions a person would ask, against live data, and answers
// them in plain English:
//
//   * Did every new lead get its first message?
//   * Is anything overdue, and by how long?
//   * Can each machine send faster than people arrive?
//   * Is the cron actually running?
//
// It reads only. Nothing here sends, changes or fixes anything — it reports.
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { CHASE_START } from '@/lib/sequence-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Level = 'ok' | 'warn' | 'bad';

interface Check {
  name: string;
  level: Level;
  detail: string;
  /** What to do about it, when there is something to do. */
  action?: string;
}

const hoursSince = (iso: string | null | undefined) =>
  iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : Infinity;

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 });
  const { data: member } = await supabase
    .from('workspace_members').select('workspace_id, status').eq('user_id', user.id).maybeSingle();
  if (!member || member.status !== 'active') {
    return NextResponse.json({ ok: false, error: 'No active membership.' }, { status: 403 });
  }
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: false, error: 'Server not configured.' }, { status: 500 });

  const ws = member.workspace_id as string;
  const checks: Check[] = [];
  const nowIso = new Date().toISOString();

  // ---- 1. is the cron alive? ------------------------------------------------
  // If this stops, everything below stops with it and every other check goes
  // quiet rather than red — so it is asked first.
  const { data: lastSend } = await admin
    .from('relay_automation_sent').select('sent_at')
    .eq('workspace_id', ws).order('sent_at', { ascending: false }).limit(1).maybeSingle();
  const { data: lastSeq } = await admin
    .from('relay_sequence_sends').select('sent_at')
    .eq('workspace_id', ws).order('sent_at', { ascending: false }).limit(1).maybeSingle();
  const quietHours = Math.min(hoursSince(lastSend?.sent_at), hoursSince(lastSeq?.sent_at));
  checks.push(
    quietHours > 6
      ? { name: 'Automation is running', level: 'bad',
          detail: `Nothing at all has been sent for ${quietHours === Infinity ? 'a very long time' : `${quietHours.toFixed(1)} hours`}.`,
          action: 'The 5-minute Netlify scheduled function may have stopped. Check Netlify → Functions → automation-tick → Logs, and that CRON_SECRET is set.' }
      : { name: 'Automation is running', level: 'ok',
          detail: `Last message sent ${quietHours < 1 ? `${Math.round(quietHours * 60)} minutes` : `${quietHours.toFixed(1)} hours`} ago.` },
  );

  // ---- 2. did every new lead get its first message? -------------------------
  const { data: rule } = await admin
    .from('relay_automations').select('activated_at, enabled')
    .eq('workspace_id', ws).eq('key', 'new_lead_first').maybeSingle();

  if (!rule?.enabled) {
    checks.push({ name: 'First message to new leads', level: 'bad', detail: 'The rule is switched off.' });
  } else {
    const since = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const { data: recentLeads } = await admin
      .from('leads').select('id, full_name, phone, created_at, is_sample')
      .eq('workspace_id', ws)
      .gte('created_at', new Date(Math.max(new Date(since).getTime(), new Date(rule.activated_at || since).getTime())).toISOString())
      .lte('created_at', new Date(Date.now() - 5 * 60_000).toISOString())  // 5 min grace
      .order('created_at', { ascending: false }).limit(500);

    const { data: handled } = await admin
      .from('relay_automation_sent').select('lead_id, phone_e164, ok')
      .eq('workspace_id', ws).eq('automation_key', 'new_lead_first').gte('sent_at', since);

    const doneLeads = new Set((handled || []).map((h) => h.lead_id).filter(Boolean));
    const donePhones = new Set((handled || []).map((h) => String(h.phone_e164 || '').replace(/\D/g, '').slice(-10)));
    const missed = (recentLeads || []).filter((l) =>
      !l.is_sample && (l.phone || '').trim() &&
      !doneLeads.has(l.id) &&
      !donePhones.has(String(l.phone).replace(/\D/g, '').slice(-10)));

    checks.push(
      missed.length === 0
        ? { name: 'First message to new leads', level: 'ok',
            detail: `All ${(recentLeads || []).length} leads from the last 48 hours were messaged.` }
        : { name: 'First message to new leads', level: 'bad',
            detail: `${missed.length} lead${missed.length === 1 ? '' : 's'} from the last 48 hours never got it — ${missed.slice(0, 3).map((m) => m.full_name || m.phone).join(', ')}${missed.length > 3 ? '…' : ''}.`,
            action: 'Press “Run it now”. If they stay missed, the rule is not reaching them.' },
    );

    const failed = (handled || []).filter((h) => !h.ok).length;
    if (failed > 0) {
      checks.push({ name: 'Rejected first messages', level: failed > 5 ? 'bad' : 'warn',
        detail: `${failed} send${failed === 1 ? '' : 's'} were rejected in the last 48 hours.`,
        action: 'Open the thread to see the provider’s reason. Retries are automatic, up to three.' });
    }
  }

  // ---- 3. every running sequence: on time, and fast enough? -----------------
  const { data: sequences } = await admin
    .from('relay_sequences').select('*').eq('workspace_id', ws).eq('status', 'running');

  for (const seq of sequences || []) {
    const { data: active } = await admin
      .from('relay_lead_sequences').select('next_send_at')
      .eq('sequence_id', seq.id).eq('status', 'active').limit(5000);

    const overdue = (active || []).filter((r) => r.next_send_at && r.next_send_at <= nowIso);
    const worstLate = overdue.reduce((w, r) => Math.max(w, hoursSince(r.next_send_at)), 0);

    // Can it send faster than people come in? An intake that outruns the send
    // rate builds a queue that never clears, and every gap the schedule
    // promises quietly stretches.
    const windowHours = seq.hours_enabled
      ? Math.max(1, (seq.send_end_hour ?? 24) - (seq.send_start_hour ?? 0)) : 24;
    const dailyCapacity = (Number(seq.per_hour_cap) || 0) * windowHours;

    if (overdue.length === 0) {
      checks.push({ name: seq.name, level: 'ok', detail: `${(active || []).length} people waiting, all on schedule.` });
    } else if (worstLate < 2) {
      checks.push({ name: seq.name, level: 'ok', detail: `${overdue.length} due now, going out within the hour.` });
    } else {
      const late = worstLate > 24 ? `${(worstLate / 24).toFixed(1)} days` : `${worstLate.toFixed(1)} hours`;
      checks.push({
        name: seq.name,
        level: worstLate > 12 ? 'bad' : 'warn',
        detail: `${overdue.length} people overdue, the worst by ${late}.`,
        action: dailyCapacity > 0 && overdue.length > dailyCapacity
          ? `It can only send ${dailyCapacity}/day — raise “messages an hour” on this sequence.`
          : 'The queue is draining; check again shortly.',
      });
    }
  }

  // ---- 4. did everyone who ignored the first message get into the chase? ----
  // The check that was missing. Every other check looks at people who are
  // already inside a machine, so someone who never got in was invisible: the
  // chase reported "all on schedule" while ten people who had asked us for help
  // the night before sat outside it, and the only way that surfaced was a
  // person reading the threads by hand.
  for (const seq of (sequences || []).filter((s) => s.trigger_mode === 'no_reply')) {
    const { data: steps } = await admin
      .from('relay_sequence_steps').select('gap_hours, gap_days')
      .eq('sequence_id', seq.id).order('step_no').limit(1);
    const firstGapH = Number(steps?.[0]?.gap_hours ?? (steps?.[0]?.gap_days ?? 0) * 24) || 0;
    // Only people whose first follow-up is already due, plus an hour of slack.
    const dueBy = new Date(Date.now() - (firstGapH + 1) * 3_600_000).toISOString();
    // Never earlier than the chase's start date: the backlog before it was left alone on purpose.
    const since = new Date(Math.max(Date.now() - 72 * 3_600_000, new Date(CHASE_START).getTime())).toISOString();

    const [{ data: firsts }, { data: enrolled }, { data: stops }] = await Promise.all([
      admin.from('relay_automation_sent').select('phone_e164, sent_at')
        .eq('workspace_id', ws).eq('automation_key', 'new_lead_first').eq('ok', true)
        .gte('sent_at', since).lte('sent_at', dueBy).limit(1000),
      admin.from('relay_lead_sequences').select('phone_e164')
        .eq('sequence_id', seq.id).limit(5000),
      admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', ws).limit(2000),
    ]);
    const inSeq = new Set((enrolled || []).map((e) => e.phone_e164));
    const stopped = new Set((stops || []).map((s) => s.phone_e164));
    const candidates = (firsts || []).filter((f) => f.phone_e164 && !inSeq.has(f.phone_e164) && !stopped.has(f.phone_e164));

    let outside: { phone: string; hours: number }[] = [];
    if (candidates.length) {
      const { data: convs } = await admin
        .from('relay_conversations').select('phone_e164, last_inbound_at')
        .eq('workspace_id', ws).in('phone_e164', candidates.map((c) => c.phone_e164).slice(0, 300));
      const replied = new Map((convs || []).map((c) => [c.phone_e164, c.last_inbound_at]));
      outside = candidates
        .filter((c) => {
          const r = replied.get(c.phone_e164);
          return !(r && r >= c.sent_at);      // replied since = nothing to chase
        })
        .map((c) => ({ phone: c.phone_e164, hours: hoursSince(c.sent_at) }))
        .sort((a, b) => b.hours - a.hours);
    }

    checks.push(
      outside.length === 0
        ? { name: `${seq.name}: everyone is in it`, level: 'ok',
            detail: 'Every person who ignored the first message is in the follow-up.' }
        : { name: `${seq.name}: people left outside`, level: outside.length > 5 ? 'bad' : 'warn',
            detail: `${outside.length} ${outside.length === 1 ? 'person' : 'people'} never replied to the first message and are not in the follow-up — the longest waiting ${outside[0].hours.toFixed(1)} hours (${outside.slice(0, 3).map((o) => o.phone).join(', ')}${outside.length > 3 ? '…' : ''}).`,
            action: 'Press “Run it now”. If they stay outside, enrolment is not reaching them.' },
    );

    // ---- 5. can the follow-up run when the first messages actually go out? --
    // The first message has no sending hours; the follow-up does. Every lead
    // messaged outside that window is frozen until it opens, so a promise of
    // "one hour later" cannot hold for them however fast the queue moves.
    if (seq.hours_enabled) {
      const { data: t1s } = await admin
        .from('relay_automation_sent').select('sent_at')
        .eq('workspace_id', ws).eq('automation_key', 'new_lead_first').eq('ok', true)
        .gte('sent_at', new Date(Date.now() - 48 * 3_600_000).toISOString()).limit(1000);
      const istHourOf = (iso: string) =>
        Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date(iso)));
      const night = (t1s || []).filter((t) => {
        const h = istHourOf(t.sent_at);
        return h < (seq.send_start_hour ?? 0) || h >= (seq.send_end_hour ?? 24);
      }).length;
      const share = (t1s || []).length ? Math.round((night / (t1s || []).length) * 100) : 0;
      if (share >= 20) {
        checks.push({
          name: 'First messages outside follow-up hours',
          level: share >= 40 ? 'bad' : 'warn',
          detail: `${share}% of first messages in the last 48 hours went out outside ${seq.send_start_hour}:00–${seq.send_end_hour}:00, so their follow-up cannot go on time.`,
          action: `Either widen this sequence's sending hours, or stop the first message going out at night.`,
        });
      }
    }
  }

  const worst: Level = checks.some((c) => c.level === 'bad') ? 'bad'
    : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';

  return NextResponse.json({
    ok: true,
    level: worst,
    headline: worst === 'ok' ? 'Everything is running normally'
      : worst === 'warn' ? 'Running, with something worth a look'
      : 'Something is not working',
    checks,
    checkedAt: nowIso,
  });
}
