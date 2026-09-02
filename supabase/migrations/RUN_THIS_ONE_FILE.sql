-- =============================================================================
--  MIGRIZO WHATSAPP — RUN THIS ONE FILE
-- -----------------------------------------------------------------------------
--  Safe to run as-is, and safe to run twice. The parts you already ran
--  (realtime fix + automation tables) simply do nothing the second time.
--
--  RUN IT *AFTER* chat.migrizo.com is deployed with AUTOMATION_CRON_SECRET set
--  in Netlify — the last section starts calling that live URL every 2 minutes.
-- =============================================================================


-- ═══ PART 1 ═══ Realtime: make new chats appear without a refresh ════════════
-- Tables whose security rules key on a non-primary-key column need FULL replica
-- identity, otherwise Postgres silently drops the realtime events.

alter table public.relay_messages       replica identity full;
alter table public.relay_conversations  replica identity full;
alter table public.relay_quick_replies  replica identity full;
alter table public.relay_templates      replica identity full;


-- ═══ PART 2 ═══ Automation: the new-lead first message ═══════════════════════

-- ── the rule ────────────────────────────────────────────────────────────────
create table if not exists public.relay_automations (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  key                  text not null,
  enabled              boolean not null default false,
  quick_reply_shortcut text,
  template_name        text,
  template_language    text not null default 'en',
  delay_minutes        int not null default 2,
  daily_cap            int not null default 50,
  quiet_start_hour     int not null default 21,   -- unused; kept so old rows still fit
  quiet_end_hour       int not null default 9,    -- unused
  -- Stamped every time the switch goes ON. Only leads created after this moment
  -- are ever messaged, so switching on can never blast your existing database.
  activated_at         timestamptz,
  sent_today           int not null default 0,
  sent_today_date      date,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (workspace_id, key)
);

-- If the table already existed from an earlier run, make sure the column is there.
alter table public.relay_automations add column if not exists activated_at timestamptz;

-- ── who has already been messaged (the dedup guarantee) ─────────────────────
create table if not exists public.relay_automation_sent (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  automation_key text not null,
  lead_id        uuid references public.leads(id) on delete set null,
  phone_e164     text not null,
  method         text,
  detail         text,
  ok             boolean not null default false,
  error          text,
  sent_at        timestamptz not null default now()
);

-- One send per lead, and one per phone number — so duplicate CRM rows for the
-- same person can never produce a second WhatsApp message.
create unique index if not exists uq_relay_auto_sent
  on public.relay_automation_sent (workspace_id, automation_key, lead_id)
  where lead_id is not null;
create unique index if not exists uq_relay_auto_sent_phone
  on public.relay_automation_sent (workspace_id, automation_key, phone_e164);

-- ── people who replied STOP ─────────────────────────────────────────────────
create table if not exists public.relay_suppressions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  phone_e164   text not null,
  reason       text,
  created_at   timestamptz not null default now(),
  unique (workspace_id, phone_e164)
);

-- ── access rules: same workspace scoping as every other table ───────────────
alter table public.relay_automations     enable row level security;
alter table public.relay_automation_sent enable row level security;
alter table public.relay_suppressions    enable row level security;

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

do $$ begin alter publication supabase_realtime add table public.relay_automations;     exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.relay_automation_sent; exception when duplicate_object then null; end $$;
alter table public.relay_automations     replica identity full;
alter table public.relay_automation_sent replica identity full;

-- ── create the rule, switched OFF ───────────────────────────────────────────
insert into public.relay_automations (workspace_id, key, enabled, quick_reply_shortcut, template_name, template_language)
select w.id, 'new_lead_first', false, 'newlead', 't1', 'en'
  from (select id from public.workspaces order by created_at limit 1) w
on conflict (workspace_id, key) do nothing;


-- ═══ PART 3 ═══ Run the automation every 2 minutes ═══════════════════════════
-- This calls your live site, so it only works once the new code is deployed.

create extension if not exists pg_net;
do $$ begin perform cron.unschedule('migrizo-relay-automation-tick'); exception when others then null; end $$;

select cron.schedule('migrizo-relay-automation-tick', '*/2 * * * *', $CRON$
  select net.http_post(
    url     := 'https://chat.migrizo.com/api/automation/tick',
    headers := '{"Content-Type":"application/json","x-cron-secret":"1c42a339806b344e2a5298aea20fa3343b885a25e079d017"}'::jsonb,
    body    := '{}'::jsonb
  );
$CRON$);


-- ═══ CHECK ═══ everything below should come back with a row ══════════════════
select 'automation rule'  as thing, count(*)::text as result from public.relay_automations where key = 'new_lead_first'
union all
select 'every-2-min job', count(*)::text from cron.job where jobname = 'migrizo-relay-automation-tick';
