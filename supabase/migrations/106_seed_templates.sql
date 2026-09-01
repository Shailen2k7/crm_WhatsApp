-- =============================================================================
-- 106 — SEED THE APPROVED TEMPLATES  (t1, t2, t3, t4)
-- -----------------------------------------------------------------------------
-- These are the templates already APPROVED on the Interakt account, read from
-- the Interakt dashboard: t1, t2, t3, t4 — all English (en). c1 is excluded
-- because Meta still has it Pending, and sending a pending template fails.
--
-- BODY IS DELIBERATELY LEFT EMPTY. Sending a template needs only its name,
-- language and variable values; the body is a preview convenience. Paste each
-- approved body into Templates → edit whenever convenient — sending works
-- without it from the moment this runs.
--
-- Idempotent: re-running leaves existing rows (and any body text you have
-- added) untouched.
-- =============================================================================

insert into public.relay_templates (workspace_id, name, language, category, body, variable_count, sort_order)
select w.id, t.name, 'en', t.category, '', 0, t.ord
  from (select id from public.workspaces order by created_at limit 1) w
 cross join (values
   ('t1', 'MARKETING', 1),
   ('t2', 'UTILITY',   2),
   ('t3', 'MARKETING', 3),
   ('t4', 'UTILITY',   4)
 ) as t(name, category, ord)
on conflict (workspace_id, name, language) do nothing;

do $$
declare n int;
begin
  select count(*) into n from public.relay_templates;
  raise notice '106 DONE: % template(s) registered.', n;
end $$;
