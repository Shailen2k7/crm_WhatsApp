-- =============================================================================
-- 107 — REMOVE THE PLACEHOLDER ROWS FROM API TESTING
-- -----------------------------------------------------------------------------
-- While testing the template send I called Interakt directly with curl. Those
-- messages came back through the STATUS webhook, and because Migrizo had never
-- created a row for them it recorded a placeholder: "[template sent from
-- Interakt]". They are test noise, not client history.
--
-- Only rows whose body is exactly that placeholder are removed. No real
-- message can match, because Migrizo never writes that text for a message it
-- sent itself.
--
-- Safe to run twice.
-- =============================================================================

delete from public.relay_messages
 where body in ('[template sent from Interakt]', '[sent from Interakt]');

do $$
declare n int;
begin
  select count(*) into n from public.relay_messages
   where body in ('[template sent from Interakt]', '[sent from Interakt]');
  raise notice '107 DONE: % placeholder rows remaining (should be 0).', n;
end $$;
