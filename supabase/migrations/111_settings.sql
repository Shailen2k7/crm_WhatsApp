-- =============================================================================
-- 111 — SETTINGS  (needed for the "Fetch templates" button)
-- -----------------------------------------------------------------------------
-- A tiny key/value store per workspace. Right now it holds the Interakt
-- connection used to import approved templates, so the connection can be
-- refreshed from the Templates page without a redeploy.
--
-- Safe to run twice.
-- =============================================================================

create table if not exists public.relay_settings (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key          text not null,
  value        text,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, key)
);

alter table public.relay_settings enable row level security;

drop policy if exists "relay_settings sel" on public.relay_settings;
create policy "relay_settings sel" on public.relay_settings
  for select using (workspace_id in (select public.user_workspaces()));

drop policy if exists "relay_settings ins" on public.relay_settings;
create policy "relay_settings ins" on public.relay_settings
  for insert with check (workspace_id in (select public.user_workspaces()));

drop policy if exists "relay_settings upd" on public.relay_settings;
create policy "relay_settings upd" on public.relay_settings
  for update using (workspace_id in (select public.user_workspaces()));

drop policy if exists "relay_settings del" on public.relay_settings;
create policy "relay_settings del" on public.relay_settings
  for delete using (workspace_id in (select public.user_workspaces()));

do $$ begin raise notice '111 DONE: relay_settings ready.'; end $$;
