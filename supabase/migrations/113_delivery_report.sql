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


-- ═══ Why did they bounce? ═══════════════════════════════════════════════════
-- "Bounced: 7" is not actionable. The reason is: Meta's 131049 means the
-- marketing frequency cap, which calls for slowing down or switching those
-- templates to UTILITY — a completely different response from a dead number.

create or replace function public.relay_sequence_failures(p_sequence_id uuid)
returns table (code text, detail text, hits bigint)
language sql stable security definer set search_path = public as $fn$
  select
    coalesce(m.error_code, 'unknown')                as code,
    coalesce(left(m.error_detail, 120), 'No detail') as detail,
    count(*)                                         as hits
  from public.relay_sequence_sends s
  join public.relay_messages m on m.id = s.message_id
  where s.sequence_id = p_sequence_id
    and m.status = 'failed'
  group by 1, 2
  order by hits desc
  limit 5;
$fn$;

grant execute on function public.relay_sequence_failures(uuid) to authenticated, service_role;
