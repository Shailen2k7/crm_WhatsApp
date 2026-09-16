-- =============================================================================
-- 120 — RETIRE THE pg_cron AUTOMATION JOBS
-- -----------------------------------------------------------------------------
-- These two Supabase pg_cron jobs are the "external cron from Singapore": the
-- Supabase database runs in AWS Singapore and calls the tick over HTTP.
--
--   migrizo-relay-new-lead-fast   every 10 seconds  (added in migration 118)
--   migrizo-relay-automation-tick every 2 minutes
--
-- The automation now runs from the Netlify Scheduled Function
-- "automation-tick" every 5 minutes, and the tick no longer accepts the old
-- secret these jobs send — so once deployed they only receive a fast 401.
--
-- RUN THIS ONLY AFTER Netlify → Functions → automation-tick → Logs shows
-- successful runs ("HTTP 200 ... ok:true"). Safe to run twice.
-- =============================================================================

-- 1. BEFORE: every job that calls the automation, whatever it is named.
select jobid, jobname, schedule, active, left(command, 120) as command
  from cron.job
 where command ilike '%automation/tick%'
 order by jobname;

-- 2. Unschedule all of them.
do $$
declare j record;
begin
  for j in select jobid, jobname from cron.job where command ilike '%automation/tick%' loop
    perform cron.unschedule(j.jobid);
    raise notice 'unscheduled job % (%)', j.jobid, j.jobname;
  end loop;
end $$;

-- 3. AFTER: must return no rows.
select jobid, jobname, schedule from cron.job where command ilike '%automation/tick%';
