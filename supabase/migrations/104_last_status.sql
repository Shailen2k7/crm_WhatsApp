-- =============================================================================
-- 104 — DELIVERY STATUS ON THE CHAT LIST
-- -----------------------------------------------------------------------------
-- The list row showed a double tick for every outbound message regardless of
-- what actually happened to it — decoration, not information. To colour it
-- honestly the row needs to know the status of its own last message, so that
-- status is denormalised onto the conversation.
--
-- Two triggers keep it true:
--   INSERT on relay_messages  -> the new message IS the last one
--   UPDATE of status          -> a receipt arrived; if it belongs to the last
--                                message, the row follows it
--
-- Idempotent. Safe to run twice.
-- =============================================================================

alter table public.relay_conversations
  add column if not exists last_status text;

-- ── keep last_status current on new messages ─────────────────────────────────
create or replace function public.relay_touch_conversation()
returns trigger language plpgsql as $$
begin
  update public.relay_conversations c
     set last_message_at  = new.created_at,
         last_direction   = new.direction,
         last_status      = new.status,
         last_preview     = left(coalesce(nullif(new.body, ''), '[media]'), 140),
         last_inbound_at  = case when new.direction = 'in'  then new.created_at else c.last_inbound_at  end,
         last_outbound_at = case when new.direction = 'out' then new.created_at else c.last_outbound_at end,
         unread_count     = case when new.direction = 'in' then c.unread_count + 1 else 0 end,
         updated_at       = now()
   where c.id = new.conversation_id;
  return new;
end $$;

drop trigger if exists trg_relay_touch_conversation on public.relay_messages;
create trigger trg_relay_touch_conversation
  after insert on public.relay_messages
  for each row execute procedure public.relay_touch_conversation();

-- ── follow a delivery receipt ────────────────────────────────────────────────
-- Only when the updated row IS the conversation's most recent message; a
-- receipt for an older message must not rewrite the row's summary.
create or replace function public.relay_status_to_conversation()
returns trigger language plpgsql as $$
declare v_latest uuid;
begin
  if new.status is distinct from old.status then
    select id into v_latest
      from public.relay_messages
     where conversation_id = new.conversation_id
     order by created_at desc
     limit 1;

    if v_latest = new.id then
      update public.relay_conversations
         set last_status = new.status, updated_at = now()
       where id = new.conversation_id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_relay_status_to_conversation on public.relay_messages;
create trigger trg_relay_status_to_conversation
  after update of status on public.relay_messages
  for each row execute procedure public.relay_status_to_conversation();

-- ── backfill existing rows ───────────────────────────────────────────────────
update public.relay_conversations c
   set last_status = m.status
  from (
    select distinct on (conversation_id) conversation_id, status
      from public.relay_messages
     order by conversation_id, created_at desc
  ) m
 where m.conversation_id = c.id
   and c.last_status is distinct from m.status;

do $$ begin raise notice '104 DONE: last_status live on relay_conversations.'; end $$;
