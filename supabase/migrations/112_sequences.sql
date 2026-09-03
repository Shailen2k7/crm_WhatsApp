-- =============================================================================
-- 112 — WHATSAPP SEQUENCES  (the C1–C8 follow-up machine)
-- -----------------------------------------------------------------------------
-- Mirrors the CRM's email sequences, adapted for WhatsApp templates:
--
--   relay_sequences        the machine itself: audience, status, sending hours
--   relay_sequence_steps   C1..C8 — which template, how many days after the last
--   relay_sequence_ramp    daily intake: 80/day for 10 days -> 150/day for 20 -> …
--   relay_lead_sequences   one row per enrolled lead: where they are, how they left
--   relay_sequence_sends   audit of every message the machine sent
--
-- Oldest leads enrol first, so the whole database is eventually covered.
-- A reply stops that lead's sequence instantly (wired in the webhook).
--
-- Safe to run twice.
-- =============================================================================

create table if not exists public.relay_sequences (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  name             text not null default 'Cold follow-up',
  audience         text not null default 'cold' check (audience in ('cold','hot','both')),
  status           text not null default 'draft' check (status in ('draft','running','paused','stopped')),
  -- Sending hours (IST). Marketing to people who did not just message you
  -- belongs in the daytime; the switch below can disable the restriction.
  hours_enabled    boolean not null default true,
  send_start_hour  int not null default 9,
  send_end_hour    int not null default 21,
  started_at       timestamptz,              -- stamped on first Start; ramp day 1
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.relay_sequence_steps (
  id                uuid primary key default gen_random_uuid(),
  sequence_id       uuid not null references public.relay_sequences(id) on delete cascade,
  workspace_id      uuid not null,
  step_no           int  not null,            -- 1..8
  template_name     text not null,            -- must exist in relay_templates
  template_language text not null default 'en',
  gap_days          int  not null default 3,  -- days AFTER THE PREVIOUS step (step 1: after enrolment, 0 = same day)
  unique (sequence_id, step_no)
);

create table if not exists public.relay_sequence_ramp (
  id            uuid primary key default gen_random_uuid(),
  sequence_id   uuid not null references public.relay_sequences(id) on delete cascade,
  workspace_id  uuid not null,
  stage_no      int  not null,                -- 1, 2, 3 …
  per_day       int  not null,                -- new leads enrolled per day in this stage
  duration_days int,                          -- null on the last stage = thereafter, forever
  unique (sequence_id, stage_no)
);

create table if not exists public.relay_lead_sequences (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  sequence_id   uuid not null references public.relay_sequences(id) on delete cascade,
  lead_id       uuid references public.leads(id) on delete set null,
  phone_e164    text not null,
  status        text not null default 'active'
                check (status in ('active','completed','replied','skipped','stopped')),
  current_step  int  not null default 0,      -- last step SENT (0 = nothing yet)
  enrolled_at   timestamptz not null default now(),
  last_sent_at  timestamptz,
  next_send_at  timestamptz not null default now(),
  exit_reason   text,                         -- replied | done | stop_optout | bad_phone | send_failed | manual
  exited_at     timestamptz,
  updated_at    timestamptz not null default now()
);
-- One enrolment per lead per sequence — and one per PHONE, so duplicate CRM
-- rows for the same person can never receive the drip twice.
create unique index if not exists uq_rls_lead  on public.relay_lead_sequences (sequence_id, lead_id) where lead_id is not null;
create unique index if not exists uq_rls_phone on public.relay_lead_sequences (sequence_id, phone_e164);
create index if not exists ix_rls_due on public.relay_lead_sequences (sequence_id, status, next_send_at);

create table if not exists public.relay_sequence_sends (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  sequence_id   uuid not null references public.relay_sequences(id) on delete cascade,
  lead_id       uuid,
  phone_e164    text not null,
  step_no       int  not null,
  template_name text not null,
  message_id    uuid,                         -- the relay_messages row (shows in the chat)
  ok            boolean not null default false,
  error         text,
  sent_at       timestamptz not null default now()
);
create index if not exists ix_rss_day on public.relay_sequence_sends (workspace_id, sequence_id, sent_at);

-- ── access: same workspace scoping as everything else ────────────────────────
do $$
declare t text;
begin
  foreach t in array array['relay_sequences','relay_sequence_steps','relay_sequence_ramp',
                           'relay_lead_sequences','relay_sequence_sends'] loop
    execute format('alter table public.%I enable row level security', t);
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

do $$ begin alter publication supabase_realtime add table public.relay_sequences;      exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.relay_lead_sequences; exception when duplicate_object then null; end $$;
alter table public.relay_sequences      replica identity full;
alter table public.relay_lead_sequences replica identity full;

-- ── seed ONE draft sequence: C1..C8, 3-day gaps, the ramp from the brief ─────
do $$
declare ws uuid; seq uuid;
begin
  select id into ws from public.workspaces order by created_at limit 1;
  if ws is null then return; end if;
  if exists (select 1 from public.relay_sequences where workspace_id = ws) then return; end if;

  insert into public.relay_sequences (workspace_id, name, audience, status)
  values (ws, 'Cold follow-up C1–C8', 'cold', 'draft')
  returning id into seq;

  insert into public.relay_sequence_steps (sequence_id, workspace_id, step_no, template_name, gap_days)
  select seq, ws, n, 'c' || n, case when n = 1 then 0 else 3 end
    from generate_series(1, 8) n;

  insert into public.relay_sequence_ramp (sequence_id, workspace_id, stage_no, per_day, duration_days) values
    (seq, ws, 1,  80, 10),
    (seq, ws, 2, 150, 20),
    (seq, ws, 3, 200, null);
end $$;

do $$ begin raise notice '112 DONE: sequence tables ready (one draft sequence seeded).'; end $$;
