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
const ENROL_BATCH = 400;             // leads examined per tick when topping up

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

interface Step { step_no: number; template_name: string; template_language: string; gap_days: number }

export interface SequenceReport {
  sequence: string;
  enrolled: number;
  sent: number;
  completed: number;
  skipped: string[];
  note?: string;
}

export async function runSequences(admin: SupabaseClient): Promise<SequenceReport[]> {
  const { data: sequences } = await admin
    .from('relay_sequences')
    .select('*')
    .eq('status', 'running');
  if (!sequences?.length) return [];

  const reports: SequenceReport[] = [];
  for (const seq of sequences) {
    const report: SequenceReport = { sequence: seq.name, enrolled: 0, sent: 0, completed: 0, skipped: [] };
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

    if (room > 0) {
      const stages = seq.audience === 'both' ? ['cold', 'hot'] : [seq.audience];
      // OLDEST FIRST — the whole point: every lead is eventually covered.
      const { data: leads } = await admin
        .from('leads')
        .select('id, full_name, phone, visa_type, created_at, is_sample')
        .eq('workspace_id', ws)
        .in('stage', stages)
        .order('created_at', { ascending: true })
        .limit(ENROL_BATCH);

      const [{ data: already }, { data: suppressed }] = await Promise.all([
        admin.from('relay_lead_sequences').select('lead_id, phone_e164').eq('sequence_id', seq.id),
        admin.from('relay_suppressions').select('phone_e164').eq('workspace_id', ws),
      ]);
      const doneLeads = new Set((already || []).map((a) => a.lead_id).filter(Boolean));
      const donePhones = new Set((already || []).map((a) => a.phone_e164));
      const stopPhones = new Set((suppressed || []).map((s) => s.phone_e164));

      for (const lead of leads || []) {
        if (room <= 0) break;
        if (lead.is_sample || doneLeads.has(lead.id)) continue;
        const phone = toE164(lead.phone);
        if (!phone || donePhones.has(phone) || stopPhones.has(phone)) continue;

        const { error } = await admin.from('relay_lead_sequences').insert({
          workspace_id: ws, sequence_id: seq.id, lead_id: lead.id,
          phone_e164: phone, status: 'active', current_step: 0,
          next_send_at: new Date().toISOString(),
        });
        if (!error) { donePhones.add(phone); room--; report.enrolled++; }
      }
    }

    // ---- 2. SEND what is due, inside sending hours -------------------------
    if (seq.hours_enabled) {
      const h = istHour();
      if (h < seq.send_start_hour || h >= seq.send_end_hour) {
        report.note = `Outside sending hours (${seq.send_start_hour}:00–${seq.send_end_hour}:00 IST).`;
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
      .limit(SEND_BUDGET_PER_TICK);

    for (const row of due || []) {
      const step = (steps as Step[]).find((s) => s.step_no === row.current_step + 1);
      if (!step) {
        await admin.from('relay_lead_sequences').update({
          status: 'completed', exit_reason: 'done', exited_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        report.completed++;
        continue;
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
        const nextAt = new Date(Date.now() + next.gap_days * 86_400_000).toISOString();
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
