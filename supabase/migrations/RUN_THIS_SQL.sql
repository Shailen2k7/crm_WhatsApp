-- =============================================================================
--  RUN THIS ONE FILE  —  the two migrations still outstanding (113 + 114)
-- -----------------------------------------------------------------------------
--  Everything before this (108–112) is already applied to your database;
--  this is the only SQL left. Safe to run twice.
--
--  113 — the delivery report on the Follow-up sequence page (Sent / Delivered /
--        Read / Bounced). Without it that card just shows zeros.
--  114 — lets the new-lead wait be set in SECONDS (10s / 30s / 1 min).
--        Without it the dropdown will not save your choice.
-- =============================================================================


-- ═══ 113 ═══ Delivery report ════════════════════════════════════════════════
-- Each sequence send points at its chat message, and that message carries the
-- live WhatsApp receipt (sent -> delivered -> read, or failed). This rolls the
-- receipts up so the page can show them at a glance.

create or replace function public.relay_sequence_delivery(p_sequence_id uuid)
returns table (sent bigint, delivered bigint, read bigint, failed bigint)
language sql stable security definer set search_path = public as $fn$
  select
    count(*) filter (where m.status in ('sent','delivered','read'))  as sent,
    count(*) filter (where m.status in ('delivered','read'))         as delivered,
    count(*) filter (where m.status = 'read')                        as read,
    count(*) filter (where m.status = 'failed' or s.ok = false)      as failed
  from public.relay_sequence_sends s
  left join public.relay_messages m on m.id = s.message_id
  where s.sequence_id = p_sequence_id;
$fn$;

grant execute on function public.relay_sequence_delivery(uuid) to authenticated, service_role;


-- ═══ Why did they bounce? ═══════════════════════════════════════════════════
-- "Bounced: 7" is not actionable. The reason is: Meta's 131049 means the
-- marketing frequency cap, which calls for slowing down or switching those
-- templates to UTILITY — a completely different response from a dead number.

create or replace function public.relay_sequence_failures(p_sequence_id uuid)
returns table (code text, detail text, hits bigint)
language sql stable security definer set search_path = public as $fn$
  select
    coalesce(m.error_code, 'unknown')                as code,
    coalesce(left(m.error_detail, 120), 'No detail') as detail,
    count(*)                                         as hits
  from public.relay_sequence_sends s
  join public.relay_messages m on m.id = s.message_id
  where s.sequence_id = p_sequence_id
    and m.status = 'failed'
  group by 1, 2
  order by hits desc
  limit 5;
$fn$;

grant execute on function public.relay_sequence_failures(uuid) to authenticated, service_role;


-- ═══ 114 ═══ New-lead wait, in seconds ══════════════════════════════════════
-- The wait was stored in whole minutes, so one minute was the shortest pause
-- possible. delay_minutes is left in place and simply unused, so a deploy
-- still running the previous build during a rollout keeps working.

alter table public.relay_automations
  add column if not exists delay_seconds int not null default 60;

update public.relay_automations
   set delay_seconds = greatest(10, least(3600, coalesce(delay_minutes, 1) * 60))
 where delay_seconds = 60
   and coalesce(delay_minutes, 1) <> 1;


-- ═══ 115 ═══ ONE-TIME CAMPAIGNS ═════════════════════════════════════════════
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


-- ═══ CHECK ═══ both rows should come back ═══════════════════════════════════
select 'delivery report' as thing,
       count(*)::text as result
  from pg_proc where proname = 'relay_sequence_delivery'
union all
select 'delay_seconds column',
       count(*)::text
  from information_schema.columns
 where table_name = 'relay_automations' and column_name = 'delay_seconds'
union all
select 'campaign tables',
       count(*)::text
  from information_schema.tables
 where table_name in ('relay_campaigns','relay_campaign_recipients');
