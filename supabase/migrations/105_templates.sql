-- =============================================================================
-- 105 — APPROVED TEMPLATE REGISTRY
-- -----------------------------------------------------------------------------
-- Interakt exposes no working public endpoint to LIST templates (their
-- /track/templates/ returns 500 on every request shape we tried), so the
-- approved templates are registered here once and used forever. Sending them
-- uses Interakt's documented template-send API, which works.
--
-- body holds the approved text with {{1}}, {{2}} placeholders exactly as
-- approved in Meta — the composer turns those into input fields.
--
-- Idempotent. Safe to run twice.
-- =============================================================================

create table if not exists public.relay_templates (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  name           text not null,               -- the CODE name, exactly as in Interakt
  language       text not null default 'en',
  body           text not null default '',    -- approved text with {{n}} placeholders
  category       text,                        -- MARKETING / UTILITY / AUTHENTICATION
  variable_count int not null default 0,
  sort_order     int not null default 0,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, name, language)
);

alter table public.relay_templates enable row level security;

drop policy if exists "relay tpl select" on public.relay_templates;
create policy "relay tpl select" on public.relay_templates
  for select using (workspace_id in (select public.user_workspaces()));
drop policy if exists "relay tpl insert" on public.relay_templates;
create policy "relay tpl insert" on public.relay_templates
  for insert with check (workspace_id in (select public.user_workspaces()));
drop policy if exists "relay tpl update" on public.relay_templates;
create policy "relay tpl update" on public.relay_templates
  for update using (workspace_id in (select public.user_workspaces()));
drop policy if exists "relay tpl delete" on public.relay_templates;
create policy "relay tpl delete" on public.relay_templates
  for delete using (workspace_id in (select public.user_workspaces()));

do $$
begin
  alter publication supabase_realtime add table public.relay_templates;
exception when duplicate_object then null;
end $$;

do $$ begin raise notice '105 DONE: relay_templates ready.'; end $$;
