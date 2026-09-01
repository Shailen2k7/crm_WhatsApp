-- =============================================================================
-- 102 — RELAY V2: files, internal notes, quick replies, spotlight, cleanup
-- -----------------------------------------------------------------------------
-- Run AFTER 100 and 101. Idempotent — safe to run twice.
-- Touches only relay_* objects and one new private storage bucket.
-- =============================================================================

-- ── 1. messages: internal notes + stored media ───────────────────────────────
alter table public.relay_messages
  add column if not exists is_internal boolean not null default false,
  -- Storage object path inside the relay-media bucket. The PATH is stored,
  -- never a public URL — the file is served through an authenticated route.
  add column if not exists media_path text,
  add column if not exists media_size bigint;

create index if not exists idx_relay_msg_media
  on public.relay_messages (workspace_id, created_at desc)
  where media_path is not null;

-- ── 2. conversations: spotlight + tags ───────────────────────────────────────
alter table public.relay_conversations
  add column if not exists spotlight boolean not null default false,
  add column if not exists tags text[] not null default '{}';

drop policy if exists "relay conv delete" on public.relay_conversations;
create policy "relay conv delete" on public.relay_conversations
  for delete using (
    workspace_id in (select public.user_workspaces())
    and public.is_workspace_admin(workspace_id)
  );

drop policy if exists "relay msg update" on public.relay_messages;
create policy "relay msg update" on public.relay_messages
  for update using (workspace_id in (select public.user_workspaces()));

drop policy if exists "relay msg delete" on public.relay_messages;
create policy "relay msg delete" on public.relay_messages
  for delete using (
    workspace_id in (select public.user_workspaces())
    and public.is_workspace_admin(workspace_id)
  );

-- ── 3. quick replies ─────────────────────────────────────────────────────────
-- The answers the team types twenty times a day, with optional attached files
-- (fee sheets, document checklists) that go out with the message.
create table if not exists public.relay_quick_replies (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  shortcut     text not null,             -- "fees" -> typed as /fees
  title        text not null,
  body         text not null default '',
  -- [{path, name, mime, size}] — objects in the relay-media bucket.
  attachments  jsonb not null default '[]',
  sort_order   int not null default 0,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, shortcut)
);

alter table public.relay_quick_replies enable row level security;

drop policy if exists "relay qr select" on public.relay_quick_replies;
create policy "relay qr select" on public.relay_quick_replies
  for select using (workspace_id in (select public.user_workspaces()));
drop policy if exists "relay qr insert" on public.relay_quick_replies;
create policy "relay qr insert" on public.relay_quick_replies
  for insert with check (workspace_id in (select public.user_workspaces()));
drop policy if exists "relay qr update" on public.relay_quick_replies;
create policy "relay qr update" on public.relay_quick_replies
  for update using (workspace_id in (select public.user_workspaces()));
drop policy if exists "relay qr delete" on public.relay_quick_replies;
create policy "relay qr delete" on public.relay_quick_replies
  for delete using (workspace_id in (select public.user_workspaces()));

-- ── 4. private storage bucket ────────────────────────────────────────────────
-- These files are CVs, passports and bank statements. Private bucket, no
-- storage policies needed: every read and write goes through our API routes
-- using the service role, after a session and workspace check.
insert into storage.buckets (id, name, public)
values ('relay-media', 'relay-media', false)
on conflict (id) do nothing;

-- ── 5. realtime for quick replies (list stays live across the team) ──────────
do $$
begin
  alter publication supabase_realtime add table public.relay_quick_replies;
exception when duplicate_object then null;
end $$;

do $$ begin raise notice '102 DONE: v2 columns, quick replies, relay-media bucket.'; end $$;
