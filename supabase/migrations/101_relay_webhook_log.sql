-- =============================================================================
-- 101 — WEBHOOK DELIVERY LOG
-- -----------------------------------------------------------------------------
-- Records EVERY inbound call to the webhook, including the ones we reject.
--
-- WHY: when messages do not arrive, there are only three possibilities, and
-- without a log they are indistinguishable from each other:
--
--   1. the provider never called us            -> no rows at all
--   2. the provider called and we rejected it  -> rows with ok = false
--   3. we accepted it and something else broke -> rows with ok = true
--
-- Debugging that by reading hosting-platform logs is slow and easy to get
-- wrong. A row per attempt, visible inside the app, answers it instantly.
--
-- Deliberately records NO message body — only metadata, a short preview and
-- the reason. A rejected call is untrusted input; storing it whole would mean
-- storing whatever a stranger sent.
--
-- Idempotent. Safe to run twice.
-- =============================================================================

create table if not exists public.relay_webhook_log (
  id            uuid primary key default gen_random_uuid(),
  received_at   timestamptz not null default now(),
  ok            boolean not null,
  -- 'signature' | 'query_key' when accepted; 'signature_mismatch' |
  -- 'no_signature' | 'no_secret_configured' when not.
  reason        text not null,
  event_type    text,
  sig_present   boolean not null default false,
  phone         text,
  -- First 200 characters only, for recognising the shape of what arrived.
  body_preview  text,
  handled       text
);

create index if not exists idx_relay_webhook_log_time
  on public.relay_webhook_log (received_at desc);

alter table public.relay_webhook_log enable row level security;

-- Any signed-in member of the workspace may read it. Writes come from the
-- service role inside the webhook route, which bypasses RLS.
drop policy if exists "relay webhook log select" on public.relay_webhook_log;
create policy "relay webhook log select" on public.relay_webhook_log
  for select using (auth.uid() is not null);

-- Keep it small — this is a debugging aid, not an archive.
create or replace function public.relay_trim_webhook_log()
returns void language sql security definer set search_path = public as $$
  delete from public.relay_webhook_log
   where id not in (
     select id from public.relay_webhook_log order by received_at desc limit 200
   );
$$;

do $$ begin raise notice '101 DONE: relay_webhook_log ready.'; end $$;
