-- =============================================================================
-- 118 — ANSWER A NEW LEAD IN SECONDS, NOT MINUTES
-- -----------------------------------------------------------------------------
-- The every-2-minute job stays exactly as it is: it runs the C1–C8 chase, the
-- no-reply chase and the campaigns, all of which are paced by the hour and
-- would be pure waste to repeat every few seconds.
--
-- This adds a SECOND job on a 10-second beat that hits ?scope=new_leads. That
-- scope does the first-message rule only and returns — one cheap query when
-- there is nothing waiting.
--
--   worst case = the rule's own delay (5s) + up to 10s of waiting = 15 seconds
--
-- The delay is not dead time: it is there so that if the customer WhatsApps us
-- straight after the form, their message lands first and we can answer with the
-- full quick reply instead of a bare template.
--
-- Safe to run twice.
-- =============================================================================

-- Answer as fast as the beat allows.
update public.relay_automations
   set delay_seconds = 5, updated_at = now()
 where key = 'new_lead_first' and coalesce(delay_seconds, 60) > 5;

-- Replace any previous copy of the fast job.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'migrizo-relay-new-lead-fast') then
    perform cron.unschedule('migrizo-relay-new-lead-fast');
  end if;
end $$;

do $$
begin
  -- pg_cron 1.5+ understands a plain interval. This is the one we want.
  perform cron.schedule('migrizo-relay-new-lead-fast', '10 seconds', $CRON$
    select net.http_post(
      url     := 'https://chat.migrizo.com/api/automation/tick?scope=new_leads',
      headers := '{"Content-Type":"application/json","x-cron-secret":"1c42a339806b344e2a5298aea20fa3343b885a25e079d017"}'::jsonb,
      body    := '{}'::jsonb
    );
  $CRON$);
  raise notice '118: fast lane scheduled every 10 seconds.';
exception when others then
  -- Older pg_cron only does minutes. One a minute is still a big improvement
  -- on one every two, and nothing else has to change.
  raise notice '118: sub-minute cron unavailable (%), falling back to every minute.', sqlerrm;
  perform cron.schedule('migrizo-relay-new-lead-fast', '* * * * *', $CRON$
    select net.http_post(
      url     := 'https://chat.migrizo.com/api/automation/tick?scope=new_leads',
      headers := '{"Content-Type":"application/json","x-cron-secret":"1c42a339806b344e2a5298aea20fa3343b885a25e079d017"}'::jsonb,
      body    := '{}'::jsonb
    );
  $CRON$);
end $$;

-- ═══ CHECK ═══ both jobs should be listed, and the delay should read 5 ═══════
select jobname, schedule, active from cron.job
 where jobname in ('migrizo-relay-automation-tick', 'migrizo-relay-new-lead-fast')
 order by jobname;
select key, delay_seconds, daily_cap, enabled from public.relay_automations where key = 'new_lead_first';
