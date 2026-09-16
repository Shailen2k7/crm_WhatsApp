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
