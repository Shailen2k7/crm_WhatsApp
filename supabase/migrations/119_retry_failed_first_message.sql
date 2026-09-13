-- =============================================================================
-- 119 — A FAILED FIRST MESSAGE MUST NOT BE FINAL
-- -----------------------------------------------------------------------------
-- relay_automation_sent doubles as the "already handled" list, and it was read
-- without looking at whether the send actually worked. So a lead whose first
-- message was rejected by WhatsApp was marked handled for ever and never heard
-- from us again — silently.
--
-- One counter fixes it: the rule now retries a failed first message until
-- three attempts have been made, then gives up and leaves the reason behind.
--
-- Safe to run twice.
-- =============================================================================

alter table public.relay_automation_sent
  add column if not exists attempts int not null default 1;

-- Rows already on the books count as one attempt each, which is what they were.
update public.relay_automation_sent set attempts = 1 where attempts is null or attempts < 1;

-- ═══ CHECK ═══ how many people are waiting on a retry ════════════════════════
select count(*) filter (where ok)                        as delivered,
       count(*) filter (where not ok and attempts < 3)   as will_be_retried,
       count(*) filter (where not ok and attempts >= 3)  as given_up
  from public.relay_automation_sent
 where automation_key = 'new_lead_first';
