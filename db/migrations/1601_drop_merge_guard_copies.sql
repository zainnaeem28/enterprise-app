-- migration-class: contract
-- contract-approval: HEAAA-190 ruling (document ruling rev e3070476), ARCHITECTURE amendment A-3 / SHARED-BOUNDARIES SB-A2 at commit 0dfd892
-- INT02-F02 (HEAAA-186). Drops the five refused copies of the merge write guard. 1600 has already moved every trigger to
-- patient.guard_open_patient; no trigger or application code calls these functions (trigger functions cannot be called).
-- Dropping a function a function-owner role owns needs that role: an owner step, DROP FUNCTION without CASCADE.

SET LOCAL ROLE patient_scope_owner;
DROP FUNCTION documents.guard_open_patient();
DROP FUNCTION telehealth.guard_open_patient();
DROP FUNCTION scheduling.flow_guard_open_patient();
RESET ROLE;

SET LOCAL ROLE scheduling_booking_owner;
DROP FUNCTION scheduling.guard_open_patient();
DROP FUNCTION scheduling.guard_open_patient_at_commit();
RESET ROLE;
