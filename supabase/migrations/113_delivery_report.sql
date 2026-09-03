-- =============================================================================
-- 113 — DELIVERY REPORT for the follow-up sequence
-- -----------------------------------------------------------------------------
-- Every sequence send points at its chat message, and the chat message carries
-- the live WhatsApp receipt (sent -> delivered -> read, or failed). This
-- function rolls those up so the sequence page can show, in one glance:
-- how many went out, reached the phone, were read, or bounced.
--
-- Safe to run twice.
-- =============================================================================

create or replace function public.relay_sequence_delivery(p_sequence_id uuid)
returns table (sent bigint, delivered bigint, read bigint, failed bigint)
language sql stable security definer set search_path = public as $fn$
  select
    count(*) filter (where m.status in ('sent','delivered','read'))            as sent,
    count(*) filter (where m.status in ('delivered','read'))                   as delivered,
    count(*) filter (where m.status = 'read')                                  as read,
    count(*) filter (where m.status = 'failed' or s.ok = false)                as failed
  from public.relay_sequence_sends s
  left join public.relay_messages m on m.id = s.message_id
  where s.sequence_id = p_sequence_id;
$fn$;

grant execute on function public.relay_sequence_delivery(uuid) to authenticated, service_role;

do $$ begin raise notice '113 DONE: delivery report ready.'; end $$;
