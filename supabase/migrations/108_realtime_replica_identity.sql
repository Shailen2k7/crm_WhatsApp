-- =============================================================================
-- 108 — MAKE REALTIME ACTUALLY DELIVER (the "chats need a refresh" fix)
-- -----------------------------------------------------------------------------
-- The relay tables are in the supabase_realtime publication, yet inbound
-- messages did not appear until the user refreshed. Root cause:
--
--   Supabase Realtime honours RLS. For every change it must decide whether the
--   subscriber may SELECT that row, by running the RLS policy against the
--   change record. Our policies key on workspace_id. But a table's DEFAULT
--   replica identity is its PRIMARY KEY ONLY (id) — so the change record handed
--   to Realtime does NOT contain workspace_id, the policy cannot be evaluated,
--   and Realtime drops the event silently.
--
-- REPLICA IDENTITY FULL puts every column into the change record, so the policy
-- can be checked and the event is delivered. This is THE fix for live updates.
--
-- Idempotent. Safe to run twice.
-- =============================================================================

alter table public.relay_messages       replica identity full;
alter table public.relay_conversations  replica identity full;
alter table public.relay_quick_replies  replica identity full;
alter table public.relay_templates       replica identity full;

-- Belt-and-braces: ensure they are actually in the publication (add is a no-op
-- if already present).
do $$
begin
  begin alter publication supabase_realtime add table public.relay_messages;      exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.relay_conversations; exception when duplicate_object then null; end;
end $$;

do $$ begin raise notice '108 DONE: replica identity full set; realtime will now deliver relay changes.'; end $$;

-- =============================================================================
-- BONUS: a readable list preview for media messages.
-- The old trigger stored the literal "[media]" when a message had no text.
-- Store the filename instead, so the chat list shows what the file is.
-- =============================================================================
create or replace function public.relay_touch_conversation()
returns trigger language plpgsql as $$
begin
  update public.relay_conversations c
     set last_message_at  = new.created_at,
         last_direction   = new.direction,
         last_status      = new.status,
         last_preview     = left(
                              coalesce(
                                nullif(new.body, ''),
                                case
                                  when new.media_name is not null then '📎 ' || new.media_name
                                  when new.media_type = 'image'    then '📷 Photo'
                                  when new.media_type is not null  then '📎 Attachment'
                                  else '[media]'
                                end
                              ), 140),
         last_inbound_at  = case when new.direction = 'in'  then new.created_at else c.last_inbound_at  end,
         last_outbound_at = case when new.direction = 'out' then new.created_at else c.last_outbound_at end,
         unread_count     = case when new.direction = 'in' then c.unread_count + 1 else 0 end,
         updated_at       = now()
   where c.id = new.conversation_id;
  return new;
end $$;

-- Backfill existing conversations whose preview is the bare "[media]".
update public.relay_conversations c
   set last_preview = left(
         coalesce(
           case when m.media_name is not null then '📎 ' || m.media_name
                when m.media_type = 'image'    then '📷 Photo'
                else '📎 Attachment' end,
           '[media]'), 140)
  from (
    select distinct on (conversation_id) conversation_id, media_name, media_type
      from public.relay_messages
     order by conversation_id, created_at desc
  ) m
 where m.conversation_id = c.id
   and c.last_preview = '[media]';

do $$ begin raise notice '108 BONUS DONE: media previews now show filenames.'; end $$;
