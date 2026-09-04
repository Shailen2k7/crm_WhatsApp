// =============================================================================
// SEQUENCE ENGINE — runs the C1–C8 follow-up machine.
// -----------------------------------------------------------------------------
// Called from the 2-minute automation tick. Each pass, for every RUNNING
// sequence:
//
//   1. ENROL — top up today's intake to the ramp limit (80/day -> 150 -> 200…),
//      OLDEST leads first, so the whole database is eventually covered.
//   2. SEND  — deliver every step that has come due, a few per tick so a
//      serverless invocation never runs long. 2-minute ticks over a 12-hour
//      sending window give ~1,000 messages/day of headroom at 3 per tick.
//
// A lead leaves the machine by replying (webhook flips them to 'replied'),
// finishing every step ('completed'), opting out ('stopped'), or having a
// send fail hard ('skipped', with the reason kept).
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { toE164 } from '@/lib/phone';
import { sendTemplateToLead } from '@/lib/send-template';

const IST = 'Asia/Kolkata';
const SEND_BUDGET_PER_TICK = 3;      // stays well inside a serverless time limit
const ENROL_PAGE = 400;              // leads read per query when topping up
// The oldest leads are enrolled first, so once the front of the database is in
// the machine every page we read is full of people we have already got. Walking
// several pages keeps finding new ones; without this, enrolment silently stops
// the day the enrolled count passes one page.
const ENROL_MAX_PAGES = 30;          // up to 12,000 oldest leads scanned per tick

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

  const toRetry: { phone: string; step: number; at: string }[] = [];
  for (const [k, s] of latest) {
    const m = byId.get(s.message_id as string);
    if (!m || m.status !== 'failed') continue;
    if (!RETRYABLE_CODES.has(String(m.error_code || ''))) continue;
    if ((attempts.get(k) || 0) >= MAX_ATTEMPTS_PER_STEP) continue;
    toRetry.push({ phone: s.phone_e164, step: s.step_no, at: retryAtFrom(s.sent_at) });
  }
  if (!toRetry.length) return 0;

  let repaired = 0;
  for (let i = 0; i < toRetry.length; i += 25) {
    const results = await Promise.all(toRetry.slice(i, i + 25).map((r) =>
      admin.from('relay_lead_sequences')
        .update({ current_step: r.step - 1, next_send_at: r.at, updated_at: new Date().toISOString() })
        .eq('sequence_id', seqId).eq('phone_e164', r.phone)
        .eq('status', 'active')
        .eq('current_step', r.step)      // only if they are still sitting where that send left them
        .select('id')));
    repaired += results.reduce((n, r) => n + (r.data?.length || 0), 0);
  }
  return repaired;
}

export async function runSequences(admin: SupabaseClient): Promise<SequenceReport[]> {
  const { data: sequences } = await admin
    .from('relay_sequences')
    .select('*')
    .eq('status', 'running');
  if (!sequences?.length) return [];

  const reports: SequenceReport[] = [];
  for (const seq of sequences) {
    const report: SequenceReport = { sequence: seq.name, enrolled: 0, sent: 0, completed: 0, retried: 0, skipped: [] };
    reports.push(report);

    const ws = seq.workspace_id as string;
    const [{ data: steps }, { data: ramp }] = await Promise.all([
      admin.from('relay_sequence_steps').select('*').eq('sequence_id', seq.id).order('step_no'),
      admin.from('relay_sequence_ramp').select('*').eq('sequence_id', seq.id).order('stage_no'),
    ]);
    if (!steps?.length) { report.note = 'No steps configured.'; continue; }

    // ---- 1. ENROL: top up today's intake, oldest leads first ---------------
    const day = rampDay(seq.started_at || new Date().toISOString());
    const limit = intakeLimitFor(day, (ramp || []) as Ramp[]);
    const dayStartIst = new Date(`${istDate()}T00:00:00+05:30`).toISOString();

    const { count: enrolledToday } = await admin
      .from('relay_lead_sequences')
      .select('id', { count: 'exact', head: true })
      .eq('sequence_id', seq.id)
      .gte('enrolled_at', dayStartIst);
    let room = Math.max(0, limit - (enrolledToday ?? 0));

    const stages = seq.audience === 'both' ? ['cold', 'hot'] : [seq.audience];
    const noReply = seq.trigger_mode === 'no_reply';

    // Industry filter: null/empty = everyone; '(none)' matches a blank industry.
    const industries: string[] | null =
      Array.isArray(seq.industries) && seq.industries.length ? seq.industries : null;
    const industryOk = (ind: string | null | undefined) =>
      !industries || industries.includes((ind || '').trim() || '(none)');

    if (room > 0) {
      const [{ data: already }, { data: suppressed }, { data: busyElsewhere }] = await Promise.all([
        admin.from('relay_lead_sequences').select('lead_id, phone_e164').eq('sequence_id', seq.id),
        admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', ws),
        // Someone mid-way through another machine is already hearing from us.
        // Two sequences messaging the same person on the same day is the
        // fastest way to look like a robot, so they wait their turn.
        admin.from('relay_lead_sequences')
          .select('lead_id, phone_e164').eq('workspace_id', ws)
          .eq('status', 'active').neq('sequence_id', seq.id),
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
        const horizon = new Date(Date.now() - 14 * 86_400_000).toISOString();

        for (let page = 0; room > 0 && page < ENROL_MAX_PAGES; page++) {
          const { data: firstSends } = await admin
            .from('relay_automation_sent')
            .select('lead_id, phone_e164, sent_at')
            .eq('workspace_id', ws).eq('automation_key', 'new_lead_first')
            .eq('ok', true).gte('sent_at', horizon)
            .order('sent_at', { ascending: true })
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
      } else {
        // ---- OLDEST FIRST through the backlog -------------------------------
        // Pages forward until today's room is filled. The first pages are
        // people already enrolled; walking past them is what keeps the intake
        // running once the front of the database is covered.
        for (let page = 0; room > 0 && page < ENROL_MAX_PAGES; page++) {
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

    // ---- 2. Give bounced messages another go -------------------------------
    report.retried = await repairBouncedSends(admin, seq.id, ws);

    // ---- 3. SEND what is due, inside sending hours -------------------------
    if (seq.hours_enabled) {
      const h = istHour();
      if (h < seq.send_start_hour || h >= seq.send_end_hour) {
        report.note = `Outside sending hours (${seq.send_start_hour}:00–${seq.send_end_hour}:00 IST).`;
        continue;
      }
    }

    // Spread the day out instead of emptying the queue in the first ten
    // minutes: at 5 an hour over a 9am–7pm window that is 50 a day, arriving
    // like a person sending them rather than a machine dumping them.
    let budget = SEND_BUDGET_PER_TICK;
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
        continue;
      }
    }

    const { data: due } = await admin
      .from('relay_lead_sequences')
      .select('*')
      .eq('sequence_id', seq.id)
      .eq('status', 'active')
      .lte('next_send_at', new Date().toISOString())
      .order('next_send_at', { ascending: true })
      .limit(budget);

    for (const row of due || []) {
      const step = (steps as Step[]).find((s) => s.step_no === row.current_step + 1);
      if (!step) {
        await admin.from('relay_lead_sequences').update({
          status: 'completed', exit_reason: 'done', exited_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        report.completed++;
        continue;
      }

      // Did this lead move out of the audience since enrolling? Someone who
      // has turned hot, converted, or been marked junk should not keep getting
      // cold follow-ups — that is the embarrassing kind of automation.
      if (row.lead_id) {
        const { data: cur } = await admin.from('leads').select('stage').eq('id', row.lead_id).maybeSingle();
        const out = noReply
          ? ['junk', 'won', 'lost'].includes(cur?.stage || '')   // chase: only these disqualify
          : !!cur && !stages.includes(cur.stage);                // backlog: must match audience
        if (cur && out) {
          await admin.from('relay_lead_sequences').update({
            status: 'stopped', exit_reason: `stage changed to ${cur.stage}`,
            exited_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }).eq('id', row.id);
          report.skipped.push(`${row.phone_e164}: now ${cur.stage}`);
          continue;
        }
      }

      // A STOP that arrived after enrolment still wins.
      const { data: sup } = await admin
        .from('relay_suppressions')
        .select('id').eq('workspace_id', ws).eq('phone_e164', row.phone_e164).maybeSingle();
      if (sup) {
        await admin.from('relay_lead_sequences').update({
          status: 'stopped', exit_reason: 'stop_optout', exited_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        report.skipped.push(`${row.phone_e164}: opted out`);
        continue;
      }

      const { data: lead } = row.lead_id
        ? await admin.from('leads').select('full_name, visa_type').eq('id', row.lead_id).maybeSingle()
        : { data: null };

      const { data: convId } = await admin.rpc('relay_get_or_create_conversation', {
        p_workspace_id: ws, p_phone_e164: row.phone_e164,
      });
      if (!convId) {
        await admin.from('relay_lead_sequences').update({
          status: 'skipped', exit_reason: 'bad_phone', exited_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        report.skipped.push(`${row.phone_e164}: no conversation`);
        continue;
      }

      const r = await sendTemplateToLead(admin, {
        workspaceId: ws, conversationId: convId as string, phoneE164: row.phone_e164,
        templateName: step.template_name, language: step.template_language || 'en',
        lead: lead || {},
      });

      await admin.from('relay_sequence_sends').insert({
        workspace_id: ws, sequence_id: seq.id, lead_id: row.lead_id,
        phone_e164: row.phone_e164, step_no: step.step_no,
        template_name: step.template_name, message_id: r.messageId,
        ok: r.ok, error: r.error,
      });

      if (!r.ok) {
        // A hard provider rejection would fail identically tomorrow; keep the
        // reason and move on rather than hammering the same wall every tick.
        await admin.from('relay_lead_sequences').update({
          status: 'skipped', exit_reason: `send_failed: ${(r.error || '').slice(0, 160)}`,
          exited_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        report.skipped.push(`${row.phone_e164}: ${r.error}`);
        continue;
      }

      report.sent++;
      const next = (steps as Step[]).find((s) => s.step_no === step.step_no + 1);
      if (next) {
        const nextAt = new Date(Date.now() + gapMs(next)).toISOString();
        await admin.from('relay_lead_sequences').update({
          current_step: step.step_no, last_sent_at: new Date().toISOString(),
          next_send_at: nextAt, updated_at: new Date().toISOString(),
        }).eq('id', row.id);
      } else {
        await admin.from('relay_lead_sequences').update({
          current_step: step.step_no, last_sent_at: new Date().toISOString(),
          status: 'completed', exit_reason: 'done', exited_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        report.completed++;
      }
    }
  }
  return reports;
}
