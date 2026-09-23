-- =============================================================================
-- 121 — EVERY CV THAT ARRIVES ON WHATSAPP, AND WHAT HAPPENED TO IT
-- -----------------------------------------------------------------------------
-- Until now only SUCCESSFUL captures left a trace (activity 'cv_profile_saved').
-- A CV that was skipped — sent from a number not linked to a lead, scored just
-- under the bar, scanned, or in the old .doc format — vanished without a
-- record, and nobody could see that anyone had been left behind.
--
-- One row per inbound document, written by the webhook the moment the file is
-- judged. The Leads page reads this for its "CVs from WhatsApp" popup.
--
--   saved       text is on the lead (automatically)
--   review      readable and CV-like, but not certain enough to save alone
--   unmatched   looks like a CV, but no lead could be found for the sender
--   unreadable  scanned PDF, photo, garbled text or old .doc — a human must look
--   not_cv      readable, and clearly something else (passport, invoice, ...)
--   approved    a human saved it from the popup
--   dismissed   a human marked it as not needing a CV
--
-- Safe to run twice.
-- =============================================================================

create table if not exists public.relay_cv_captures (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  message_id      uuid not null references public.relay_messages(id) on delete cascade,
  conversation_id uuid not null references public.relay_conversations(id) on delete cascade,
  lead_id         uuid references public.leads(id) on delete set null,
  phone_e164      text,
  file_name       text,
  file_mime       text,
  status          text not null check (status in
                    ('saved','review','unmatched','unreadable','not_cv','approved','dismissed')),
  reason          text,
  cv_score        numeric(4,2),
  match_method    text,          -- conversation | phone | form_email | form_phone | cv_email | cv_phone
  extracted_text  text,          -- kept for review / unmatched items, so approving needs no re-read
  received_at     timestamptz not null default now(),
  resolved_at     timestamptz,
  resolved_by     uuid,
  unique (message_id)
);

create index if not exists ix_rcc_ws_received on public.relay_cv_captures (workspace_id, received_at desc);
create index if not exists ix_rcc_open on public.relay_cv_captures (workspace_id, status)
  where status in ('review', 'unmatched', 'unreadable');

alter table public.relay_cv_captures enable row level security;

drop policy if exists "relay_cv_captures sel" on public.relay_cv_captures;
create policy "relay_cv_captures sel" on public.relay_cv_captures
  for select using (workspace_id in (select public.user_workspaces()));
drop policy if exists "relay_cv_captures upd" on public.relay_cv_captures;
create policy "relay_cv_captures upd" on public.relay_cv_captures
  for update using (workspace_id in (select public.user_workspaces()));

-- Live updates for the popup.
do $$ begin
  alter publication supabase_realtime add table public.relay_cv_captures;
exception when duplicate_object then null; end $$;
alter table public.relay_cv_captures replica identity full;

notify pgrst, 'reload schema';

do $$ begin raise notice '121 DONE: relay_cv_captures ready.'; end $$;
