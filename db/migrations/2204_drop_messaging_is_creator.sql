-- migration-class: contract
-- contract-approval: HEAAA-310 ruling (document ruling rev d9504db5-1908-43fb-8226-82f8b923fddf), HEAAA-332 decision-log rev bf854c3a-fb72-4912-8c87-8c017b867d9c (amendment A-4 / SHARED-BOUNDARIES SB-A3)
-- INT03-F03 Part B (HEAAA-334). Drops the refused definer messaging.is_creator(uuid). 2203 has already replaced its only two uses
-- (participant_owner_insert, participant_owner_delete); no application code calls it. The function is owned by patient_scope_owner, so this is an
-- owner step (21.2 point 5), DROP FUNCTION WITHOUT CASCADE. A dependency error here means a policy still uses it: that is a failure, never a
-- reason to add CASCADE or to keep the function.

SET LOCAL ROLE patient_scope_owner;
DROP FUNCTION messaging.is_creator(uuid);
RESET ROLE;
