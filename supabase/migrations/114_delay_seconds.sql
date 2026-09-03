-- =============================================================================
-- 114 — NEW-LEAD DELAY IN SECONDS
-- -----------------------------------------------------------------------------
-- The wait before a new lead's first message was stored in whole minutes, so
-- the shortest possible pause was a full minute. The useful range is far
-- shorter than that — long enough for a click-to-WhatsApp lead's own message
-- to land first, short enough that nobody waits around. Seconds it is.
--
-- delay_minutes is left in place and simply unused: dropping it would break
-- any deploy still running the previous build during a rollout.
--
-- Safe to run twice.
-- =============================================================================

alter table public.relay_automations
  add column if not exists delay_seconds int not null default 60;

-- Carry across whatever was configured before, so nothing silently changes.
update public.relay_automations
   set delay_seconds = greatest(10, least(3600, coalesce(delay_minutes, 1) * 60))
 where delay_seconds = 60
   and coalesce(delay_minutes, 1) <> 1;

do $$ begin raise notice '114 DONE: delay_seconds ready.'; end $$;
