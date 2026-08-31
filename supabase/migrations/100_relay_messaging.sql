-- =============================================================================
-- 100 — RELAY MESSAGING
-- -----------------------------------------------------------------------------
-- Two tables, written fresh for Relay. They live in the CRM's own Postgres
-- because Relay and the CRM share one database — that is what makes a lead and
-- its conversation the same record rather than two copies kept in step.
--
-- Numbered from 100 to sit clearly above the CRM's own 0xx series and never
-- collide with a future CRM migration.
--
-- Idempotent. Safe to run twice.
-- =============================================================================

-- ── conversations ────────────────────────────────────────────────────────────
-- One row per phone number per workspace. The lead link is nullable on purpose:
-- somebody can message the business before they exist in the CRM, and losing
-- that message would be worse than holding an unlinked conversation.
create table if not exists public.relay_conversations (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  lead_id           uuid references public.leads(id) on delete set null,
  phone_e164        text not null,
  status            text not null default 'open' check (status in ('open', 'closed')),
  unread_count      int  not null default 0,
  -- Drives the WhatsApp 24-hour window. Outside it, only an approved template
  -- may be sent — this timestamp is the single source of truth for that rule.
  last_inbound_at   timestamptz,
  last_outbound_at  timestamptz,
  last_message_at   timestamptz,
  last_preview      text,
  last_direction    text check (last_direction in ('in', 'out')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, phone_e164)
);

create index if not exists idx_relay_conv_workspace
  on public.relay_conversations (workspace_id, last_message_at desc nulls last);
create index if not exists idx_relay_conv_lead
  on public.relay_conversations (lead_id) where lead_id is not null;

-- ── messages ─────────────────────────────────────────────────────────────────
create table if not exists public.relay_messages (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  conversation_id   uuid not null references public.relay_conversations(id) on delete cascade,
  direction         text not null check (direction in ('in', 'out')),
  body              text not null default '',

  -- Free-form when null; otherwise the approved template that was sent.
  template_name     text,
  template_language text,
  template_values   jsonb,

  -- Interakt's own id, returned by the send API and echoed by every status
  -- webhook. This is how a delivery receipt finds the message it belongs to.
  provider_msg_id   text,

  status            text not null default 'queued'
    check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'received')),
  error_code        text,
  error_detail      text,

  -- Media lands in Phase 4. The columns exist now so the shape never changes
  -- under a table that already holds real conversations.
  media_url         text,
  media_type        text check (media_type is null or media_type in ('image', 'document', 'audio', 'video', 'sticker')),
  media_name        text,
  media_mime        text,

  sent_by           uuid,  -- null = sent by automation, not a person
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_relay_msg_conversation
  on public.relay_messages (conversation_id, created_at);
create index if not exists idx_relay_msg_provider
  on public.relay_messages (provider_msg_id) where provider_msg_id is not null;

-- ── keep the conversation summary current ────────────────────────────────────
-- Denormalised onto the conversation so the list renders from one cheap query
-- instead of a correlated subquery per row.
create or replace function public.relay_touch_conversation()
returns trigger language plpgsql as $$
begin
  update public.relay_conversations c
     set last_message_at  = new.created_at,
         last_direction   = new.direction,
         last_preview     = left(coalesce(nullif(new.body, ''), '[media]'), 140),
         last_inbound_at  = case when new.direction = 'in'  then new.created_at else c.last_inbound_at  end,
         last_outbound_at = case when new.direction = 'out' then new.created_at else c.last_outbound_at end,
         -- An agent sending a reply has plainly read the thread.
         unread_count     = case when new.direction = 'in' then c.unread_count + 1 else 0 end,
         updated_at       = now()
   where c.id = new.conversation_id;
  return new;
end $$;

drop trigger if exists trg_relay_touch_conversation on public.relay_messages;
create trigger trg_relay_touch_conversation
  after insert on public.relay_messages
  for each row execute procedure public.relay_touch_conversation();

-- ── row level security ───────────────────────────────────────────────────────
-- Same rule the CRM uses everywhere: you see your workspace, nothing else.
-- The webhook writes with the service role, which bypasses RLS by design.
alter table public.relay_conversations enable row level security;
alter table public.relay_messages      enable row level security;

drop policy if exists "relay conv select" on public.relay_conversations;
create policy "relay conv select" on public.relay_conversations
  for select using (workspace_id in (select public.user_workspaces()));

drop policy if exists "relay conv insert" on public.relay_conversations;
create policy "relay conv insert" on public.relay_conversations
  for insert with check (workspace_id in (select public.user_workspaces()));

drop policy if exists "relay conv update" on public.relay_conversations;
create policy "relay conv update" on public.relay_conversations
  for update using (workspace_id in (select public.user_workspaces()));

drop policy if exists "relay msg select" on public.relay_messages;
create policy "relay msg select" on public.relay_messages
  for select using (workspace_id in (select public.user_workspaces()));

drop policy if exists "relay msg insert" on public.relay_messages;
create policy "relay msg insert" on public.relay_messages
  for insert with check (workspace_id in (select public.user_workspaces()));

-- ── realtime ─────────────────────────────────────────────────────────────────
-- Without this an inbound message would sit in the table until someone
-- refreshed, which is not a chat app.
do $$
begin
  alter publication supabase_realtime add table public.relay_messages;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.relay_conversations;
exception when duplicate_object then null;
end $$;

-- ── find or create a conversation for a phone number ─────────────────────────
-- Used by both the send route and the inbound webhook, so the matching rule
-- lives in exactly one place.
--
-- The lead lookup matches on the LAST 10 DIGITS, not the raw string. The CRM's
-- own Meta ingest documents why: the same person has arrived as
-- "+919812345678", "919812345678" and "p:+91 98123 45678", and an exact match
-- treated those as three different people.
create or replace function public.relay_get_or_create_conversation(
  p_workspace_id uuid,
  p_phone_e164   text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_lead    uuid;
  v_last10  text := right(regexp_replace(p_phone_e164, '\D', '', 'g'), 10);
begin
  select id into v_id
    from public.relay_conversations
   where workspace_id = p_workspace_id and phone_e164 = p_phone_e164;

  if v_id is not null then
    -- A conversation that started before the person was in the CRM should
    -- attach itself as soon as the lead exists.
    update public.relay_conversations c
       set lead_id = l.id, updated_at = now()
      from public.leads l
     where c.id = v_id
       and c.lead_id is null
       and l.workspace_id = p_workspace_id
       and right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = v_last10;
    return v_id;
  end if;

  select id into v_lead
    from public.leads
   where workspace_id = p_workspace_id
     and length(v_last10) = 10
     and right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = v_last10
   order by updated_at desc
   limit 1;

  insert into public.relay_conversations (workspace_id, lead_id, phone_e164)
  values (p_workspace_id, v_lead, p_phone_e164)
  on conflict (workspace_id, phone_e164) do update set updated_at = now()
  returning id into v_id;

  return v_id;
end $$;

-- ── mark a conversation read ─────────────────────────────────────────────────
create or replace function public.relay_mark_read(p_conversation_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.relay_conversations
     set unread_count = 0, updated_at = now()
   where id = p_conversation_id
     and workspace_id in (select public.user_workspaces());
$$;

do $$ begin raise notice '100 DONE: relay_conversations + relay_messages ready.'; end $$;
