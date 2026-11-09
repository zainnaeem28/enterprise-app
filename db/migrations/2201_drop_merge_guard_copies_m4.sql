-- migration-class: contract
-- contract-approval: HEAAA-310 ruling (document ruling rev d9504db5-1908-43fb-8226-82f8b923fddf), ARCHITECTURE A-2/A-3 / SHARED-BOUNDARIES SB-A1/SB-A2
-- INT03-F03 (HEAAA-312). Drops the five refused M4 copies of the merge write guard. 2200 has already moved every trigger to
-- patient.guard_open_patient; no trigger or application code calls these functions (trigger functions cannot be called).
-- Dropping a function a function-owner role owns needs that role: an owner step, DROP FUNCTION without CASCADE. A dependency
-- error here means 2200 missed a trigger; it is a failure, not a reason to add CASCADE.

SET LOCAL ROLE patient_scope_owner;
DROP FUNCTION clinical.guard_open_patient();
DROP FUNCTION clinical.frontdoor_guard_open_patient();
DROP FUNCTION clinical.notes_guard_open_patient();
DROP FUNCTION privacy.guard_open_patient();
DROP FUNCTION messaging.guard_open_patient();
RESET ROLE;
