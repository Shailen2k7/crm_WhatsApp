-- =============================================================================
-- 103 — REMOVE THE DIAGNOSTIC TEST CHATS
-- -----------------------------------------------------------------------------
-- These three conversations were created by me while proving the webhook
-- worked. They are not real people. This deletes them and their messages.
--
-- Storage note: those test messages carried no files, so nothing is orphaned
-- in the bucket. Deleting a REAL chat should be done from the app (⋯ → Delete
-- entire chat), which clears its files too.
--
-- Safe to run twice.
-- =============================================================================

delete from public.relay_conversations
 where phone_e164 in ('+919000000001', '+919000000002', '+919000000003');

-- Also clear the diagnostic rows from the webhook log, so Settings shows only
-- real Interakt traffic from here on.
delete from public.relay_webhook_log
 where phone in ('919000000001', '919000000002', '919000000003')
    or body_preview like '%relay-diag-test%'
    or body_preview like '%prod-hmac-%'
    or body_preview like '%hmac-test-%';

do $$
declare n int;
begin
  select count(*) into n from public.relay_conversations
   where phone_e164 like '+91900000000%';
  raise notice '103 DONE: % test conversations remaining (should be 0).', n;
end $$;
