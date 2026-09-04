-- =============================================================================
-- 117 — HOW FAST THE MESSAGES GO OUT
-- -----------------------------------------------------------------------------
-- One number: how many messages this sequence may send in any clock hour.
-- Five an hour across a 9am–7pm window is 50 a day, arriving in small batches
-- through the day instead of the whole queue emptying in the first ten minutes.
--
-- null or 0 = no hourly limit (the old behaviour).
--
-- Retrying a bounced message needs no schema: the attempt history already
-- lives in relay_sequence_sends, and the outcome in relay_messages.status.
--
-- Safe to run twice.
-- =============================================================================

alter table public.relay_sequences
  add column if not exists per_hour_cap int;

-- Existing sequences keep the daily number you already chose, spread evenly
-- across their own sending window (a 50/day, 9–19 sequence becomes 5/hour).
update public.relay_sequences s
   set per_hour_cap = greatest(1, ceil(
         (select r.per_day from public.relay_sequence_ramp r
           where r.sequence_id = s.id order by r.stage_no limit 1)::numeric
         / nullif(greatest(1, s.send_end_hour - s.send_start_hour), 0)))
 where per_hour_cap is null
   and exists (select 1 from public.relay_sequence_ramp r where r.sequence_id = s.id);

do $$ begin raise notice '117 DONE: hourly pacing ready.'; end $$;
