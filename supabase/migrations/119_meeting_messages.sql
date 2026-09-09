-- =============================================================================
-- 119 — MEETING MESSAGES: PC1 when a call is booked, PC2 when it is completed
-- -----------------------------------------------------------------------------
-- WHAT THIS ADDS
--
--   meetings.completed_at        the moment a meeting was first marked completed.
--                                Stamped by a trigger, never hand-typed, so the
--                                automation has an honest timestamp to work from
--                                (updated_at moves whenever a note is edited).
--
--   meeting_reminders 'thanks'   queued by the same trigger: the CRM's existing
--                                reminder cron sends it as the PC2 thank-you
--                                email. Nothing new to schedule.
--
--   relay_automation_sent.meeting_id
--                                one row per meeting per rule, enforced by a
--                                unique index. A meeting can never be messaged
--                                twice, however many times the tick runs.
--
--   relay_automations rows       meeting_booked  -> pc1
--                                meeting_completed -> pc2
--                                Both created OFF. Switching one on stamps
--                                activated_at, so only meetings from that
--                                moment forward are ever touched — the 234
--                                historical meetings are left alone.
--
-- WHY THE TRIGGER IS WRAPPED
-- It fires inside the CRM's own "mark completed" update. If queueing the email
-- fails for any reason, that must not roll back the status change: a thank-you
-- email is worth less than the meeting record itself. So the insert is caught
-- and reported as a notice, and the status change goes through regardless.
--
-- Idempotent. Safe to run twice.
-- =============================================================================

-- ── 1. completed_at ─────────────────────────────────────────────────────────
alter table public.meetings add column if not exists completed_at timestamptz;

create index if not exists idx_meetings_completed_at
  on public.meetings (workspace_id, completed_at)
  where completed_at is not null;

-- Backfill from updated_at for meetings already completed, so the column is
-- never null for a completed row. These are all BEFORE any activated_at, so
-- the automation will never pick them up — the value is for reporting only.
update public.meetings
   set completed_at = coalesce(completed_at, updated_at, created_at)
 where status = 'completed' and completed_at is null;

-- ── 2. the trigger ──────────────────────────────────────────────────────────
create or replace function public.meetings_on_completed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only the FIRST transition into 'completed'. Completed -> no_show ->
  -- completed again must not send a second thank-you.
  if new.status = 'completed'
     and (old.status is distinct from 'completed')
     and new.completed_at is null then

    new.completed_at := now();

    -- The thank-you email, drained by the CRM's reminder cron. Wrapped so a
    -- constraint on meeting_reminders can never block the status change.
    begin
      insert into public.meeting_reminders (meeting_id, workspace_id, kind, send_at, status, attempts)
      values (new.id, new.workspace_id, 'thanks', now(), 'queued', 0);
    exception when others then
      raise notice '119: could not queue thank-you email for meeting % (%)', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_meetings_on_completed on public.meetings;
create trigger trg_meetings_on_completed
  before update of status on public.meetings
  for each row execute function public.meetings_on_completed();

-- ── 3. one message per meeting per rule ─────────────────────────────────────
alter table public.relay_automation_sent add column if not exists meeting_id uuid;

create unique index if not exists uq_relay_automation_sent_meeting
  on public.relay_automation_sent (automation_key, meeting_id)
  where meeting_id is not null;

-- ── 4. the two rules, OFF ───────────────────────────────────────────────────
insert into public.relay_automations
  (workspace_id, key, enabled, template_name, template_language,
   delay_seconds, delay_minutes, daily_cap, quiet_start_hour, quiet_end_hour)
select w.id, r.key, false, r.template_name, 'en', 30, 0, 200, 21, 9
  from public.workspaces w
 cross join (values ('meeting_booked', 'pc1'), ('meeting_completed', 'pc2')) as r(key, template_name)
 where not exists (
   select 1 from public.relay_automations a
    where a.workspace_id = w.id and a.key = r.key
 );

-- ── 5. verification ─────────────────────────────────────────────────────────
select key, enabled, template_name, activated_at
  from public.relay_automations
 where key in ('new_lead_first', 'meeting_booked', 'meeting_completed')
 order by key;
