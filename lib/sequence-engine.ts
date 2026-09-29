// =============================================================================
// SEQUENCE ENGINE — runs the C1–C8 follow-up machine.
// -----------------------------------------------------------------------------
// Called from the automation tick (every 5 minutes). Each pass, for every
// RUNNING sequence, inside the run's time and send budget:
//
//   1. ENROL — top up today's intake to the ramp limit (80/day -> 150 -> 200…),
//      OLDEST leads first, so the whole database is eventually covered.
//   2. SEND  — deliver every step that has come due, a few per run so a
//      run never goes long; whatever is left continues on the next run.
//
// A lead leaves the machine by replying (webhook flips them to 'replied'),
// finishing every step ('completed'), opting out ('stopped'), or having a
// send fail hard ('skipped', with the reason kept).
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { toE164 } from '@/lib/phone';
import { sendTemplateToLead } from '@/lib/send-template';
import { forEachLimited, type RunContext } from '@/lib/automation/run-context';

const IST = 'Asia/Kolkata';
// Per sequence, per run. The run's shared budget (20) and each sequence's
// hourly cap still apply on top; this only stops one sequence taking all of it.
const SEND_BUDGET_PER_TICK = 5;
const SEND_CONCURRENCY = 3;
/** A queued message the provider never confirmed is treated as failed after this. */
const TIMEOUT_UNCONFIRMED_MS = 30 * 60_000;
const ENROL_PAGE = 400;              // leads read per query when topping up
// The oldest leads are enrolled first, so once the front of the database is in
// the machine every page we read is full of people we have already got. Walking
// several pages keeps finding new ones; without this, enrolment silently stops
// the day the enrolled count passes one page.
const ENROL_MAX_PAGES = 30;          // up to 12,000 oldest leads scanned per tick

/**
 * The follow-up counts from 29 September 2026, 00:00 IST.
 *
 * Everyone whose first message went out before then was deliberately left
 * alone — Shailen's decision, after days of backlog, repair and re-chasing:
 * start clean, and make certain that nobody from that day on is missed. So
 * nothing older is ever enrolled, and anything older that finds its way back
 * into the queue by any route is stopped at the moment it would have been sent.
 */
export const CHASE_START = '2026-09-28T18:30:00.000Z';   // 29 Sep 2026, 00:00 IST

/** Phones whose first message went out before CHASE_START (or, lacking one, who joined before it). */
async function beforeChaseStart(
  admin: SupabaseClient, ws: string,
  rows: { phone_e164: string; enrolled_at: string | null }[],
): Promise<Set<string>> {
  const old = new Set<string>();
  const phones = [...new Set(rows.map((r) => r.phone_e164).filter(Boolean))];
  if (!phones.length) return old;
  const { data } = await admin.from('relay_automation_sent').select('phone_e164, sent_at')
    .eq('workspace_id', ws).eq('automation_key', 'new_lead_first').eq('ok', true)
    .in('phone_e164', phones).order('sent_at', { ascending: true });
  const firstAt = new Map<string, string>();
  for (const f of (data || []) as { phone_e164: string; sent_at: string }[]) {
    if (!firstAt.has(f.phone_e164)) firstAt.set(f.phone_e164, f.sent_at);
  }
  const start = new Date(CHASE_START).getTime();
  for (const r of rows) {
    const since = firstAt.get(r.phone_e164) || r.enrolled_at;
    if (since && new Date(since).getTime() < start) old.add(r.phone_e164);
  }
  return old;
}

/**
 * Has this person written to us since their first message went out?
 *
 * The chase exists only for people who ignored the first message. Replying
 * was supposed to take them out — the webhook flips their row the moment
 * anything inbound arrives — and for a long time that was the ONLY guard. It
 * is not enough on its own: it only touches rows that already exist, so anyone
 * put into the chase after they had replied (a backfill, a late enrolment, a
 * phone stored in another format) sailed straight through. People who had sent
 * their CV, taken a call, and received our PDF were then asked for their CV
 * again. Sixty-five times.
 *
 * So the question is asked again at the last possible moment, against the
 * conversation itself, immediately before every single reminder.
 */
export async function repliedSinceFirstMessage(
  admin: SupabaseClient, ws: string,
  rows: { phone_e164: string; enrolled_at: string | null }[],
): Promise<Set<string>> {
  const replied = new Set<string>();
  const phones = [...new Set(rows.map((r) => r.phone_e164).filter(Boolean))];
  if (!phones.length) return replied;

  const [{ data: firsts }, { data: convs }] = await Promise.all([
    admin.from('relay_automation_sent').select('phone_e164, sent_at')
      .eq('workspace_id', ws).eq('automation_key', 'new_lead_first').eq('ok', true)
      .in('phone_e164', phones).order('sent_at', { ascending: true }),
    admin.from('relay_conversations').select('phone_e164, last_inbound_at')
      .eq('workspace_id', ws).in('phone_e164', phones),
  ]);
  const firstAt = new Map<string, string>();
  for (const f of (firsts || []) as { phone_e164: string; sent_at: string }[]) {
    if (!firstAt.has(f.phone_e164)) firstAt.set(f.phone_e164, f.sent_at);
  }
  const lastIn = new Map((convs || []).map((c) => [c.phone_e164 as string, c.last_inbound_at as string | null]));

  for (const r of rows) {
    const inbound = lastIn.get(r.phone_e164);
    if (!inbound) continue;
    // Their first message, or failing that when they joined the chase.
    const since = firstAt.get(r.phone_e164) || r.enrolled_at;
    // Compared as times, not strings: the two columns need not be formatted alike.
    if (since && new Date(inbound).getTime() >= new Date(since).getTime()) replied.add(r.phone_e164);
  }
  return replied;
}

/**
 * "This message was not delivered to maintain healthy ecosystem engagement."
 *
 * Meta's per-person marketing cap (131049). Not a fault at our end and not a
 * bad number — that person, personally, is being sent more marketing than Meta
 * thinks they want, by us and by everyone else. It usually passes. So the
 * answer is to back off and come back, and only give up when backing off
 * clearly has not worked:
 *
 *   1st strike → leave them alone for 4 days, then try again
 *   2nd strike → leave them alone for 10 days, then try again
 *   3rd strike → stop for good
 *
 * A refusal only counts as a NEW strike if it arrives after the previous pause
 * has ended. Before this rule, one bad day could bring back T2, T3 and T4 all
 * refused within hours; counting those as three strikes would retire someone
 * who never once got the pause they were owed.
 *
 * Every automated message obeys this — the first message and the follow-up
 * alike. A human can still write to them by hand.
 */
export const ECOSYSTEM_CODE = '131049';
export const ECOSYSTEM_PAUSE_DAYS = [4, 10] as const;   // after strike 1, after strike 2; strike 3 is final

export interface EcosystemState {
  strikes: number;
  /** While in the future, send nothing automated to this person. */
  pausedUntil: string | null;
  /** Three strikes: never again. */
  stopped: boolean;
}

/** Pure: the refusal times of one person → where they stand now. */
export function ecosystemStateFrom(refusedAt: number[], now: number = Date.now()): EcosystemState {
  let strikes = 0;
  let pauseEnd = -Infinity;
  for (const t of [...refusedAt].sort((a, b) => a - b)) {
    if (t < pauseEnd) continue;                         // inside a pause: not a new strike
    strikes++;
    if (strikes > ECOSYSTEM_PAUSE_DAYS.length) { pauseEnd = Infinity; break; }
    pauseEnd = t + ECOSYSTEM_PAUSE_DAYS[strikes - 1] * 86_400_000;
  }
  const stopped = strikes > ECOSYSTEM_PAUSE_DAYS.length;
  return {
    strikes,
    stopped,
    pausedUntil: !stopped && pauseEnd > now ? new Date(pauseEnd).toISOString() : null,
  };
}

/** True when nothing automated may go to this person right now. */
export function heldByEcosystem(s: EcosystemState | undefined, now: number = Date.now()): boolean {
  return !!s && (s.stopped || (!!s.pausedUntil && new Date(s.pausedUntil).getTime() > now));
}

/** Where every one of these people stands under the three-strike rule. */
export async function ecosystemStates(
  admin: SupabaseClient, ws: string, phones: string[],
): Promise<Map<string, EcosystemState>> {
  const out = new Map<string, EcosystemState>();
  const wanted = [...new Set(phones.filter(Boolean))];
  if (!wanted.length) return out;

  const convs: { id: string; phone_e164: string }[] = [];
  for (let i = 0; i < wanted.length; i += 100) {
    const { data } = await admin.from('relay_conversations')
      .select('id, phone_e164').eq('workspace_id', ws).in('phone_e164', wanted.slice(i, i + 100));
    convs.push(...((data || []) as { id: string; phone_e164: string }[]));
  }
  if (!convs.length) return out;

  const phoneByConv = new Map(convs.map((c) => [c.id, c.phone_e164]));
  const ids = convs.map((c) => c.id);
  const times = new Map<string, number[]>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await admin.from('relay_messages')
      .select('conversation_id, created_at').eq('direction', 'out')
      .eq('error_code', ECOSYSTEM_CODE).in('conversation_id', ids.slice(i, i + 100)).limit(2000);
    for (const m of (data || []) as { conversation_id: string; created_at: string }[]) {
      const p = phoneByConv.get(m.conversation_id);
      if (!p) continue;
      if (!times.has(p)) times.set(p, []);
      times.get(p)!.push(new Date(m.created_at).getTime());
    }
  }
  const now = Date.now();
  for (const [p, t] of times) out.set(p, ecosystemStateFrom(t, now));
  return out;
}
/**
 * When a backlog forces intake to hold back, anyone whose first message went
 * out inside this window is still let in. A follow-up promised an hour after
 * the first message is a promise to today's enquiry, not to last week's.
 */
const FRESH_INTAKE_HOURS = 36;

function istDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(d); // YYYY-MM-DD
}
function istHour(d = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: 'numeric', hour12: false }).format(d));
}
/** Days since the sequence started, day 1 = the start day (IST). */
function rampDay(startedAt: string): number {
  const start = new Date(`${istDate(new Date(startedAt))}T00:00:00+05:30`).getTime();
  const today = new Date(`${istDate()}T00:00:00+05:30`).getTime();
  return Math.floor((today - start) / 86_400_000) + 1;
}

interface Ramp { stage_no: number; per_day: number; duration_days: number | null }

// ---------------------------------------------------------------------------
// RETRYING A BOUNCE
// ---------------------------------------------------------------------------
// Interakt accepts the send, then WhatsApp reports the real outcome minutes
// later on the webhook. So a bounce never surfaces at send time: the lead has
// already been advanced to the next step and is queued for C2, having never
// received C1. These are the codes worth another go — the message was refused
// because of timing, not because the person is unreachable.
const RETRYABLE_CODES = new Set([
  '131049',  // "not delivered to maintain healthy ecosystem engagement" — per-user marketing cap
  '130472',  // user is in a Meta experiment group
  '131047',  // re-engagement window
  '131048',  // spam rate limit
  '80007',   // rate limit
  '133016', '500', '503', 'http_500', 'http_503',
]);
const MAX_ATTEMPTS_PER_STEP = 3;   // the first try plus two retries
const REPAIR_LOOKBACK_DAYS = 4;
const REPAIR_BATCH = 500;

const RETRY_EARLIEST_HOUR = 10;    // IST — nothing before mid-morning
const RETRY_LATEST_HOUR = 19;      // IST — nothing after early evening

/**
 * When the retry should go out: a full 24 hours later, because going straight
 * back at the same cap just bounces again, then nudged into the part of the day
 * these messages actually get read. In practice 24–34 hours.
 */
export function retryAtFrom(failedAtIso: string): string {
  const earliest = new Date(new Date(failedAtIso).getTime() + 24 * 3_600_000);
  const h = istHour(earliest);
  if (h < RETRY_EARLIEST_HOUR) {
    return new Date(`${istDate(earliest)}T${String(RETRY_EARLIEST_HOUR).padStart(2, '0')}:00:00+05:30`).toISOString();
  }
  if (h >= RETRY_LATEST_HOUR) {
    const nextDay = new Date(earliest.getTime() + 86_400_000);
    return new Date(`${istDate(nextDay)}T${String(RETRY_EARLIEST_HOUR).padStart(2, '0')}:00:00+05:30`).toISOString();
  }
  return earliest.toISOString();   // already a sensible time of day
}

/**
 * Reads every row, a page at a time. A single query returns at most 1000 rows,
 * and the cold sequence alone is past 900 — reading "everyone already enrolled"
 * in one go would quietly drop the rest, and enrolment would then retry those
 * people (and fail on the unique index) on every run.
 */
async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  ctx?: RunContext,
  maxPages = 20,
): Promise<T[]> {
  const rows: T[] = [];
  for (let p = 0; p < maxPages; p++) {
    if (ctx && ctx.signal.aborted) break;
    const { data, error } = await page(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

/** Today's intake limit from the ramp schedule. */
export function intakeLimitFor(day: number, ramp: Ramp[]): number {
  let covered = 0;
  for (const r of [...ramp].sort((a, b) => a.stage_no - b.stage_no)) {
    if (r.duration_days == null) return r.per_day;           // "thereafter"
    covered += r.duration_days;
    if (day <= covered) return r.per_day;
  }
  return 0; // schedule exhausted and no "thereafter" stage: intake stops
}

interface Step {
  step_no: number; template_name: string; template_language: string;
  gap_days: number; gap_hours?: number | null;
}

/** Hours are canonical (116); older rows only carry days. */
const gapMs = (s: Step | undefined) =>
  ((s?.gap_hours ?? (s?.gap_days ?? 0) * 24) || 0) * 3_600_000;

export interface SequenceReport {
  sequence: string;
  enrolled: number;
  sent: number;
  completed: number;
  retried: number;
  skipped: string[];
  note?: string;
}

/**
 * Puts leads back for another attempt at the message that bounced.
 *
 * The lead is rewound one step, so the ordinary send path delivers the SAME
 * template again at the retry time. Without this a bounced C1 is invisible:
 * the lead sits at step 1 waiting for C2, and we follow up on a conversation
 * that never started.
 */
async function repairBouncedSends(
  admin: SupabaseClient, seqId: string, ws: string,
): Promise<number> {
  const since = new Date(Date.now() - REPAIR_LOOKBACK_DAYS * 86_400_000).toISOString();

  const { data: sends } = await admin
    .from('relay_sequence_sends')
    .select('phone_e164, step_no, message_id, sent_at')
    .eq('sequence_id', seqId).eq('ok', true)
    .gte('sent_at', since)
    .not('message_id', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(REPAIR_BATCH);
  if (!sends?.length) return 0;

  // How many times we have already tried each (person, step).
  const attempts = new Map<string, number>();
  for (const s of sends) attempts.set(`${s.phone_e164}|${s.step_no}`, (attempts.get(`${s.phone_e164}|${s.step_no}`) || 0) + 1);

  const ids = sends.map((s) => s.message_id as string);
  const msgs: { id: string; status: string; error_code: string | null }[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin
      .from('relay_messages').select('id, status, error_code').in('id', ids.slice(i, i + 200));
    msgs.push(...(data || []));
  }
  const byId = new Map(msgs.map((m) => [m.id, m]));

  // The most recent attempt per (person, step) is the one that decides.
  const latest = new Map<string, typeof sends[number]>();
  for (const s of sends) {
    const k = `${s.phone_e164}|${s.step_no}`;
    if (!latest.has(k)) latest.set(k, s);          // sends came back newest first
  }

  const toRetry: { phone: string; step: number; at: string; reopen: boolean }[] = [];
  for (const [k, s] of latest) {
    const m = byId.get(s.message_id as string);
    if (!m) continue;
    const bounced = m.status === 'failed' && RETRYABLE_CODES.has(String(m.error_code || ''));
    // Sent into a timeout and never confirmed by the webhook in half an hour:
    // it almost certainly never reached WhatsApp, so it gets another go.
    const unconfirmed = m.status === 'queued' && m.error_code === 'timeout'
      && Date.now() - new Date(s.sent_at).getTime() > TIMEOUT_UNCONFIRMED_MS;
    if (!bounced && !unconfirmed) continue;
    if ((attempts.get(k) || 0) >= MAX_ATTEMPTS_PER_STEP) continue;
    toRetry.push({
      phone: s.phone_e164, step: s.step_no, at: retryAtFrom(s.sent_at),
      // A refused LAST message used to be the end: the lead was already marked
      // finished, so it was never retried. Under the pause-and-retry rule for
      // Meta's per-person cap it is owed another go like any other step. The
      // send path moves it to the end of the pause.
      reopen: bounced && String(m.error_code) === ECOSYSTEM_CODE,
    });
  }
  if (!toRetry.length) return 0;

  let repaired = 0;
  const now = () => new Date().toISOString();
  for (let i = 0; i < toRetry.length; i += 25) {
    const results = await Promise.all(toRetry.slice(i, i + 25).map((r) => r.reopen
      ? admin.from('relay_lead_sequences')
          .update({ status: 'active', exit_reason: null, exited_at: null,
                    current_step: r.step - 1, next_send_at: r.at, updated_at: now() })
          .eq('sequence_id', seqId).eq('phone_e164', r.phone)
          .in('status', ['active', 'completed'])   // never someone who replied or was stopped
          .eq('current_step', r.step)
          .select('id')
      : admin.from('relay_lead_sequences')
          .update({ current_step: r.step - 1, next_send_at: r.at, updated_at: now() })
          .eq('sequence_id', seqId).eq('phone_e164', r.phone)
          .eq('status', 'active')
          .eq('current_step', r.step)      // only if they are still sitting where that send left them
          .select('id')));
    repaired += results.reduce((n, r) => n + (r.data?.length || 0), 0);
  }
  return repaired;
}

export interface RunSequencesOptions {
  /** Only these sequences (the tick passes the ones with work). Default: all running. */
  sequenceIds?: string[];
  /** Enrol new people this run. The tick does this every 15 minutes. Default true. */
  enrol?: boolean;
  /** Re-queue bounced messages this run. The tick does this hourly. Default true. */
  repair?: boolean;
}

export async function runSequences(
  admin: SupabaseClient,
  ctx?: RunContext,
  opts: RunSequencesOptions = {},
): Promise<SequenceReport[]> {
  let q = admin.from('relay_sequences').select('*').eq('status', 'running');
  if (opts.sequenceIds) {
    if (!opts.sequenceIds.length) return [];
    q = q.in('id', opts.sequenceIds);
  }
  const { data: sequences } = await q;
  if (!sequences?.length) return [];

  const reports: SequenceReport[] = [];
  // Sequences are independent, so they run side by side; the run's shared
  // send budget and deadline still hold across all of them.
  const runOne = async (seq: (typeof sequences)[number]) => {
    const report: SequenceReport = { sequence: seq.name, enrolled: 0, sent: 0, completed: 0, retried: 0, skipped: [] };
    reports.push(report);
    if (ctx && !ctx.hasTime()) { report.note = 'Deferred to the next run.'; return; }

    const ws = seq.workspace_id as string;
    const [{ data: steps }, { data: ramp }] = await Promise.all([
      admin.from('relay_sequence_steps').select('*').eq('sequence_id', seq.id).order('step_no'),
      admin.from('relay_sequence_ramp').select('*').eq('sequence_id', seq.id).order('stage_no'),
    ]);
    if (!steps?.length) { report.note = 'No steps configured.'; return; }

    const stages = seq.audience === 'both' ? ['cold', 'hot'] : [seq.audience];
    const noReply = seq.trigger_mode === 'no_reply';

    // ORDER MATTERS. Each run has a few seconds, and whatever comes last gets
    // what is left. Sending used to come last — after topping up the intake
    // and repairing bounces — so on every run where those two were busy, not
    // one reminder went out. Runs on the quarter hour never sent at all, and
    // once the checks before each send grew a little heavier, most other runs
    // stopped sending too: three reminders an hour against a cap of ten, while
    // people who had been promised a follow-up in one hour waited all day.
    //
    // So the promise is kept first. Sending runs at the start of every run;
    // enrolment and repair take the time that remains, and neither is urgent —
    // new people are booked in the moment their first message goes, and the
    // intake pass is only a net.

    // ---- HOUSEKEEPING: enrol, then give bounced messages another go --------
    const housekeeping = async () => {
    const day = rampDay(seq.started_at || new Date().toISOString());
    const limit = intakeLimitFor(day, (ramp || []) as Ramp[]);
    const dayStartIst = new Date(`${istDate()}T00:00:00+05:30`).toISOString();

    const { count: enrolledToday } = opts.enrol === false
      ? { count: 0 }
      : await admin
          .from('relay_lead_sequences')
          .select('id', { count: 'exact', head: true })
          .eq('sequence_id', seq.id)
          .gte('enrolled_at', dayStartIst);
    let room = opts.enrol === false ? 0 : Math.max(0, limit - (enrolledToday ?? 0));

    // ---- do not enrol faster than we can send ------------------------------
    // The ramp says how many people to TAKE IN a day; per_hour_cap says how
    // many messages may GO OUT. Nothing connected the two, so an intake of
    // 100/day against a send rate of 50/day quietly built a permanent queue:
    // 465 people were overdue, the oldest by four days, and every promise the
    // schedule makes ("C2 three days after C1") was being broken by the
    // backlog rather than by the settings.
    //
    // So intake holds back while more people are already overdue than a day of
    // sending can clear. The queue drains, then intake resumes in full.
    //
    // But it must never close completely. It used to set room to zero, and that
    // latched: a backlog kept the door shut, and because the door was shut the
    // newest enquiries never entered, so nobody could see them waiting. It
    // stayed that way for a full day and ten people who had asked us for help
    // that night were simply never followed up.
    //
    // Someone who wrote to us an hour ago is the whole point of the machine, so
    // they are always admitted. It is the old backlog that waits.
    let freshOnlySince: string | null = null;
    if (room > 0 && Number(seq.per_hour_cap) > 0) {
      const windowHours = seq.hours_enabled
        ? Math.max(1, (seq.send_end_hour ?? 24) - (seq.send_start_hour ?? 0))
        : 24;
      const dailyCapacity = Number(seq.per_hour_cap) * windowHours;
      const { count: overdue } = await admin
        .from('relay_lead_sequences')
        .select('id', { count: 'exact', head: true })
        .eq('sequence_id', seq.id).eq('status', 'active')
        .lte('next_send_at', new Date().toISOString());
      if ((overdue ?? 0) >= dailyCapacity) {
        freshOnlySince = new Date(Date.now() - FRESH_INTAKE_HOURS * 3_600_000).toISOString();
        report.note = `Backlog of ${overdue} is more than a day of sending (${dailyCapacity}), so only people from the last ${FRESH_INTAKE_HOURS}h are being taken in.`;
      }
    }

    // Industry filter: null/empty = everyone; '(none)' matches a blank industry.
    const industries: string[] | null =
      Array.isArray(seq.industries) && seq.industries.length ? seq.industries : null;
    const industryOk = (ind: string | null | undefined) =>
      !industries || industries.includes((ind || '').trim() || '(none)');

    if (room > 0) {
      type Enrolled = { lead_id: string | null; phone_e164: string };
      const [already, { data: suppressed }, busyElsewhere] = await Promise.all([
        readAllPages<Enrolled>((from, to) => admin.from('relay_lead_sequences')
          .select('lead_id, phone_e164').eq('sequence_id', seq.id).order('id').range(from, to), ctx),
        admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', ws),
        // Someone mid-way through another machine is already hearing from us.
        // Two sequences messaging the same person on the same day is the
        // fastest way to look like a robot, so they wait their turn.
        //
        // The no-reply chase is the exception, and must be: it is not a
        // separate campaign but the direct continuation of the first message
        // we sent minutes ago. Holding T2 back because some other sequence
        // has the same person queued is how a fresh enquiry goes unanswered.
        noReply
          ? Promise.resolve([] as Enrolled[])
          : readAllPages<Enrolled>((from, to) => admin.from('relay_lead_sequences')
              .select('lead_id, phone_e164').eq('workspace_id', ws)
              .eq('status', 'active').neq('sequence_id', seq.id).order('id').range(from, to), ctx),
      ]);
      const doneLeads = new Set([
        ...(already || []).map((a) => a.lead_id),
        ...(busyElsewhere || []).map((a) => a.lead_id),
      ].filter(Boolean));
      const donePhones = new Set([
        ...(already || []).map((a) => a.phone_e164),
        ...(busyElsewhere || []).map((a) => a.phone_e164),
      ].filter(Boolean));
      const stopPhones = new Set((suppressed || []).map((s) => s.phone_e164));
      const firstGap = gapMs((steps as Step[])[0]);

      if (noReply) {
        // ---- WHO: got the new-lead first message, said nothing since --------
        // The audit rows from the new-lead rule are the source of truth for
        // "we messaged them first". Two weeks back is plenty: beyond that the
        // chase reads as spam, not follow-up.
        // While a backlog holds intake back, only the recent arrivals come in —
        // and never anyone from before the chase's start date.
        const floor = Math.max(Date.now() - 14 * 86_400_000, new Date(CHASE_START).getTime());
        const horizon = freshOnlySince && new Date(freshOnlySince).getTime() > floor
          ? freshOnlySince
          : new Date(floor).toISOString();

        // NEWEST FIRST, and this matters more than it looks. The pass is
        // time-limited — the tick must finish in under ten seconds — and it
        // used to walk the fortnight oldest-first. The people messaged an hour
        // ago were therefore always at the very end of the list, so whenever
        // the pass ran out of time they were the ones dropped, every single
        // time. Five leads from one night sat unenrolled while the backlog
        // ahead of them was scanned again and again.
        //
        // A promise of "T2 one hour after T1" is a promise to the newest
        // person in the database, so the newest person is served first. The
        // backlog is still reached: it is the same list, walked from the other
        // end, and intake room runs to hundreds a day.
        for (let page = 0; room > 0 && page < ENROL_MAX_PAGES && (!ctx || ctx.hasTime()); page++) {
          const { data: firstSends } = await admin
            .from('relay_automation_sent')
            .select('lead_id, phone_e164, sent_at')
            .eq('workspace_id', ws).eq('automation_key', 'new_lead_first')
            .eq('ok', true).gte('sent_at', horizon)
            .order('sent_at', { ascending: false })
            .range(page * ENROL_PAGE, page * ENROL_PAGE + ENROL_PAGE - 1);
          if (!firstSends?.length) break;

          // Everyone still worth looking at after the cheap in-memory filters.
          const candidates = firstSends.filter((fs) =>
            fs.phone_e164 &&
            !donePhones.has(fs.phone_e164) &&
            !stopPhones.has(fs.phone_e164) &&
            !(fs.lead_id && doneLeads.has(fs.lead_id)));

          if (candidates.length) {
            // Two bulk reads instead of two queries per person — a 400-strong
            // page used to mean 800 round trips and a timed-out tick.
            const phones = [...new Set(candidates.map((c) => c.phone_e164 as string))];
            const leadIds = [...new Set(candidates.map((c) => c.lead_id).filter(Boolean) as string[])];
            const [{ data: convs }, { data: leadRows }] = await Promise.all([
              admin.from('relay_conversations')
                .select('phone_e164, last_inbound_at').eq('workspace_id', ws).in('phone_e164', phones),
              leadIds.length
                ? admin.from('leads').select('id, industry, stage').in('id', leadIds)
                : Promise.resolve({ data: [] as { id: string; industry: string | null; stage: string }[] }),
            ]);
            const lastIn = new Map((convs || []).map((c) => [c.phone_e164, c.last_inbound_at]));
            const leadById = new Map((leadRows || []).map((l) => [l.id, l]));

            for (const fs of candidates) {
              if (room <= 0) break;
              const phone = fs.phone_e164 as string;
              if (donePhones.has(phone)) continue;

              // Replied since the first message? Then there is nothing to chase.
              const inbound = lastIn.get(phone);
              if (inbound && inbound >= fs.sent_at) continue;

              const lead = fs.lead_id ? leadById.get(fs.lead_id) : null;
              if (lead && ['junk', 'won', 'lost'].includes(lead.stage || '')) continue;
              if (!industryOk(lead?.industry)) continue;

              // The clock starts at the FIRST MESSAGE, not at enrolment: "T2
              // four hours after we asked for the CV" holds even if this pass
              // runs late.
              const { error } = await admin.from('relay_lead_sequences').insert({
                workspace_id: ws, sequence_id: seq.id, lead_id: fs.lead_id,
                phone_e164: phone, status: 'active', current_step: 0,
                next_send_at: new Date(new Date(fs.sent_at).getTime() + firstGap).toISOString(),
              });
              if (!error) { donePhones.add(phone); room--; report.enrolled++; }
            }
          }
          if (firstSends.length < ENROL_PAGE) break;   // that was the last page
        }
      } else if (!freshOnlySince) {
        // A backlog sequence works through a fixed list at its own pace, so
        // when it is already behind there is nothing urgent to let in — unlike
        // the no-reply chase above, where the newest arrival is the point.
        // ---- OLDEST FIRST through the backlog -------------------------------
        // Pages forward until today's room is filled. The first pages are
        // people already enrolled; walking past them is what keeps the intake
        // running once the front of the database is covered.
        for (let page = 0; room > 0 && page < ENROL_MAX_PAGES && (!ctx || ctx.hasTime()); page++) {
          const { data: leads } = await admin
            .from('leads')
            .select('id, full_name, phone, visa_type, industry, created_at, is_sample')
            .eq('workspace_id', ws)
            .in('stage', stages)
            .order('created_at', { ascending: true })
            .range(page * ENROL_PAGE, page * ENROL_PAGE + ENROL_PAGE - 1);
          if (!leads?.length) break;

          for (const lead of leads) {
            if (room <= 0) break;
            if (lead.is_sample || doneLeads.has(lead.id)) continue;
            if (!industryOk(lead.industry)) continue;
            const phone = toE164(lead.phone);
            if (!phone || donePhones.has(phone) || stopPhones.has(phone)) continue;

            const { error } = await admin.from('relay_lead_sequences').insert({
              workspace_id: ws, sequence_id: seq.id, lead_id: lead.id,
              phone_e164: phone, status: 'active', current_step: 0,
              next_send_at: new Date(Date.now() + firstGap).toISOString(),
            });
            if (!error) { donePhones.add(phone); room--; report.enrolled++; }
          }
          if (leads.length < ENROL_PAGE) break;        // that was the last page
        }
      }
    }

    // Give bounced messages another go.
    if (opts.repair !== false && (!ctx || ctx.hasTime())) {
      report.retried = await repairBouncedSends(admin, seq.id, ws);
    }
    };

    // ---- SEND what is due, inside sending hours -----------------------------
    const sendDue = async () => {
    if (seq.hours_enabled) {
      const h = istHour();
      if (h < seq.send_start_hour || h >= seq.send_end_hour) {
        report.note = `Outside sending hours (${seq.send_start_hour}:00–${seq.send_end_hour}:00 IST).`;
        return;
      }
    }

    // Spread the day out instead of emptying the queue in the first ten
    // minutes: at 5 an hour over a 9am–7pm window that is 50 a day, arriving
    // like a person sending them rather than a machine dumping them.
    let budget = Math.min(SEND_BUDGET_PER_TICK, ctx ? ctx.sendsLeft() : SEND_BUDGET_PER_TICK);
    if (budget <= 0 || (ctx && !ctx.hasTime())) { report.note = 'Send budget used — continues next run.'; return; }
    const perHour = Number(seq.per_hour_cap) || 0;
    if (perHour > 0) {
      const hourStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
      const { count: sentThisHour } = await admin
        .from('relay_sequence_sends')
        .select('id', { count: 'exact', head: true })
        .eq('sequence_id', seq.id).gte('sent_at', hourStart);
      budget = Math.min(budget, Math.max(0, perHour - (sentThisHour ?? 0)));
      if (budget === 0) {
        report.note = `This hour's ${perHour} already sent — next batch at the top of the hour.`;
        return;
      }
    }

    // WHO GOES FIRST, when more people are due than this batch can carry.
    //
    // Strictly oldest-first is the fair answer to "who has waited longest", and
    // it is the wrong answer here. A morning backlog of a hundred people would
    // absorb every batch all day, so the enquiry that came in at nine would not
    // be followed up until the evening — while the schedule claims one hour.
    // The oldest rows are also the least likely to still be worth anything.
    //
    // So each batch is split: most of it clears the backlog oldest-first, and a
    // reserved share always goes to people whose turn came up recently. Both
    // move every single run, and neither can starve the other.
    const nowIso = new Date().toISOString();
    const freshSince = new Date(Date.now() - FRESH_INTAKE_HOURS * 3_600_000).toISOString();
    const freshShare = Math.max(1, Math.round(budget / 2));
    const [{ data: freshDue }, { data: oldDue }] = await Promise.all([
      admin.from('relay_lead_sequences').select('*')
        .eq('sequence_id', seq.id).eq('status', 'active')
        .lte('next_send_at', nowIso).gte('next_send_at', freshSince)
        .order('next_send_at', { ascending: false })
        .limit(freshShare),
      admin.from('relay_lead_sequences').select('*')
        .eq('sequence_id', seq.id).eq('status', 'active')
        .lte('next_send_at', nowIso)
        .order('next_send_at', { ascending: true })
        .limit(budget),
    ]);
    const picked = new Map<string, Record<string, any>>();          // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const r of (freshDue || [])) picked.set(r.id as string, r);
    for (const r of (oldDue || [])) {
      if (picked.size >= budget) break;
      picked.set(r.id as string, r);
    }
    const due = [...picked.values()].slice(0, budget);
    if (!due.length) return;

    // Everything each send needs to check, fetched once for the whole batch —
    // not three queries per person.
    const dueLeadIds = [...new Set(due.map((r) => r.lead_id).filter(Boolean) as string[])];
    const duePhones = [...new Set(due.map((r) => r.phone_e164 as string))];
    const [{ data: dueLeads }, { data: dueSupp }, ecosystem, alreadyReplied, fromBefore] = await Promise.all([
      dueLeadIds.length
        ? admin.from('leads').select('id, stage, full_name, visa_type').in('id', dueLeadIds)
        : Promise.resolve({ data: [] as { id: string; stage: string; full_name: string | null; visa_type: string | null }[] }),
      admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', ws).in('phone_e164', duePhones),
      ecosystemStates(admin, ws, duePhones),
      noReply
        ? repliedSinceFirstMessage(admin, ws, due as { phone_e164: string; enrolled_at: string | null }[])
        : Promise.resolve(new Set<string>()),
      noReply
        ? beforeChaseStart(admin, ws, due as { phone_e164: string; enrolled_at: string | null }[])
        : Promise.resolve(new Set<string>()),
    ]);
    const leadById = new Map((dueLeads || []).map((l) => [l.id, l]));
    const optedOut = new Set((dueSupp || []).map((x) => x.phone_e164 as string));
    const stamp = () => new Date().toISOString();

    // A deliberately slow sequence goes ONE AT A TIME. After a spam-rate
    // penalty the point of a low hourly cap is a trickle, and three messages
    // landing in the same second is not a trickle.
    const concurrency = perHour > 0 && perHour <= 5 ? 1 : SEND_CONCURRENCY;

    await forEachLimited(due, concurrency, () => !ctx || ctx.hasTime(), async (row) => {
      const step = (steps as Step[]).find((st) => st.step_no === row.current_step + 1);
      if (!step) {
        await admin.from('relay_lead_sequences').update({
          status: 'completed', exit_reason: 'done', exited_at: stamp(), updated_at: stamp(),
        }).eq('id', row.id);
        report.completed++;
        return;
      }

      // Did this lead move out of the audience since enrolling? Someone who
      // has turned hot, converted, or been marked junk should not keep getting
      // cold follow-ups — that is the embarrassing kind of automation.
      const cur = row.lead_id ? leadById.get(row.lead_id) : undefined;
      if (cur) {
        const out = noReply
          ? ['junk', 'won', 'lost'].includes(cur.stage || '')   // chase: only these disqualify
          : !stages.includes(cur.stage);                          // backlog: must match audience
        if (out) {
          await admin.from('relay_lead_sequences').update({
            status: 'stopped', exit_reason: `stage changed to ${cur.stage}`, exited_at: stamp(), updated_at: stamp(),
          }).eq('id', row.id);
          report.skipped.push(`${row.phone_e164}: now ${cur.stage}`);
          return;
        }
      }

      // From before the chase's start date: left alone, by decision.
      if (fromBefore.has(row.phone_e164)) {
        await admin.from('relay_lead_sequences').update({
          status: 'stopped', exit_reason: 'before 29 Sep 2026: backlog left alone',
          exited_at: stamp(), updated_at: stamp(),
        }).eq('id', row.id);
        report.skipped.push(`${row.phone_e164}: first message before 29 Sep — left alone`);
        return;
      }

      // They wrote back. Whoever put them here, whenever, the chase is over.
      if (alreadyReplied.has(row.phone_e164)) {
        await admin.from('relay_lead_sequences').update({
          status: 'replied', exit_reason: 'replied (checked before sending)',
          exited_at: stamp(), updated_at: stamp(),
        }).eq('id', row.id);
        report.skipped.push(`${row.phone_e164}: already replied`);
        return;
      }

      // Meta's per-person cap: three strikes and out; before that, a pause.
      const eco = ecosystem.get(row.phone_e164);
      if (eco?.stopped) {
        await admin.from('relay_lead_sequences').update({
          status: 'stopped',
          exit_reason: 'ecosystem: refused by Meta 3 times, after a 4-day and a 10-day pause',
          exited_at: stamp(), updated_at: stamp(),
        }).eq('id', row.id);
        report.skipped.push(`${row.phone_e164}: Meta refused 3 times — stopped for good`);
        return;
      }
      if (heldByEcosystem(eco)) {
        // Same step, later: the reminder they were due is simply moved to the
        // day the pause ends. Nothing is skipped and nothing is sent early.
        await admin.from('relay_lead_sequences').update({
          next_send_at: eco!.pausedUntil, updated_at: stamp(),
        }).eq('id', row.id);
        report.skipped.push(`${row.phone_e164}: paused by Meta's cap until ${eco!.pausedUntil!.slice(0, 10)} (strike ${eco!.strikes})`);
        return;
      }

      // A STOP that arrived after enrolment still wins.
      if (optedOut.has(row.phone_e164)) {
        await admin.from('relay_lead_sequences').update({
          status: 'stopped', exit_reason: 'stop_optout', exited_at: stamp(), updated_at: stamp(),
        }).eq('id', row.id);
        report.skipped.push(`${row.phone_e164}: opted out`);
        return;
      }

      if (ctx && !ctx.takeSend()) return;   // out of time or budget: next run

      const { data: convId } = await admin.rpc('relay_get_or_create_conversation', {
        p_workspace_id: ws, p_phone_e164: row.phone_e164,
      });
      if (!convId) {
        ctx?.giveBackSend();
        await admin.from('relay_lead_sequences').update({
          status: 'skipped', exit_reason: 'bad_phone', exited_at: stamp(), updated_at: stamp(),
        }).eq('id', row.id);
        report.skipped.push(`${row.phone_e164}: no conversation`);
        return;
      }

      const r = await sendTemplateToLead(admin, {
        workspaceId: ws, conversationId: convId as string, phoneE164: row.phone_e164,
        templateName: step.template_name, language: step.template_language || 'en',
        lead: cur ? { full_name: cur.full_name, visa_type: cur.visa_type } : {},
      }, ctx);

      // A timeout is "delivery unknown", not a failure: the provider usually
      // did send it. Advancing keeps the lead in the sequence and avoids a
      // duplicate; if the webhook never confirms it within half an hour, the
      // repair pass sends it again.
      const counted = r.ok || r.timedOut;

      await admin.from('relay_sequence_sends').insert({
        workspace_id: ws, sequence_id: seq.id, lead_id: row.lead_id,
        phone_e164: row.phone_e164, step_no: step.step_no,
        template_name: step.template_name, message_id: r.messageId,
        ok: counted, error: r.error,
      });

      if (!counted) {
        // A hard provider rejection would fail identically tomorrow; keep the
        // reason and move on rather than hammering the same wall every tick.
        await admin.from('relay_lead_sequences').update({
          status: 'skipped', exit_reason: `send_failed: ${(r.error || '').slice(0, 160)}`,
          exited_at: stamp(), updated_at: stamp(),
        }).eq('id', row.id);
        report.skipped.push(`${row.phone_e164}: ${r.error}`);
        return;
      }

      report.sent++;
      const next = (steps as Step[]).find((st) => st.step_no === step.step_no + 1);
      if (next) {
        await admin.from('relay_lead_sequences').update({
          current_step: step.step_no, last_sent_at: stamp(),
          next_send_at: new Date(Date.now() + gapMs(next)).toISOString(), updated_at: stamp(),
        }).eq('id', row.id);
      } else {
        await admin.from('relay_lead_sequences').update({
          current_step: step.step_no, last_sent_at: stamp(),
          status: 'completed', exit_reason: 'done', exited_at: stamp(), updated_at: stamp(),
        }).eq('id', row.id);
        report.completed++;
      }
    });
    };

    await sendDue();
    if (!ctx || ctx.hasTime()) await housekeeping();
  };
  await forEachLimited(sequences, 3, () => !ctx || ctx.hasTime(), runOne);
  return reports;
}
