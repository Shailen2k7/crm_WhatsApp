-- Meeting Scheduler OS — Supabase schema
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
-- Every table is scoped to the signed-in user via row-level security, so each
-- team member only ever sees their own data.

-- ============ settings (one row per user) ============
create table if not exists public.settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text not null default '',
  timezone text not null default 'UTC',
  meet_link text not null default '',
  default_duration_min integer not null default 30,
  default_reminder_min integer not null default 15,
  work_start_min integer not null default 540,
  work_end_min integer not null default 1080,
  theme text not null default 'system',
  updated_at timestamptz not null default now()
);

-- ============ meetings ============
create table if not exists public.meetings (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  person_name text not null,
  person_email text,
  date date not null,
  start_min integer not null check (start_min between 0 and 1439),
  duration_min integer not null check (duration_min > 0),
  type text not null default 'client',
  notes text,
  meet_link text,
  reminder_min integer,
  reminders_fired text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists meetings_user_date_idx on public.meetings (user_id, date);

-- ============ blocked_times ============
create table if not exists public.blocked_times (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date date not null,
  start_min integer not null check (start_min between 0 and 1439),
  end_min integer not null check (end_min between 1 and 1440),
  label text
);

create index if not exists blocked_user_date_idx on public.blocked_times (user_id, date);

-- ============ availability_windows (weekly recurring) ============
create table if not exists public.availability_windows (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day integer not null check (day between 0 and 6),
  start_min integer not null check (start_min between 0 and 1439),
  end_min integer not null check (end_min between 1 and 1440)
);

create index if not exists availability_user_idx on public.availability_windows (user_id);

-- ============ row-level security ============
alter table public.settings enable row level security;
alter table public.meetings enable row level security;
alter table public.blocked_times enable row level security;
alter table public.availability_windows enable row level security;

drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own meetings" on public.meetings;
create policy "own meetings" on public.meetings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own blocked_times" on public.blocked_times;
create policy "own blocked_times" on public.blocked_times
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own availability_windows" on public.availability_windows;
create policy "own availability_windows" on public.availability_windows
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================
-- Public booking pages (/book/<slug>)
-- Visitors are anonymous: they never read the tables directly.
-- These SECURITY DEFINER functions expose only host name,
-- availability and anonymous busy ranges, and validate every
-- booking server-side (incl. a lock against double booking).
-- Re-running this whole file is safe (idempotent).
-- ============================================================

-- AI meeting notes (Phase 3)
alter table public.meetings add column if not exists transcript text;
alter table public.meetings add column if not exists ai_notes jsonb;

-- Tasks & standalone reminders (Phase 5)
create table if not exists public.tasks (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  notes text,
  priority text not null default 'medium' check (priority in ('high','medium','low')),
  done boolean not null default false,
  due_date date,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.tasks add column if not exists due_push_date date;
create index if not exists tasks_user_idx on public.tasks (user_id, done, due_date);
alter table public.tasks enable row level security;
drop policy if exists "own tasks" on public.tasks;
create policy "own tasks" on public.tasks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.reminders (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  notes text,
  date date not null,
  at_min integer not null check (at_min between 0 and 1439),
  fired boolean not null default false,
  push_fired boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists reminders_user_date_idx on public.reminders (user_id, date);

-- Repeating reminders (additive — existing reminders become 'none' = one-time)
alter table public.reminders add column if not exists repeat text not null default 'none';
alter table public.reminders add column if not exists repeat_days integer[];
alter table public.reminders add column if not exists interval_min integer;
alter table public.reminders add column if not exists until_min integer;
alter table public.reminders add column if not exists last_fired_at bigint;
alter table public.reminders add column if not exists last_push_at bigint;
alter table public.reminders enable row level security;
drop policy if exists "own reminders" on public.reminders;
create policy "own reminders" on public.reminders
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Push notifications (Phase 4)
alter table public.meetings add column if not exists push_fired boolean not null default false;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists "own push_subscriptions" on public.push_subscriptions;
create policy "own push_subscriptions" on public.push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.settings add column if not exists booking_slug text unique;
alter table public.settings add column if not exists booking_enabled boolean not null default true;
alter table public.settings add column if not exists booking_start_min integer not null default 540;
alter table public.settings add column if not exists booking_end_min integer not null default 1200;
alter table public.settings add column if not exists booking_days integer[] not null default '{1,2,3,4,5}';

create index if not exists settings_booking_slug_idx on public.settings (booking_slug);

-- Host info + availability for a booking page
create or replace function public.booking_host(p_slug text)
returns json
language plpgsql security definer set search_path = public as $$
declare
  v record;
begin
  select user_id, name, timezone, default_duration_min, booking_enabled,
         booking_start_min, booking_end_min, booking_days
    into v from settings where booking_slug = p_slug;
  if not found or not v.booking_enabled then
    return json_build_object('ok', false);
  end if;
  return json_build_object(
    'ok', true,
    'name', v.name,
    'timezone', v.timezone,
    'defaultDurationMin', v.default_duration_min,
    'bookingStartMin', v.booking_start_min,
    'bookingEndMin', v.booking_end_min,
    'bookingDays', to_json(v.booking_days));
end $$;

-- Anonymous busy ranges (meetings + blocked time, no titles or details)
create or replace function public.booking_busy(p_slug text, p_from date, p_to date)
returns json
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
  v_out json;
begin
  select user_id into v_user from settings
    where booking_slug = p_slug and booking_enabled;
  if not found or p_to < p_from or p_to - p_from > 60 then
    return '[]'::json;
  end if;
  select coalesce(json_agg(json_build_object(
      'date', t.date, 'start_min', t.start_min, 'end_min', t.end_min)), '[]'::json)
    into v_out
    from (
      select date, start_min, start_min + duration_min as end_min
        from meetings where user_id = v_user and date between p_from and p_to
      union all
      select date, start_min, end_min
        from blocked_times where user_id = v_user and date between p_from and p_to
    ) t;
  return v_out;
end $$;

-- Create a booking (validated, race-safe)
create or replace function public.booking_create(
  p_slug text, p_date date, p_start_min integer, p_duration_min integer,
  p_name text, p_email text, p_topic text default '', p_notes text default '')
returns json
language plpgsql security definer set search_path = public as $$
declare
  v record;
  v_end integer := p_start_min + p_duration_min;
  v_title text;
  v_notes text;
  v_id uuid := gen_random_uuid();
begin
  select user_id, name, timezone, meet_link, default_reminder_min,
         booking_start_min, booking_end_min, booking_days
    into v from settings where booking_slug = p_slug and booking_enabled;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;

  -- input validation
  if p_duration_min not in (15, 30, 45, 60, 90)
     or p_start_min < 0 or p_start_min > 1439 or p_start_min % 5 <> 0
     or length(trim(p_name)) = 0 or length(p_name) > 100
     or p_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(p_email) > 200
     or length(coalesce(p_topic, '')) > 140 or length(coalesce(p_notes, '')) > 1000 then
    return json_build_object('ok', false, 'error', 'invalid');
  end if;

  -- not in the past (host's timezone)
  if (p_date::timestamp + make_interval(mins => p_start_min))
     < (now() at time zone v.timezone) then
    return json_build_object('ok', false, 'error', 'past');
  end if;

  -- must sit inside the host's public booking window
  if not (extract(dow from p_date)::int = any(v.booking_days))
     or p_start_min < v.booking_start_min or v_end > v.booking_end_min then
    return json_build_object('ok', false, 'error', 'outside_availability');
  end if;

  -- serialize bookings per host to prevent double booking races
  perform pg_advisory_xact_lock(hashtext(v.user_id::text));

  if exists (
       select 1 from meetings
        where user_id = v.user_id and date = p_date
          and p_start_min < start_min + duration_min and v_end > start_min)
     or exists (
       select 1 from blocked_times
        where user_id = v.user_id and date = p_date
          and p_start_min < end_min and v_end > start_min) then
    return json_build_object('ok', false, 'error', 'slot_taken');
  end if;

  v_title := case when length(trim(coalesce(p_topic, ''))) > 0
                  then trim(p_name) || ' — ' || trim(p_topic)
                  else 'Meeting with ' || trim(p_name) end;
  v_notes := case when length(trim(coalesce(p_notes, ''))) > 0
                  then 'Booked via link.' || E'\n' || trim(p_notes)
                  else 'Booked via link.' end;

  insert into meetings
    (id, user_id, title, person_name, person_email, date, start_min,
     duration_min, type, notes, meet_link, reminder_min, reminders_fired)
  values
    (v_id, v.user_id, v_title, trim(p_name), trim(p_email), p_date,
     p_start_min, p_duration_min, 'client', v_notes,
     nullif(v.meet_link, ''), v.default_reminder_min, '{}');

  return json_build_object('ok', true, 'id', v_id, 'meetLink', coalesce(v.meet_link, ''), 'hostName', v.name);
end $$;

grant execute on function public.booking_host(text) to anon, authenticated;
grant execute on function public.booking_busy(text, date, date) to anon, authenticated;
grant execute on function public.booking_create(text, date, integer, integer, text, text, text, text) to anon, authenticated;

-- ============ journal (Phase 6) — photos + written/dictated notes ============
create table if not exists public.journal_entries (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text text not null default '',
  photos jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index if not exists journal_user_idx on public.journal_entries (user_id, created_at desc);
alter table public.journal_entries enable row level security;
drop policy if exists "own journal_entries" on public.journal_entries;
create policy "own journal_entries" on public.journal_entries
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================
-- Migrizo CRM → Scheduler OS meeting sync (Phase 7)
-- Runs entirely inside this Supabase project, every minute.
--  • The CRM is only ever READ (GET requests through crm_get).
--  • Only rows marked source='crm' are ever added, changed or removed here —
--    your own meetings are never touched.
--  • A meeting is removed only after the CRM confirms it is no longer upcoming,
--    and only if it is still in the future. Past meetings stay as history.
--  • Each run is all-or-nothing: if anything fails, nothing is half-applied.
-- Safe to re-run. The connection itself (CRM URL + key) is set separately in
-- CRM_CONNECT.sql, which is never stored in GitHub.
-- ============================================================
-- refuse to run anywhere except the Scheduler OS database (e.g. never inside the CRM)
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'meetings' and column_name = 'start_min')
     or not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'reminders' and column_name = 'at_min')
     or not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'push_subscriptions') then
    raise exception 'Wrong project: this is not the Scheduler OS database. Open your SCHEDULER OS Supabase project (not Migrizo_CRM) and run it there.';
  end if;
end $$;

create extension if not exists http with schema extensions;
create extension if not exists pg_cron;

-- meetings mirrored from the CRM are marked, so the sync only ever changes its own rows
alter table public.meetings add column if not exists source text;
alter table public.meetings add column if not exists external_id text;
create unique index if not exists meetings_user_source_external_idx
  on public.meetings (user_id, source, external_id);

-- private settings: not reachable from the app or the public API
create schema if not exists private;
create table if not exists private.crm_sync_config (
  id integer primary key default 1 check (id = 1),
  crm_url text not null,
  crm_key text not null,
  user_email text not null,
  meet_link text not null default 'https://meet.google.com/trb-ufoe-wyb',
  enabled boolean not null default true,
  last_run_at timestamptz,
  last_result jsonb
);
alter table private.crm_sync_config enable row level security;
revoke all on schema private from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;

-- the ONLY way this database talks to the CRM: a read-only GET
create or replace function private.crm_get(p_path text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg private.crm_sync_config;
  res extensions.http_response;
begin
  select * into cfg from private.crm_sync_config where id = 1;
  select * into res from extensions.http((
    'GET',
    rtrim(cfg.crm_url, '/') || '/rest/v1/' || p_path,
    -- new-style keys (sb_secret_…) go in "apikey" only; classic JWT keys also as Bearer
    case when cfg.crm_key like 'eyJ%'
      then array[
        extensions.http_header('apikey', cfg.crm_key),
        extensions.http_header('Authorization', 'Bearer ' || cfg.crm_key)
      ]
      else array[extensions.http_header('apikey', cfg.crm_key)]
    end,
    null,
    null
  )::extensions.http_request);
  if res.status <> 200 then
    raise exception 'CRM % returned %: %', split_part(p_path, '?', 1), res.status, left(res.content, 200);
  end if;
  return res.content::jsonb;
end $$;

create or replace function private.crm_sync()
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg private.crm_sync_config;
  uid uuid;
  tz text;
  rem integer;
  crm jsonb;
  hosts jsonb := '{}'::jsonb;
  m jsonb;
  c jsonb;
  confirm jsonb;
  r record;
  ids text[] := '{}';
  cand text[];
  first_import boolean;
  v_start_ts timestamp;
  v_date date;
  v_start integer;
  v_dur integer;
  v_name text;
  v_title text;
  v_email text;
  v_notes text;
  v_host text;
  was_moved boolean;
  added integer := 0;
  moved integer := 0;
  updated integer := 0;
  removed integer := 0;
  result jsonb;
begin
  select * into cfg from private.crm_sync_config where id = 1;
  if not found or not cfg.enabled then
    return jsonb_build_object('ok', false, 'reason', 'not_configured');
  end if;

  begin
    select id into uid from auth.users where lower(email) = lower(trim(cfg.user_email)) limit 1;
    if uid is null then
      result := jsonb_build_object('ok', false, 'reason', 'sync_user_not_found', 'at', now());
      update private.crm_sync_config set last_run_at = now(), last_result = result where id = 1;
      return result;
    end if;

    select coalesce(s.timezone, 'UTC'), coalesce(s.default_reminder_min, 15) into tz, rem
      from public.settings s where s.user_id = uid;
    tz := coalesce(tz, 'UTC');
    rem := coalesce(rem, 15);

    -- 1. CRM meetings that are still scheduled and not yet over
    crm := private.crm_get(
      'meetings?select=id,member_id,client_name,client_email,client_phone,starts_at,ends_at,status,notes'
      || '&status=eq.upcoming&ends_at=gte.' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      || '&order=starts_at.asc&limit=1000'
    );
    if jsonb_typeof(crm) <> 'array' then
      raise exception 'unexpected CRM response';
    end if;

    -- host names are a nice-to-have
    begin
      select coalesce(jsonb_object_agg(x ->> 'id', x ->> 'display_name'), '{}'::jsonb) into hosts
        from jsonb_array_elements(private.crm_get('scheduler_members?select=id,display_name')) x;
    exception when others then
      hosts := '{}'::jsonb;
    end;

    first_import := not exists (select 1 from public.meetings where user_id = uid and source = 'crm');

    -- 2. add new ones / refresh changed ones (only rows marked source='crm')
    for m in select * from jsonb_array_elements(crm) loop
      continue when m ->> 'id' is null or m ->> 'starts_at' is null;
      ids := ids || (m ->> 'id');
      v_start_ts := (m ->> 'starts_at')::timestamptz at time zone tz;
      v_date := v_start_ts::date;
      v_start := least(greatest(extract(hour from v_start_ts)::int * 60 + extract(minute from v_start_ts)::int, 0), 1439);
      v_dur := case
        when m ->> 'ends_at' is null then 30
        else greatest(5, least(1440, round(extract(epoch from ((m ->> 'ends_at')::timestamptz - (m ->> 'starts_at')::timestamptz)) / 60)::int))
      end;
      v_name := left(coalesce(nullif(trim(m ->> 'client_name'), ''), 'Client'), 100);
      v_title := left('Meeting with ' || v_name, 140);
      v_email := nullif(trim(m ->> 'client_email'), '');
      v_host := hosts ->> (m ->> 'member_id');
      v_notes := concat_ws(E'\n',
        'Booked in Migrizo CRM',
        case when v_host is not null then 'Host: ' || v_host end,
        case when nullif(trim(m ->> 'client_phone'), '') is not null then 'Phone: ' || trim(m ->> 'client_phone') end,
        case when nullif(trim(m ->> 'notes'), '') is not null then E'\n' || trim(m ->> 'notes') end
      );

      select id, date, start_min into r from public.meetings
        where user_id = uid and source = 'crm' and external_id = m ->> 'id';
      if not found then
        insert into public.meetings
          (id, user_id, title, person_name, person_email, date, start_min, duration_min, type, notes,
           meet_link, reminder_min, reminders_fired, push_fired, source, external_id, created_at)
        values
          (gen_random_uuid(), uid, v_title, v_name, v_email, v_date, v_start, v_dur, 'client', v_notes,
           cfg.meet_link, rem, '{}', false, 'crm', m ->> 'id', now())
        on conflict (user_id, source, external_id) do nothing;
        if found then added := added + 1; end if;
      else
        was_moved := r.date <> v_date or r.start_min <> v_start;
        update public.meetings set
          title = v_title,
          person_name = v_name,
          person_email = v_email,
          date = v_date,
          start_min = v_start,
          duration_min = v_dur,
          notes = v_notes,
          -- a new time re-arms the reminder for the new slot
          reminders_fired = case when was_moved then '{}' else reminders_fired end,
          push_fired = case when was_moved then false else push_fired end
        where id = r.id and user_id = uid and source = 'crm'
          and (title, person_name, person_email, date, start_min, duration_min, notes)
              is distinct from (v_title, v_name, v_email, v_date, v_start, v_dur, v_notes);
        if found then
          if was_moved then moved := moved + 1; else updated := updated + 1; end if;
        end if;
      end if;
    end loop;

    -- 3. no longer in the CRM's upcoming list → ask the CRM before removing anything
    select array_agg(external_id) into cand from public.meetings
      where user_id = uid and source = 'crm'
        and not (external_id = any(ids))
        and ((date + make_interval(mins => start_min + duration_min)) at time zone tz) > now();
    if cand is not null and array_length(cand, 1) > 0 then
      confirm := private.crm_get('meetings?select=id,status,ends_at&id=in.(' || array_to_string(cand, ',') || ')');
      for r in select x.ext from unnest(cand) as x(ext) loop
        select e into c from jsonb_array_elements(confirm) e where e ->> 'id' = r.ext;
        if c is null or c ->> 'status' <> 'upcoming' or (c ->> 'ends_at')::timestamptz < now() then
          delete from public.meetings where user_id = uid and source = 'crm' and external_id = r.ext;
          removed := removed + 1;
        end if;
      end loop;
    end if;

    result := jsonb_build_object(
      'ok', true, 'upcomingInCrm', jsonb_array_length(crm),
      'added', added, 'moved', moved, 'updated', updated, 'removed', removed,
      'firstImport', first_import, 'at', now()
    );
    update private.crm_sync_config set last_run_at = now(), last_result = result where id = 1;
    return result;
  exception when others then
    -- everything above is undone; just record what went wrong and try again next minute
    result := jsonb_build_object('ok', false, 'reason', 'error', 'detail', left(sqlerrm, 240), 'at', now());
    update private.crm_sync_config set last_run_at = now(), last_result = result where id = 1;
    return result;
  end;
end $$;

-- "Sync now" + status for the Settings card (only the connected account; never returns the key)
create or replace function public.crm_sync_now()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email text;
begin
  select user_email into v_email from private.crm_sync_config where id = 1;
  if v_email is null then
    return jsonb_build_object('ok', false, 'reason', 'not_configured');
  end if;
  if not exists (select 1 from auth.users where id = auth.uid() and lower(email) = lower(trim(v_email))) then
    return jsonb_build_object('ok', false, 'reason', 'not_sync_user');
  end if;
  return private.crm_sync();
end $$;

create or replace function public.crm_sync_status()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg private.crm_sync_config;
begin
  select * into cfg from private.crm_sync_config where id = 1;
  if not found then
    return jsonb_build_object('connected', false);
  end if;
  if not exists (select 1 from auth.users where id = auth.uid() and lower(email) = lower(trim(cfg.user_email))) then
    return jsonb_build_object('connected', true, 'mine', false);
  end if;
  return jsonb_build_object('connected', true, 'mine', true, 'lastRunAt', cfg.last_run_at, 'last', cfg.last_result);
end $$;

revoke all on function private.crm_get(text) from public, anon, authenticated;
revoke all on function private.crm_sync() from public, anon, authenticated;
revoke all on function public.crm_sync_now() from public, anon;
revoke all on function public.crm_sync_status() from public, anon;
grant execute on function public.crm_sync_now() to authenticated;
grant execute on function public.crm_sync_status() to authenticated;

-- every minute (re-running this replaces the job instead of adding another)
select cron.schedule('migrizo-crm-sync', '* * * * *', 'select private.crm_sync()');

-- ============ Notification upgrade (Phase 8) — additive only ============
-- Meetings: three push reminders (1 h · 30 min · 5 min); which already went out
alter table public.meetings add column if not exists push_sent text[] not null default '{}';
-- Reminders: when the user pressed Stop (stops the minute-by-minute re-ring on every device)
alter table public.reminders add column if not exists alarm_ack_at bigint;
-- Tasks: afternoon "still due today" digest marker (morning one uses due_push_date)
alter table public.tasks add column if not exists due_push2_date date;

-- Journal location (Phase 8b) — where an entry was written, like Apple Journal
alter table public.journal_entries add column if not exists location jsonb;

-- Alarm snooze (Phase 8c) — additive only: when a snoozed reminder should ring again (UTC ms)
alter table public.reminders add column if not exists snooze_until bigint;

-- ============ Shared phones (Phase 9) — additive only ============
-- A phone/browser has ONE push address. It now belongs to whoever is signed in
-- on it: signing in (or tapping "Turn on") hands it over from the previous
-- account, and signing out releases it. Before this, the first account to turn
-- notifications on kept the phone forever and nobody else could get alerts there.
create or replace function public.claim_push_subscription(p_endpoint text, p_subscription jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if p_endpoint is null or length(p_endpoint) < 20 or p_subscription is null then
    raise exception 'bad subscription';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, subscription)
  values (auth.uid(), p_endpoint, p_subscription)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        subscription = excluded.subscription;
end;
$$;
revoke all on function public.claim_push_subscription(text, jsonb) from public, anon;
grant execute on function public.claim_push_subscription(text, jsonb) to authenticated;

-- ============================================================
-- Team workspaces (Phase 10) — additive only, safe to re-run.
--  • A company is a workspace. Everyone already using Actora gets their own
--    "personal" workspace automatically; nothing they own is changed or moved.
--  • People can belong to several workspaces; a workspace has admins,
--    managers and members, and optional teams (Sales, Tech, Ops…).
--  • Tasks now carry company_id + who they are assigned to / by, a team,
--    and a status. Who may see or change a task is decided HERE (row-level
--    security + functions), never only by hiding buttons in the app.
--  • Meetings, reminders, journal and settings stay private to each person.
-- ============================================================

-- ---------- who people are (auth.users is not readable from the app) ----------
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  email text not null default '',
  created_at timestamptz not null default now()
);

create or replace function public.ws_sync_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''), coalesce(new.email, ''))
  on conflict (user_id) do update
    set email = excluded.email,
        name = case when public.profiles.name = '' then excluded.name else public.profiles.name end;
  return new;
end $$;
drop trigger if exists ws_sync_profile on auth.users;
create trigger ws_sync_profile
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function public.ws_sync_profile();

insert into public.profiles (user_id, name, email)
select id, coalesce(raw_user_meta_data ->> 'name', ''), coalesce(email, '') from auth.users
on conflict (user_id) do nothing;

-- ---------- workspaces ----------
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  logo_url text,
  size text,
  kind text not null default 'company' check (kind in ('company', 'personal')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'manager', 'member')),
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);
create index if not exists memberships_user_idx on public.memberships (user_id);

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  color text,
  created_at timestamptz not null default now()
);
create index if not exists teams_company_idx on public.teams (company_id);

-- one person can be in several teams
create table if not exists public.team_members (
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index if not exists team_members_user_idx on public.team_members (company_id, user_id);

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  email text not null default '',
  role text not null default 'member' check (role in ('admin', 'manager', 'member')),
  team_id uuid references public.teams (id) on delete set null,
  token text not null unique
    default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  invited_by uuid references auth.users (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'cancelled')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid
);
create index if not exists invites_company_idx on public.invites (company_id, status);
create index if not exists invites_email_idx on public.invites (lower(email), status);

-- ---------- tasks: assignment ----------
alter table public.tasks add column if not exists company_id uuid references public.companies (id) on delete cascade;
alter table public.tasks add column if not exists assigned_to uuid references auth.users (id) on delete set null;
alter table public.tasks add column if not exists assigned_by uuid references auth.users (id) on delete set null;
alter table public.tasks add column if not exists team_id uuid references public.teams (id) on delete set null;
alter table public.tasks add column if not exists status text not null default 'todo';
do $$ begin
  alter table public.tasks add constraint tasks_status_check check (status in ('todo', 'in_progress', 'done'));
exception when duplicate_object then null; end $$;
update public.tasks set status = 'done' where done and status <> 'done';
create index if not exists tasks_company_idx on public.tasks (company_id, assigned_to);
create index if not exists tasks_assigned_idx on public.tasks (assigned_to, done);

create table if not exists public.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  company_id uuid references public.companies (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists task_comments_task_idx on public.task_comments (task_id, created_at);

-- in-app notifications ("Priya assigned you a task")
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid references public.companies (id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  task_id uuid references public.tasks (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- which workspace a person has open
alter table public.settings add column if not exists active_company_id uuid;

-- ---------- helpers used by the security rules ----------
create or replace function public.ws_role(p_company uuid)
returns text language sql stable security definer set search_path = public as $$
  select role from public.memberships where company_id = p_company and user_id = auth.uid()
$$;

create or replace function public.ws_is_member(p_company uuid, p_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships where company_id = p_company and user_id = p_user)
$$;

-- two people share at least one workspace
create or replace function public.ws_shares_company(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user = auth.uid() or exists (
    select 1 from public.memberships a
    join public.memberships b on b.company_id = a.company_id
    where a.user_id = auth.uid() and b.user_id = p_user)
$$;

-- a manager's reach: a task in one of their teams, or owned by / assigned to someone in one of their teams
create or replace function public.ws_team_scope(p_company uuid, p_team uuid, p_assigned uuid, p_owner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members tm
    where tm.company_id = p_company and tm.user_id = auth.uid()
      and (tm.team_id = p_team
           or exists (select 1 from public.team_members x
                      where x.team_id = tm.team_id and x.user_id in (p_assigned, p_owner))))
$$;

create or replace function public.ws_can_see_task(p_company uuid, p_owner uuid, p_assigned uuid, p_assigner uuid, p_team uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is null then false
    when p_company is null then p_owner = auth.uid()
    when not public.ws_is_member(p_company) then false
    when p_owner = auth.uid() or p_assigned = auth.uid() or p_assigner = auth.uid() then true
    when public.ws_role(p_company) = 'admin' then true
    when public.ws_role(p_company) = 'manager' then public.ws_team_scope(p_company, p_team, p_assigned, p_owner)
    else false end
$$;

create or replace function public.ws_can_see_task_id(p_task uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select public.ws_can_see_task(t.company_id, t.user_id, t.assigned_to, t.assigned_by, t.team_id)
                   from public.tasks t where t.id = p_task), false)
$$;

-- ---------- tasks: who may read / write (replaces the "own tasks" rule) ----------
drop policy if exists "own tasks" on public.tasks;
drop policy if exists "tasks select" on public.tasks;
drop policy if exists "tasks insert" on public.tasks;
drop policy if exists "tasks update" on public.tasks;
drop policy if exists "tasks delete" on public.tasks;

create policy "tasks select" on public.tasks for select
  using (public.ws_can_see_task(company_id, user_id, assigned_to, assigned_by, team_id));

create policy "tasks insert" on public.tasks for insert
  with check (
    user_id = auth.uid()
    and (company_id is null or public.ws_is_member(company_id))
    and (assigned_to is null or company_id is null or public.ws_is_member(company_id, assigned_to))
    and (team_id is null or exists (select 1 from public.teams t where t.id = tasks.team_id and t.company_id = tasks.company_id)));

create policy "tasks update" on public.tasks for update
  using (public.ws_can_see_task(company_id, user_id, assigned_to, assigned_by, team_id))
  with check (
    (company_id is null or public.ws_is_member(company_id))
    and (assigned_to is null or company_id is null or public.ws_is_member(company_id, assigned_to))
    and (team_id is null or exists (select 1 from public.teams t where t.id = tasks.team_id and t.company_id = tasks.company_id)));

create policy "tasks delete" on public.tasks for delete
  using (user_id = auth.uid() or assigned_by = auth.uid() or (company_id is not null and public.ws_role(company_id) = 'admin'));

-- the server records who assigned a task and keeps done ⇄ status in step
create or replace function public.ws_task_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;          -- a task never changes owner or workspace
    new.company_id := old.company_id;
    if new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null then
      new.assigned_by := coalesce(auth.uid(), new.assigned_by);
    end if;
    if new.status is distinct from old.status then
      new.done := (new.status = 'done');
    elsif new.done is distinct from old.done then
      new.status := case when new.done then 'done' when old.status = 'done' then 'todo' else old.status end;
    end if;
  else
    if new.assigned_to is not null and new.assigned_by is null then new.assigned_by := auth.uid(); end if;
    if new.done and new.status <> 'done' then new.status := 'done'; end if;
    if new.status = 'done' and not new.done then new.done := true; end if;
  end if;
  if new.done and new.completed_at is null then new.completed_at := now(); end if;
  if not new.done then new.completed_at := null; end if;
  return new;
end $$;
drop trigger if exists ws_task_guard on public.tasks;
create trigger ws_task_guard before insert or update on public.tasks
  for each row execute function public.ws_task_guard();

-- ---------- in-app notifications written by the server ----------
create or replace function public.ws_display_name(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(p.name, ''), nullif(split_part(p.email, '@', 1), ''), 'Someone')
  from public.profiles p where p.user_id = p_user
$$;

create or replace function public.ws_task_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor uuid := auth.uid();
begin
  -- assigned to someone else → tell them
  if new.assigned_to is not null and new.assigned_to <> coalesce(actor, new.assigned_by, new.user_id)
     and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to) then
    insert into public.notifications (user_id, company_id, kind, title, body, task_id, actor_id)
    values (new.assigned_to, new.company_id, 'task_assigned',
            public.ws_display_name(coalesce(actor, new.assigned_by, new.user_id)) || ' assigned you a task',
            new.title, new.id, actor);
  end if;
  -- finished by someone else → tell whoever assigned it
  if tg_op = 'UPDATE' and new.done and not old.done and new.assigned_by is not null
     and new.assigned_by <> coalesce(actor, new.assigned_to) then
    insert into public.notifications (user_id, company_id, kind, title, body, task_id, actor_id)
    values (new.assigned_by, new.company_id, 'task_done',
            public.ws_display_name(coalesce(actor, new.assigned_to)) || ' completed a task', new.title, new.id, actor);
  end if;
  return new;
end $$;
drop trigger if exists ws_task_notify on public.tasks;
create trigger ws_task_notify after insert or update on public.tasks
  for each row execute function public.ws_task_notify();

create or replace function public.ws_comment_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare t public.tasks; who uuid;
begin
  select * into t from public.tasks where id = new.task_id;
  if not found then return new; end if;
  new.company_id := t.company_id;
  for who in select distinct u from unnest(array[t.assigned_to, t.user_id, t.assigned_by]) as u
             where u is not null and u <> new.user_id loop
    insert into public.notifications (user_id, company_id, kind, title, body, task_id, actor_id)
    values (who, t.company_id, 'task_comment',
            public.ws_display_name(new.user_id) || ' commented on “' || left(t.title, 60) || '”',
            left(new.body, 140), t.id, new.user_id);
  end loop;
  return new;
end $$;
drop trigger if exists ws_comment_notify on public.task_comments;
create trigger ws_comment_notify before insert on public.task_comments
  for each row execute function public.ws_comment_notify();

-- ---------- row-level security for the new tables ----------
alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.memberships enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.invites enable row level security;
alter table public.task_comments enable row level security;
alter table public.notifications enable row level security;

drop policy if exists "profiles select" on public.profiles;
create policy "profiles select" on public.profiles for select using (public.ws_shares_company(user_id));
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "companies select" on public.companies;
create policy "companies select" on public.companies for select using (public.ws_is_member(id));
drop policy if exists "companies update" on public.companies;
create policy "companies update" on public.companies for update
  using (public.ws_role(id) = 'admin') with check (public.ws_role(id) = 'admin');

drop policy if exists "memberships select" on public.memberships;
create policy "memberships select" on public.memberships for select using (public.ws_is_member(company_id));

drop policy if exists "teams select" on public.teams;
create policy "teams select" on public.teams for select using (public.ws_is_member(company_id));
drop policy if exists "teams write" on public.teams;
create policy "teams write" on public.teams for all
  using (public.ws_role(company_id) = 'admin') with check (public.ws_role(company_id) = 'admin');

drop policy if exists "team_members select" on public.team_members;
create policy "team_members select" on public.team_members for select using (public.ws_is_member(company_id));
drop policy if exists "team_members write" on public.team_members;
create policy "team_members write" on public.team_members for all
  using (public.ws_role(company_id) = 'admin')
  with check (public.ws_role(company_id) = 'admin'
    and public.ws_is_member(company_id, user_id)
    and exists (select 1 from public.teams t where t.id = team_members.team_id and t.company_id = team_members.company_id));

drop policy if exists "invites admin" on public.invites;
create policy "invites admin" on public.invites for all
  using (public.ws_role(company_id) = 'admin')
  with check (public.ws_role(company_id) = 'admin' and invited_by = auth.uid()
    and (team_id is null or exists (select 1 from public.teams t where t.id = invites.team_id and t.company_id = invites.company_id)));

drop policy if exists "comments select" on public.task_comments;
create policy "comments select" on public.task_comments for select using (public.ws_can_see_task_id(task_id));
drop policy if exists "comments insert" on public.task_comments;
create policy "comments insert" on public.task_comments for insert
  with check (user_id = auth.uid() and public.ws_can_see_task_id(task_id));
drop policy if exists "comments delete" on public.task_comments;
create policy "comments delete" on public.task_comments for delete
  using (user_id = auth.uid() or (company_id is not null and public.ws_role(company_id) = 'admin'));

drop policy if exists "notifications own" on public.notifications;
create policy "notifications own" on public.notifications for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- live delivery of notifications to the open app (ignored if already added)
do $$ begin
  alter publication supabase_realtime add table public.notifications;
exception when others then null; end $$;

-- ---------- actions (each one checks the caller's role itself) ----------
create or replace function public.ws_personal_name(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    nullif(split_part((select name from public.settings where user_id = p_user), ' ', 1), ''),
    nullif(split_part((select name from public.profiles where user_id = p_user), ' ', 1), ''),
    nullif(split_part((select email from public.profiles where user_id = p_user), '@', 1), ''),
    'My') || '’s space'
$$;

-- give one person their own personal workspace (no-op if they already belong somewhere)
create or replace function public.ws_ensure_personal(p_user uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  select m.company_id into cid from public.memberships m
    join public.companies c on c.id = m.company_id
    where m.user_id = p_user and c.kind = 'personal' limit 1;
  if cid is null and not exists (select 1 from public.memberships where user_id = p_user) then
    insert into public.companies (name, kind, created_by) values (public.ws_personal_name(p_user), 'personal', p_user)
      returning id into cid;
    insert into public.memberships (company_id, user_id, role) values (cid, p_user, 'admin');
  end if;
  if cid is null then
    select company_id into cid from public.memberships where user_id = p_user order by created_at limit 1;
  end if;
  -- tasks from before workspaces existed move into the person's own space
  update public.tasks set company_id = cid where user_id = p_user and company_id is null;
  return cid;
end $$;

-- everyone who signed up before this update gets their personal space now
do $$
declare u record;
begin
  for u in select id from auth.users loop
    perform public.ws_ensure_personal(u.id);
  end loop;
end $$;

-- called at every sign-in: personal space, pending invites for my email, which workspace to open
create or replace function public.ws_bootstrap()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); inv record; active uuid; joined int := 0;
begin
  if me is null then raise exception 'not signed in'; end if;
  insert into public.profiles (user_id, name, email)
    select id, coalesce(raw_user_meta_data ->> 'name', ''), coalesce(email, '') from auth.users where id = me
    on conflict (user_id) do update set email = excluded.email;
  -- people who signed up before names were kept: use the name from Settings
  update public.profiles p set name = coalesce(nullif(s.name, ''), '')
    from public.settings s where p.user_id = me and s.user_id = me and p.name = '';
  perform public.ws_ensure_personal(me);
  -- invites sent to this email address are accepted automatically
  for inv in select * from public.invites
             where status = 'pending' and expires_at > now() and lower(email) = lower(coalesce(auth.email(), '')) loop
    insert into public.memberships (company_id, user_id, role) values (inv.company_id, me, inv.role)
      on conflict (company_id, user_id) do nothing;
    if inv.team_id is not null then
      insert into public.team_members (team_id, user_id, company_id) values (inv.team_id, me, inv.company_id)
        on conflict do nothing;
    end if;
    update public.invites set status = 'accepted', accepted_at = now(), accepted_by = me where id = inv.id;
    active := inv.company_id;
    joined := joined + 1;
  end loop;
  if active is null then
    select active_company_id into active from public.settings where user_id = me;
    if active is null or not public.ws_is_member(active, me) then
      select m.company_id into active from public.memberships m join public.companies c on c.id = m.company_id
        where m.user_id = me order by (c.kind = 'company') desc, m.created_at limit 1;
    end if;
  end if;
  insert into public.settings (user_id, active_company_id) values (me, active)
    on conflict (user_id) do update set active_company_id = excluded.active_company_id;
  return jsonb_build_object('active', active, 'joined', joined);
end $$;

create or replace function public.ws_create_company(p_name text, p_size text default null, p_logo text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); cid uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  if length(trim(coalesce(p_name, ''))) = 0 or length(p_name) > 80 then raise exception 'name required'; end if;
  if p_logo is not null and length(p_logo) > 60000 then raise exception 'logo too large'; end if;
  insert into public.companies (name, size, logo_url, kind, created_by)
    values (trim(p_name), nullif(p_size, ''), p_logo, 'company', me) returning id into cid;
  insert into public.memberships (company_id, user_id, role) values (cid, me, 'admin');
  insert into public.settings (user_id, active_company_id) values (me, cid)
    on conflict (user_id) do update set active_company_id = excluded.active_company_id;
  return cid;
end $$;

-- what an invite link shows before signing in (no personal data beyond the inviter's first name)
create or replace function public.ws_invite_preview(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  select i.*, c.name as company_name, c.logo_url into inv
    from public.invites i join public.companies c on c.id = i.company_id where i.token = p_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if inv.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', inv.status); end if;
  if inv.expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  return jsonb_build_object('ok', true, 'company', inv.company_name, 'logo', inv.logo_url, 'email', inv.email,
    'role', inv.role, 'inviter', split_part(public.ws_display_name(inv.invited_by), ' ', 1));
end $$;

create or replace function public.ws_accept_invite(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); inv record;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into inv from public.invites where token = p_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if inv.status = 'accepted' and public.ws_is_member(inv.company_id, me) then
    return jsonb_build_object('ok', true, 'company', inv.company_id, 'already', true);
  end if;
  if inv.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', inv.status); end if;
  if inv.expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if inv.email <> '' and lower(inv.email) <> lower(coalesce(auth.email(), '')) then
    return jsonb_build_object('ok', false, 'reason', 'email_mismatch', 'email', inv.email);
  end if;
  insert into public.memberships (company_id, user_id, role) values (inv.company_id, me, inv.role)
    on conflict (company_id, user_id) do nothing;
  if inv.team_id is not null then
    insert into public.team_members (team_id, user_id, company_id) values (inv.team_id, me, inv.company_id)
      on conflict do nothing;
  end if;
  update public.invites set status = 'accepted', accepted_at = now(), accepted_by = me where id = inv.id;
  insert into public.settings (user_id, active_company_id) values (me, inv.company_id)
    on conflict (user_id) do update set active_company_id = excluded.active_company_id;
  return jsonb_build_object('ok', true, 'company', inv.company_id);
end $$;

create or replace function public.ws_set_role(p_company uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.ws_role(p_company) <> 'admin' then raise exception 'admins only'; end if;
  if p_role not in ('admin', 'manager', 'member') then raise exception 'bad role'; end if;
  if p_role <> 'admin' and (select count(*) from public.memberships where company_id = p_company and role = 'admin') = 1
     and exists (select 1 from public.memberships where company_id = p_company and user_id = p_user and role = 'admin') then
    raise exception 'a workspace needs at least one admin';
  end if;
  update public.memberships set role = p_role where company_id = p_company and user_id = p_user;
end $$;

-- admins remove people; anyone may leave a workspace themselves (never the last admin)
create or replace function public.ws_remove_member(p_company uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user <> auth.uid() and public.ws_role(p_company) <> 'admin' then raise exception 'admins only'; end if;
  if (select count(*) from public.memberships where company_id = p_company and role = 'admin') = 1
     and exists (select 1 from public.memberships where company_id = p_company and user_id = p_user and role = 'admin') then
    raise exception 'a workspace needs at least one admin';
  end if;
  delete from public.team_members where company_id = p_company and user_id = p_user;
  delete from public.memberships where company_id = p_company and user_id = p_user;
  update public.tasks set assigned_to = null where company_id = p_company and assigned_to = p_user;
  update public.settings set active_company_id = null where user_id = p_user and active_company_id = p_company;
end $$;

revoke all on function public.ws_bootstrap() from public, anon;
revoke all on function public.ws_create_company(text, text, text) from public, anon;
revoke all on function public.ws_accept_invite(text) from public, anon;
revoke all on function public.ws_set_role(uuid, uuid, text) from public, anon;
revoke all on function public.ws_remove_member(uuid, uuid) from public, anon;
revoke all on function public.ws_ensure_personal(uuid) from public, anon, authenticated;
grant execute on function public.ws_bootstrap() to authenticated;
grant execute on function public.ws_create_company(text, text, text) to authenticated;
grant execute on function public.ws_accept_invite(text) to authenticated;
grant execute on function public.ws_set_role(uuid, uuid, text) to authenticated;
grant execute on function public.ws_remove_member(uuid, uuid) to authenticated;
grant execute on function public.ws_invite_preview(text) to anon, authenticated;

-- =====================================================================
-- Meeting emails (Phase 11) — additive and safe to re-run.
-- A log of every meeting email the server sent (host confirmation and the
-- guest's calendar invite). It stops duplicates, caps a runaway account and
-- lets a cancellation reach the guest after the meeting itself is deleted.
-- Only the server (service role) reads or writes it: RLS on, no policies.
-- =====================================================================
create table if not exists public.meeting_emails (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  meeting_id uuid not null,
  event text not null check (event in ('scheduled', 'booked', 'rescheduled', 'cancelled')),
  guest_email text,
  title text,
  person_name text,
  date date,
  start_min integer,
  duration_min integer,
  meet_link text,
  created_at timestamptz not null default now()
);
create index if not exists meeting_emails_meeting_idx on public.meeting_emails (meeting_id, created_at desc);
create index if not exists meeting_emails_user_idx on public.meeting_emails (user_id, created_at desc);
alter table public.meeting_emails enable row level security;
revoke all on public.meeting_emails from anon, authenticated;

-- =====================================================================
-- AI notes recordings (Phase 12) — additive and safe to re-run.
-- Meeting recordings live in a PRIVATE storage bucket, one folder per
-- user (<user_id>/<meeting_id>.webm). Only that user can read, add or
-- delete files in their folder; the server signs short-lived links for
-- transcription.
-- =====================================================================
alter table public.meetings add column if not exists recording_path text;
alter table public.meetings add column if not exists recording_sec integer;

insert into storage.buckets (id, name, public, file_size_limit)
values ('recordings', 'recordings', false, 262144000)
on conflict (id) do update set public = false, file_size_limit = 262144000;

drop policy if exists "recordings: own folder read" on storage.objects;
create policy "recordings: own folder read" on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "recordings: own folder write" on storage.objects;
create policy "recordings: own folder write" on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "recordings: own folder update" on storage.objects;
create policy "recordings: own folder update" on storage.objects for update to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "recordings: own folder delete" on storage.objects;
create policy "recordings: own folder delete" on storage.objects for delete to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============ notes (Phase 13) — Notion-style pages ============
-- Additive and safe to re-run. Each note is a title, an optional emoji and the
-- editor document as JSON; `plain` is a text copy for search and previews.
create table if not exists public.notes (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default '',
  icon text,
  content jsonb not null default '{"type":"doc"}',
  plain text not null default '',
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists notes_user_idx on public.notes (user_id, updated_at desc);
alter table public.notes enable row level security;
drop policy if exists "own notes" on public.notes;
create policy "own notes" on public.notes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());


-- ============================================================
-- Phase 14 (2026-11): due times, subtasks, "Plan my day" blocks,
-- Notes for teams (team / private pages, nested pages, covers,
-- pages linked to meetings and tasks). Additive — nothing is dropped.
-- ============================================================
alter table public.tasks add column if not exists due_min integer check (due_min between 0 and 1439);
alter table public.tasks add column if not exists subtasks jsonb not null default '[]'::jsonb;

alter table public.blocked_times add column if not exists task_id uuid;

alter table public.notes add column if not exists company_id uuid references public.companies (id) on delete cascade;
alter table public.notes add column if not exists shared boolean not null default false;
alter table public.notes add column if not exists parent_id uuid;
alter table public.notes add column if not exists cover text;
alter table public.notes add column if not exists meeting_id uuid;
alter table public.notes add column if not exists task_id uuid;
alter table public.notes add column if not exists updated_by uuid;
create index if not exists notes_company_idx on public.notes (company_id, shared, updated_at desc);

-- who may read / write a page: its owner always; every workspace member for a
-- team page; workspace admins may delete team pages
drop policy if exists "own notes" on public.notes;
drop policy if exists "notes select" on public.notes;
drop policy if exists "notes insert" on public.notes;
drop policy if exists "notes update" on public.notes;
drop policy if exists "notes delete" on public.notes;
create policy "notes select" on public.notes for select
  using (user_id = auth.uid() or (shared and company_id is not null and public.ws_is_member(company_id)));
create policy "notes insert" on public.notes for insert
  with check (user_id = auth.uid() and (company_id is null or public.ws_is_member(company_id)));
create policy "notes update" on public.notes for update
  using (user_id = auth.uid() or (shared and company_id is not null and public.ws_is_member(company_id)))
  with check (company_id is null or public.ws_is_member(company_id));
create policy "notes delete" on public.notes for delete
  using (user_id = auth.uid() or (company_id is not null and public.ws_role(company_id) = 'admin'));

-- a page never changes owner or workspace; the server records who last edited it
create or replace function public.note_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
    new.company_id := old.company_id;
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;
drop trigger if exists note_guard on public.notes;
create trigger note_guard before insert or update on public.notes
  for each row execute function public.note_guard();

-- =====================================================================
-- Phase 15 (2026-11): hand tasks to people who are invited but haven't
-- joined yet, and email people when a task is assigned to them.
-- Additive and safe to re-run: nothing is dropped or deleted.
-- =====================================================================

-- a task waiting for an invited person (becomes assigned_to when they join)
alter table public.tasks add column if not exists assigned_invite uuid references public.invites (id) on delete set null;
create index if not exists tasks_invite_idx on public.tasks (assigned_invite) where assigned_invite is not null;

-- when the "assigned to you" push/email went out (null = not yet)
alter table public.notifications add column if not exists sent_at timestamptz;

-- people invited to a workspace and not joined yet, for anyone in it to assign
-- to: id, email, role and team only; the join link (token) is never returned
create or replace function public.ws_pending_people(p_company uuid)
returns table (id uuid, email text, role text, team_id uuid, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.id, i.email, i.role, i.team_id, i.created_at
  from public.invites i
  where i.company_id = p_company and i.status = 'pending' and i.email <> '' and i.expires_at > now()
    and public.ws_is_member(p_company)
  order by i.created_at desc
$$;
revoke all on function public.ws_pending_people(uuid) from public, anon;
grant execute on function public.ws_pending_people(uuid) to authenticated;

-- the task guard, now aware of invited people (replaces the Phase 12 version)
create or replace function public.ws_task_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- an invited-person placeholder must be a pending invite of the same workspace,
  -- and a task is held by a member OR waits for an invite, never both
  if new.assigned_invite is not null then
    if new.assigned_to is not null
       or not exists (select 1 from public.invites i
                      where i.id = new.assigned_invite and i.company_id = new.company_id and i.status = 'pending') then
      new.assigned_invite := null;
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;          -- a task never changes owner or workspace
    new.company_id := old.company_id;
    if new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null
       -- the invited person claiming their waiting task keeps who assigned it
       and not (old.assigned_invite is not null and new.assigned_to = auth.uid()) then
      new.assigned_by := coalesce(auth.uid(), new.assigned_by);
    end if;
    if new.assigned_invite is not null and new.assigned_invite is distinct from old.assigned_invite then
      new.assigned_by := coalesce(auth.uid(), new.assigned_by);
    end if;
    if new.status is distinct from old.status then
      new.done := (new.status = 'done');
    elsif new.done is distinct from old.done then
      new.status := case when new.done then 'done' when old.status = 'done' then 'todo' else old.status end;
    end if;
  else
    if (new.assigned_to is not null or new.assigned_invite is not null) and new.assigned_by is null then
      new.assigned_by := auth.uid();
    end if;
    if new.done and new.status <> 'done' then new.status := 'done'; end if;
    if new.status = 'done' and not new.done then new.done := true; end if;
  end if;
  if new.done and new.completed_at is null then new.completed_at := now(); end if;
  if not new.done then new.completed_at := null; end if;
  return new;
end $$;

-- accepting an invite also hands over every task that was waiting for that person
create or replace function public.ws_accept_invite(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); inv record; waiting int := 0;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into inv from public.invites where token = p_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if inv.status = 'accepted' and public.ws_is_member(inv.company_id, me) then
    return jsonb_build_object('ok', true, 'company', inv.company_id, 'already', true);
  end if;
  if inv.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', inv.status); end if;
  if inv.expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if inv.email <> '' and lower(inv.email) <> lower(coalesce(auth.email(), '')) then
    return jsonb_build_object('ok', false, 'reason', 'email_mismatch', 'email', inv.email);
  end if;
  insert into public.memberships (company_id, user_id, role) values (inv.company_id, me, inv.role)
    on conflict (company_id, user_id) do nothing;
  if inv.team_id is not null then
    insert into public.team_members (team_id, user_id, company_id) values (inv.team_id, me, inv.company_id)
      on conflict do nothing;
  end if;
  update public.tasks set assigned_to = me, assigned_invite = null where assigned_invite = inv.id;
  get diagnostics waiting = row_count;
  update public.invites set status = 'accepted', accepted_at = now(), accepted_by = me where id = inv.id;
  insert into public.settings (user_id, active_company_id) values (me, inv.company_id)
    on conflict (user_id) do update set active_company_id = excluded.active_company_id;
  if waiting > 0 then
    insert into public.notifications (user_id, company_id, kind, title, body, actor_id, sent_at)
    values (me, inv.company_id, 'tasks_waiting',
            case when waiting = 1 then '1 task is waiting for you' else waiting || ' tasks are waiting for you' end,
            public.ws_display_name(inv.invited_by) || ' assigned them before you joined', inv.invited_by, now());
  end if;
  return jsonb_build_object('ok', true, 'company', inv.company_id, 'waiting', waiting);
end $$;
revoke all on function public.ws_accept_invite(text) from public, anon;
grant execute on function public.ws_accept_invite(text) to authenticated;

-- a cancelled invite gives its waiting tasks back (unassigned, still owned by their writer)
create or replace function public.ws_invite_release()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    update public.tasks set assigned_invite = null where assigned_invite = new.id;
  end if;
  return new;
end $$;
drop trigger if exists ws_invite_release on public.invites;
create trigger ws_invite_release after update of status on public.invites
  for each row execute function public.ws_invite_release();

-- =====================================================================
-- Workspace chat (Phase 1, 2026-11): direct messages, groups, a channel per
-- team and #general — with live delivery, presence and a 3-month retention.
-- Additive and safe to re-run: nothing existing is dropped or changed.
-- The only deletion is the daily clean-up of messages older than 90 days,
-- which the company chose as its retention period.
-- =====================================================================

-- ---------- tables ----------

-- a chat: a DM, a group, a team's channel or the workspace-wide #general
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null check (kind in ('dm', 'group', 'team', 'general')),
  name text not null default '',
  team_id uuid references public.teams (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz
);
create index if not exists conversations_company_idx on public.conversations (company_id, last_message_at desc);
create unique index if not exists conversations_team_idx on public.conversations (team_id) where team_id is not null;
create unique index if not exists conversations_general_idx on public.conversations (company_id) where kind = 'general';

-- who is in a chat, and their own settings for it
create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  muted boolean not null default false,
  pinned boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx on public.conversation_members (user_id, company_id);

-- the messages (ids are made on the sender's device, so a retry never duplicates)
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  sender_id uuid not null references auth.users (id) on delete cascade,
  body text not null default '',
  reply_to uuid references public.messages (id) on delete set null,
  mentions uuid[] not null default '{}',
  -- pictures and files: [{path, name, size, type, w, h}] in the chat-files bucket
  attachments jsonb not null default '[]'::jsonb,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.messages add column if not exists attachments jsonb not null default '[]'::jsonb;
create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at desc);
create index if not exists messages_created_idx on public.messages (created_at);

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

-- per-person chat settings: do-not-disturb and when they were last in the app
create table if not exists public.chat_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  dnd_until timestamptz,
  last_seen_at timestamptz,
  updated_at timestamptz not null default now()
);

-- a person's time zone, visible to workspace-mates ("9:40 PM for Wen")
alter table public.profiles add column if not exists timezone text;
update public.profiles p set timezone = s.timezone
  from public.settings s where s.user_id = p.user_id and p.timezone is null and s.timezone is not null and s.timezone <> '';

create or replace function public.chat_sync_timezone()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.timezone is not null and new.timezone <> '' then
    update public.profiles set timezone = new.timezone where user_id = new.user_id and timezone is distinct from new.timezone;
  end if;
  return new;
end $$;
drop trigger if exists chat_sync_timezone on public.settings;
create trigger chat_sync_timezone after insert or update of timezone on public.settings
  for each row execute function public.chat_sync_timezone();

-- ---------- helpers used by the security rules ----------

create or replace function public.chat_is_member(p_conversation uuid, p_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversation_members where conversation_id = p_conversation and user_id = p_user)
$$;

create or replace function public.chat_kind(p_conversation uuid)
returns text language sql stable security definer set search_path = public as $$
  select kind from public.conversations where id = p_conversation
$$;

-- ---------- row-level security ----------

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.chat_prefs enable row level security;

-- a chat is visible to its members only — admins included, no exceptions
drop policy if exists "conversations select" on public.conversations;
create policy "conversations select" on public.conversations for select using (public.chat_is_member(id));
-- groups can be renamed by their members (DMs and channels are named by the system)
drop policy if exists "conversations update" on public.conversations;
create policy "conversations update" on public.conversations for update
  using (kind = 'group' and public.chat_is_member(id)) with check (kind = 'group' and public.chat_is_member(id));

drop policy if exists "conversation_members select" on public.conversation_members;
create policy "conversation_members select" on public.conversation_members for select using (public.chat_is_member(conversation_id));
-- any member of a group may add a workspace-mate to it
drop policy if exists "conversation_members insert" on public.conversation_members;
create policy "conversation_members insert" on public.conversation_members for insert
  with check (public.chat_kind(conversation_id) = 'group' and public.chat_is_member(conversation_id) and public.ws_is_member(company_id, user_id));
-- your own row: read marker, mute, pin
drop policy if exists "conversation_members update" on public.conversation_members;
create policy "conversation_members update" on public.conversation_members for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- leaving a group
drop policy if exists "conversation_members delete" on public.conversation_members;
create policy "conversation_members delete" on public.conversation_members for delete
  using (user_id = auth.uid() and public.chat_kind(conversation_id) = 'group');

drop policy if exists "messages select" on public.messages;
create policy "messages select" on public.messages for select using (public.chat_is_member(conversation_id));
drop policy if exists "messages insert" on public.messages;
create policy "messages insert" on public.messages for insert
  with check (sender_id = auth.uid() and public.chat_is_member(conversation_id));
-- edit or remove your own; admins may remove messages in team channels and #general (never in DMs or groups)
drop policy if exists "messages update" on public.messages;
create policy "messages update" on public.messages for update
  using (sender_id = auth.uid()
         or (public.chat_kind(conversation_id) in ('team', 'general') and public.ws_role(company_id) = 'admin'))
  with check (public.chat_is_member(conversation_id)
         or (public.chat_kind(conversation_id) in ('team', 'general') and public.ws_role(company_id) = 'admin'));

drop policy if exists "reactions select" on public.message_reactions;
create policy "reactions select" on public.message_reactions for select
  using (exists (select 1 from public.messages m where m.id = message_id and public.chat_is_member(m.conversation_id)));
drop policy if exists "reactions insert" on public.message_reactions;
create policy "reactions insert" on public.message_reactions for insert
  with check (user_id = auth.uid() and exists (select 1 from public.messages m where m.id = message_id and public.chat_is_member(m.conversation_id)));
drop policy if exists "reactions delete" on public.message_reactions;
create policy "reactions delete" on public.message_reactions for delete using (user_id = auth.uid());

drop policy if exists "chat_prefs select" on public.chat_prefs;
create policy "chat_prefs select" on public.chat_prefs for select using (public.ws_shares_company(user_id));
drop policy if exists "chat_prefs write" on public.chat_prefs;
create policy "chat_prefs write" on public.chat_prefs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- guards (what a row may become) ----------

-- a message always belongs to its chat's workspace; only its writer may change the words
create or replace function public.chat_message_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    select company_id into new.company_id from public.conversations where id = new.conversation_id;
    if new.company_id is null then raise exception 'unknown conversation'; end if;
    -- the sender's clock is trusted within a few minutes (keeps ordering steady across devices)
    if new.created_at is null or abs(extract(epoch from (new.created_at - now()))) > 300 then new.created_at := now(); end if;
    if new.reply_to is not null and not exists (select 1 from public.messages r where r.id = new.reply_to and r.conversation_id = new.conversation_id) then
      new.reply_to := null;
    end if;
    if length(new.body) > 8000 then new.body := left(new.body, 8000); end if;
  else
    new.conversation_id := old.conversation_id;
    new.company_id := old.company_id;
    new.sender_id := old.sender_id;
    new.created_at := old.created_at;
    new.reply_to := old.reply_to;
    if old.deleted_at is not null then return old; end if;   -- a removed message stays removed
    if auth.uid() is distinct from old.sender_id then
      -- an admin tidying a channel may only remove, never rewrite
      new.body := old.body;
      new.mentions := old.mentions;
      new.edited_at := old.edited_at;
      if new.deleted_at is null then return old; end if;
    elsif new.body is distinct from old.body then
      new.edited_at := now();
      if length(new.body) > 8000 then new.body := left(new.body, 8000); end if;
    end if;
    if new.deleted_at is not null then
      new.body := ''; new.mentions := '{}'; new.attachments := '[]'::jsonb;
      -- a removed message takes its files with it
      delete from storage.objects where bucket_id = 'chat-files'
        and name like old.company_id || '/' || old.conversation_id || '/' || old.id || '/%';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists chat_message_guard on public.messages;
create trigger chat_message_guard before insert or update on public.messages
  for each row execute function public.chat_message_guard();

-- the chat list is ordered by the latest message
create or replace function public.chat_message_touch()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = new.created_at
    where id = new.conversation_id and (last_message_at is null or last_message_at < new.created_at);
  return new;
end $$;
drop trigger if exists chat_message_touch on public.messages;
create trigger chat_message_touch after insert on public.messages
  for each row execute function public.chat_message_touch();

-- a member's row: only the read marker, mute and pin may change
create or replace function public.chat_member_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.conversation_id := old.conversation_id;
  new.user_id := old.user_id;
  new.company_id := old.company_id;
  new.joined_at := old.joined_at;
  return new;
end $$;
drop trigger if exists chat_member_guard on public.conversation_members;
create trigger chat_member_guard before update on public.conversation_members
  for each row execute function public.chat_member_guard();

-- a group's kind, workspace and team never change
create or replace function public.chat_conversation_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.kind := old.kind;
  new.company_id := old.company_id;
  new.team_id := old.team_id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if length(new.name) > 80 then new.name := left(new.name, 80); end if;
  return new;
end $$;
drop trigger if exists chat_conversation_guard on public.conversations;
create trigger chat_conversation_guard before update on public.conversations
  for each row execute function public.chat_conversation_guard();

-- ---------- channels that look after themselves ----------

-- every company workspace has #general with everyone in it
create or replace function public.chat_ensure_general(p_company uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  select id into cid from public.conversations where company_id = p_company and kind = 'general';
  if cid is null then
    if not exists (select 1 from public.companies where id = p_company and kind = 'company') then return null; end if;
    insert into public.conversations (company_id, kind, name) values (p_company, 'general', 'general') returning id into cid;
  end if;
  insert into public.conversation_members (conversation_id, user_id, company_id)
    select cid, m.user_id, p_company from public.memberships m where m.company_id = p_company
    on conflict do nothing;
  return cid;
end $$;

-- every team has its own channel with the team's people in it
create or replace function public.chat_ensure_team(p_team uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare t public.teams; cid uuid;
begin
  select * into t from public.teams where id = p_team;
  if not found then return null; end if;
  select id into cid from public.conversations where team_id = p_team;
  if cid is null then
    insert into public.conversations (company_id, kind, name, team_id) values (t.company_id, 'team', t.name, p_team) returning id into cid;
  else
    update public.conversations set name = t.name where id = cid and name <> t.name;
  end if;
  insert into public.conversation_members (conversation_id, user_id, company_id)
    select cid, tm.user_id, t.company_id from public.team_members tm where tm.team_id = p_team
    on conflict do nothing;
  return cid;
end $$;

create or replace function public.chat_on_company()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.chat_ensure_general(new.id);
  return new;
end $$;
drop trigger if exists chat_on_company on public.companies;
create trigger chat_on_company after insert on public.companies
  for each row execute function public.chat_on_company();

-- joining a workspace puts you in #general; leaving it takes you out of every chat there
create or replace function public.chat_on_membership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.chat_ensure_general(new.company_id);
    return new;
  end if;
  delete from public.conversation_members where company_id = old.company_id and user_id = old.user_id;
  return old;
end $$;
drop trigger if exists chat_on_membership on public.memberships;
create trigger chat_on_membership after insert or delete on public.memberships
  for each row execute function public.chat_on_membership();

create or replace function public.chat_on_team()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.chat_ensure_team(new.id);
  return new;
end $$;
drop trigger if exists chat_on_team on public.teams;
create trigger chat_on_team after insert or update of name on public.teams
  for each row execute function public.chat_on_team();

create or replace function public.chat_on_team_member()
returns trigger language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if tg_op = 'INSERT' then
    cid := public.chat_ensure_team(new.team_id);
    if cid is not null then
      insert into public.conversation_members (conversation_id, user_id, company_id) values (cid, new.user_id, new.company_id)
        on conflict do nothing;
    end if;
    return new;
  end if;
  delete from public.conversation_members cm using public.conversations c
    where c.id = cm.conversation_id and c.team_id = old.team_id and cm.user_id = old.user_id;
  return old;
end $$;
drop trigger if exists chat_on_team_member on public.team_members;
create trigger chat_on_team_member after insert or delete on public.team_members
  for each row execute function public.chat_on_team_member();

-- workspaces and teams that already exist get their channels now
do $$
declare r record;
begin
  for r in select id from public.companies where kind = 'company' loop
    perform public.chat_ensure_general(r.id);
  end loop;
  for r in select id from public.teams loop
    perform public.chat_ensure_team(r.id);
  end loop;
end $$;

-- ---------- actions ----------

-- the DM between you and a workspace-mate (made the first time either of you opens it)
create or replace function public.chat_open_dm(p_company uuid, p_user uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); cid uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_user = me then raise exception 'that is you'; end if;
  if not public.ws_is_member(p_company, me) or not public.ws_is_member(p_company, p_user) then raise exception 'not in this workspace'; end if;
  select c.id into cid from public.conversations c
    where c.company_id = p_company and c.kind = 'dm'
      and exists (select 1 from public.conversation_members a where a.conversation_id = c.id and a.user_id = me)
      and exists (select 1 from public.conversation_members b where b.conversation_id = c.id and b.user_id = p_user)
    limit 1;
  if cid is null then
    insert into public.conversations (company_id, kind, created_by) values (p_company, 'dm', me) returning id into cid;
    insert into public.conversation_members (conversation_id, user_id, company_id) values (cid, me, p_company), (cid, p_user, p_company);
  end if;
  return cid;
end $$;
revoke all on function public.chat_open_dm(uuid, uuid) from public, anon;
grant execute on function public.chat_open_dm(uuid, uuid) to authenticated;

-- a group with the people you picked (workspace-mates only)
create or replace function public.chat_create_group(p_company uuid, p_name text, p_users uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); cid uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  if not public.ws_is_member(p_company, me) then raise exception 'not in this workspace'; end if;
  insert into public.conversations (company_id, kind, name, created_by)
    values (p_company, 'group', left(trim(coalesce(p_name, '')), 80), me) returning id into cid;
  insert into public.conversation_members (conversation_id, user_id, company_id)
    select cid, u, p_company from unnest(array_append(p_users, me)) as u
    where public.ws_is_member(p_company, u)
    on conflict do nothing;
  return cid;
end $$;
revoke all on function public.chat_create_group(uuid, text, uuid[]) from public, anon;
grant execute on function public.chat_create_group(uuid, text, uuid[]) to authenticated;

-- everything the chat list needs, in one call: my chats (with members, read
-- markers, unread counts and the latest message) and who was last seen when
create or replace function public.chat_overview(p_company uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public.ws_is_member(p_company) then jsonb_build_object(
    'conversations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'kind', c.kind, 'name', c.name, 'team_id', c.team_id, 'created_by', c.created_by,
        'created_at', c.created_at, 'last_message_at', c.last_message_at,
        'last_read_at', cm.last_read_at, 'muted', cm.muted, 'pinned', cm.pinned,
        'members', (select coalesce(jsonb_agg(jsonb_build_object('u', x.user_id, 'r', x.last_read_at)), '[]'::jsonb)
                    from public.conversation_members x where x.conversation_id = c.id),
        'unread', (select count(*) from public.messages m
                   where m.conversation_id = c.id and m.created_at > cm.last_read_at and m.sender_id <> auth.uid() and m.deleted_at is null),
        'last', (select jsonb_build_object('id', m.id, 'sender_id', m.sender_id,
                   'body', case when m.deleted_at is null then left(m.body, 160) else '' end,
                   'created_at', m.created_at, 'deleted', m.deleted_at is not null,
                   'files', coalesce(jsonb_array_length(m.attachments), 0))
                 from public.messages m where m.conversation_id = c.id order by m.created_at desc limit 1)
      ) order by cm.pinned desc, c.last_message_at desc nulls last, c.created_at desc)
      from public.conversations c
      join public.conversation_members cm on cm.conversation_id = c.id and cm.user_id = auth.uid()
      where c.company_id = p_company), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('u', p.user_id, 'seen', p.last_seen_at, 'dnd', p.dnd_until))
      from public.chat_prefs p
      where exists (select 1 from public.memberships mm where mm.company_id = p_company and mm.user_id = p.user_id)), '[]'::jsonb)
  ) else null end
$$;
revoke all on function public.chat_overview(uuid) from public, anon;
grant execute on function public.chat_overview(uuid) to authenticated;

-- ---------- pictures and files ----------
-- Attachments live in a private storage bucket at
-- <company>/<conversation>/<message>/<file>. Only the chat's members may read
-- or add them; they are removed with their message (deleted, or expired).
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;

create or replace function public.chat_object_allowed(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare parts text[];
begin
  if auth.uid() is null then return false; end if;
  parts := storage.foldername(p_name);
  if parts is null or array_length(parts, 1) < 3 then return false; end if;
  return public.chat_is_member(parts[2]::uuid);
exception when others then
  return false;
end $$;

drop policy if exists "chat files read" on storage.objects;
create policy "chat files read" on storage.objects for select to authenticated
  using (bucket_id = 'chat-files' and public.chat_object_allowed(name));
drop policy if exists "chat files upload" on storage.objects;
create policy "chat files upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-files' and public.chat_object_allowed(name));

create or replace function public.chat_drop_files()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from storage.objects where bucket_id = 'chat-files'
    and name like old.company_id || '/' || old.conversation_id || '/' || old.id || '/%';
  return old;
end $$;
drop trigger if exists chat_drop_files on public.messages;
create trigger chat_drop_files after delete on public.messages
  for each row execute function public.chat_drop_files();

-- ---------- live delivery (Supabase Realtime, private channels) ----------
-- Messages, typing and presence travel over channels named chat:conv:<id> and
-- chat:ws:<company id>. Only a chat's members may join its channel; only
-- workspace members may join the workspace channel.

create or replace function public.chat_topic_allowed(p_topic text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare id uuid;
begin
  if auth.uid() is null then return false; end if;
  if p_topic like 'chat:conv:%' then
    id := substring(p_topic from 11)::uuid;
    return public.chat_is_member(id);
  elsif p_topic like 'chat:ws:%' then
    id := substring(p_topic from 9)::uuid;
    return public.ws_is_member(id);
  end if;
  return false;
exception when others then
  return false;
end $$;

do $$ begin
  drop policy if exists "chat realtime read" on realtime.messages;
  create policy "chat realtime read" on realtime.messages for select to authenticated
    using (public.chat_topic_allowed(realtime.topic()));
  drop policy if exists "chat realtime write" on realtime.messages;
  create policy "chat realtime write" on realtime.messages for insert to authenticated
    with check (public.chat_topic_allowed(realtime.topic()));
exception when others then
  raise notice 'realtime authorization not available on this project: %', sqlerrm;
end $$;

-- ---------- retention: messages disappear after 3 months ----------
-- Runs every night. Reactions go with their messages; nothing else is touched.
create extension if not exists pg_cron;
do $$ begin
  perform cron.unschedule('taskorra-chat-retention');
exception when others then null; end $$;
select cron.schedule('taskorra-chat-retention', '20 3 * * *',
  $$delete from public.messages where created_at < now() - interval '90 days'$$);
