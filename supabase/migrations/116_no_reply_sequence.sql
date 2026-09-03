-- =============================================================================
-- 116 — THE NO-REPLY CHASE  (T2 -> T3 -> T4 for people who never answered)
-- -----------------------------------------------------------------------------
-- A second follow-up sequence, alongside the C1–C8 backlog machine:
--
--   * trigger_mode 'no_reply' — enrols people who RECEIVED the new-lead first
--     message and have not replied since, instead of walking the old backlog.
--   * gaps move from days to HOURS (gap_hours), because "T2 four hours after
--     the first message" cannot be said in whole days. Existing day gaps are
--     converted (3 days -> 72 hours); gap_days stays behind, unused, so a
--     half-deployed build cannot break.
--   * industries text[] — send only to chosen categories (tech, research,
--     art…), or everyone when null. '(none)' means leads with no industry set.
--
-- Safe to run twice.
-- =============================================================================

alter table public.relay_sequences
  add column if not exists trigger_mode text not null default 'backlog';
alter table public.relay_sequences
  add column if not exists industries text[];   -- null = all industries

alter table public.relay_sequence_steps
  add column if not exists gap_hours int;
update public.relay_sequence_steps
   set gap_hours = gap_days * 24
 where gap_hours is null;

-- ── seed the chase, DISABLED, with the asked-for ladder ──────────────────────
do $$
declare ws uuid; seq uuid;
begin
  select id into ws from public.workspaces order by created_at limit 1;
  if ws is null then return; end if;
  if exists (select 1 from public.relay_sequences
              where workspace_id = ws and trigger_mode = 'no_reply') then return; end if;

  insert into public.relay_sequences
    (workspace_id, name, audience, status, trigger_mode, hours_enabled, send_start_hour, send_end_hour)
  values (ws, 'No-reply chase', 'both', 'draft', 'no_reply', true, 9, 21)
  returning id into seq;

  -- T2 four hours after the first message; T3 eight hours after T2;
  -- T4 sixteen hours after T3. All editable on the page.
  insert into public.relay_sequence_steps
    (sequence_id, workspace_id, step_no, template_name, gap_days, gap_hours) values
    (seq, ws, 1, 't2', 0,  4),
    (seq, ws, 2, 't3', 0,  8),
    (seq, ws, 3, 't4', 1, 16);

  -- One wide stage: the real limiter is how many first messages went out.
  insert into public.relay_sequence_ramp
    (sequence_id, workspace_id, stage_no, per_day, duration_days)
  values (seq, ws, 1, 500, null);
end $$;

do $$ begin raise notice '116 DONE: no-reply chase seeded (disabled).'; end $$;
