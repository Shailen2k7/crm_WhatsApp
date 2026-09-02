-- =============================================================================
-- 109 — NEW-LEAD AUTOMATION  (the workflow module, phase 1)
-- -----------------------------------------------------------------------------
-- One rule to start: when a new lead lands in the CRM, send the first message
-- asking for CV + LinkedIn. Two paths, chosen automatically:
--   * 24h window OPEN  (they messaged us)     -> a free-form quick reply
--   * 24h window CLOSED (ad-form lead, silent) -> an approved template
--
-- SAFETY RAILS, all enforced in the tick route:
--   * dedup      — a lead is messaged AT MOST ONCE per rule (unique index)
--   * daily cap  — a runaway rule cannot blast thousands
--   * quiet hours- nothing sent overnight (IST)
--   * delay      — wait N minutes after the lead is created, so a
--                  click-to-WhatsApp lead's own message lands first
--   * opt-out    — anyone who replied STOP is suppressed, everywhere
--
-- Idempotent. Safe to run twice.
-- =============================================================================

-- ── the rule config ─────────────────────────────────────────────────────────
create table if not exists public.relay_automations (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  key                text not null,                 -- 'new_lead_first'
  enabled            boolean not null default false,
  quick_reply_shortcut text,                        -- used when the window is OPEN
  template_name      text,                          -- used when the window is CLOSED
  template_language  text not null default 'en',
  delay_minutes      int not null default 2,        -- wait this long after lead created
  daily_cap          int not null default 50,       -- max sends per day
  quiet_start_hour   int not null default 21,       -- 21:00 IST … (no sends)
  quiet_end_hour     int not null default 9,        -- … until 09:00 IST
  -- Set every time the rule is switched ON. Only leads created AFTER this
  -- moment are eligible — the rule can never blast the historical database.
  activated_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (workspace_id, key)
);

-- ── dedup / audit: who got the first message, when, how ──────────────────────
create table if not exists public.relay_automation_sent (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  automation_key text not null,
  lead_id       uuid references public.leads(id) on delete set null,
  phone_e164    text not null,
  method        text,                               -- 'quick_reply' | 'template'
  detail        text,                               -- shortcut or template name
  ok            boolean not null default false,
  error         text,
  sent_at       timestamptz not null default now()
);
-- THE dedup guarantee: one automation send per lead per rule, forever.
create unique index if not exists uq_relay_auto_sent
  on public.relay_automation_sent (workspace_id, automation_key, lead_id)
  where lead_id is not null;
create unique index if not exists uq_relay_auto_sent_phone
  on public.relay_automation_sent (workspace_id, automation_key, phone_e164);

-- ── opt-out suppression (honours "Reply STOP") ───────────────────────────────
create table if not exists public.relay_suppressions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  phone_e164   text not null,
  reason       text,                                -- 'stop' | 'manual'
  created_at   timestamptz not null default now(),
  unique (workspace_id, phone_e164)
);

alter table public.relay_automations       enable row level security;
alter table public.relay_automation_sent   enable row level security;
alter table public.relay_suppressions       enable row level security;

do $$
declare t text;
begin
  foreach t in array array['relay_automations','relay_automation_sent','relay_suppressions'] loop
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

do $$ begin alter publication supabase_realtime add table public.relay_automations; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.relay_automation_sent; exception when duplicate_object then null; end $$;
alter table public.relay_automations     replica identity full;
alter table public.relay_automation_sent replica identity full;

-- ── seed the one rule, DISABLED, wired to the existing content ───────────────
insert into public.relay_automations (workspace_id, key, enabled, quick_reply_shortcut, template_name, template_language)
select w.id, 'new_lead_first', false, 'newlead', 't1', 'en'
  from (select id from public.workspaces order by created_at limit 1) w
on conflict (workspace_id, key) do nothing;

do $$ begin raise notice '109 DONE: automation tables ready (rule seeded, DISABLED).'; end $$;
