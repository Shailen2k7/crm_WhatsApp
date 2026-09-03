-- =============================================================================
--  RUN THIS ONE FILE  —  the two migrations still outstanding (113 + 114)
-- -----------------------------------------------------------------------------
--  Everything before this (108–112) is already applied to your database;
--  this is the only SQL left. Safe to run twice.
--
--  113 — the delivery report on the Follow-up sequence page (Sent / Delivered /
--        Read / Bounced). Without it that card just shows zeros.
--  114 — lets the new-lead wait be set in SECONDS (10s / 30s / 1 min).
--        Without it the dropdown will not save your choice.
-- =============================================================================


-- ═══ 113 ═══ Delivery report ════════════════════════════════════════════════
-- Each sequence send points at its chat message, and that message carries the
-- live WhatsApp receipt (sent -> delivered -> read, or failed). This rolls the
-- receipts up so the page can show them at a glance.

create or replace function public.relay_sequence_delivery(p_sequence_id uuid)
returns table (sent bigint, delivered bigint, read bigint, failed bigint)
language sql stable security definer set search_path = public as $fn$
  select
    count(*) filter (where m.status in ('sent','delivered','read'))  as sent,
    count(*) filter (where m.status in ('delivered','read'))         as delivered,
    count(*) filter (where m.status = 'read')                        as read,
    count(*) filter (where m.status = 'failed' or s.ok = false)      as failed
  from public.relay_sequence_sends s
  left join public.relay_messages m on m.id = s.message_id
  where s.sequence_id = p_sequence_id;
$fn$;

grant execute on function public.relay_sequence_delivery(uuid) to authenticated, service_role;


-- ═══ 114 ═══ New-lead wait, in seconds ══════════════════════════════════════
-- The wait was stored in whole minutes, so one minute was the shortest pause
-- possible. delay_minutes is left in place and simply unused, so a deploy
-- still running the previous build during a rollout keeps working.

alter table public.relay_automations
  add column if not exists delay_seconds int not null default 60;

update public.relay_automations
   set delay_seconds = greatest(10, least(3600, coalesce(delay_minutes, 1) * 60))
 where delay_seconds = 60
   and coalesce(delay_minutes, 1) <> 1;


-- ═══ CHECK ═══ both rows should come back ═══════════════════════════════════
select 'delivery report' as thing,
       count(*)::text as result
  from pg_proc where proname = 'relay_sequence_delivery'
union all
select 'delay_seconds column',
       count(*)::text
  from information_schema.columns
 where table_name = 'relay_automations' and column_name = 'delay_seconds';
