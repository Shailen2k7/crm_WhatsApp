-- =============================================================================
-- 115 — ONE-TIME CAMPAIGNS  (the manual blast, separate from the C1–C8 drip)
-- -----------------------------------------------------------------------------
-- Pick an audience (cold / hot / both, or a hand-picked set), pick a template,
-- send now or schedule it, and watch sent / failed / skipped as it goes.
--
-- Completely independent of relay_sequences: a lead can be mid-sequence and
-- still receive a campaign, and a campaign never alters their sequence state.
--
-- Safe to run twice.
-- =============================================================================

create table if not exists public.relay_campaigns (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  name              text not null default 'Campaign',
  template_name     text not null,
  template_language text not null default 'en',
  audience          text not null default 'cold'
                    check (audience in ('cold','hot','both','selected')),
  status            text not null default 'draft'
                    check (status in ('draft','scheduled','sending','paused','done','cancelled')),
  scheduled_at      timestamptz,          -- null = send as soon as it starts
  total             int not null default 0,
  sent              int not null default 0,
  failed            int not null default 0,
  skipped           int not null default 0,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz
);

create table if not exists public.relay_campaign_recipients (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.relay_campaigns(id) on delete cascade,
  workspace_id uuid not null,
  lead_id      uuid references public.leads(id) on delete set null,
  phone_e164   text not null,
  full_name    text,
  status       text not null default 'queued'
               check (status in ('queued','sent','failed','skipped')),
  error        text,
  message_id   uuid,                       -- the chat message, so it shows in the thread
  sent_at      timestamptz,
  unique (campaign_id, phone_e164)          -- nobody gets the same campaign twice
);
create index if not exists ix_rcr_queue
  on public.relay_campaign_recipients (campaign_id, status);

alter table public.relay_campaigns            enable row level security;
alter table public.relay_campaign_recipients  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['relay_campaigns','relay_campaign_recipients'] loop
    execute format('drop policy if exists "%s sel" on public.%I', t, t);
    execute format('create policy "%s sel" on public.%I for select using (workspace_id in (select public.user_workspaces()))', t, t);
    execute format('drop policy if exists "%s ins" on public.%I', t, t);
    execute format('create policy "%s ins" on public.%I for insert with check (workspace_id in (select public.user_workspaces()))', t, t);
    execute format('drop policy if exists "%s upd" on public.%I', t, t);
    execute format('create policy "%s upd" on public.%I for update using (workspace_id in (select public.user_workspaces()))', t, t);
    execute format('drop policy if exists "%s del" on public.%I', t, t);
    execute format('create policy "%s del" on public.%I for delete using (workspace_id in (select public.user_workspaces()))', t, t);
  end loop;
end $$;

do $$ begin alter publication supabase_realtime add table public.relay_campaigns; exception when duplicate_object then null; end $$;
alter table public.relay_campaigns replica identity full;

do $$ begin raise notice '115 DONE: campaigns ready.'; end $$;
