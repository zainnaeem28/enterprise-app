-- migration-class: expand
-- SEC03-F11 contract half (HEAAA-731; HEAAA-722 decision-log D1/D1a/D3; docs/security/SEC03-F11-worker-merge-grants-hardening-spec.md
-- section 3 item 4). Migration 2503 (released as r207) added the patient_scope_owner / scheduling_booking_owner merge_repoint_* functions
-- and the code that calls them. This file takes the direct re-pointing writes away from app_worker: the worker UPDATE/DELETE policies of
-- 0802/0902 are dropped and the matching column / table grants are revoked. SELECT policies stay (the merge executor counts rows).
-- Marked `expand` per D1a (the 1606/2202 precedent): kernel lint does not treat REVOKE / DROP POLICY as destructive and a `contract`
-- file of them fails CONTRACT_MIXED. Safety against N-1 comes from the ordering: this file ships only in a release after r207, so every
-- instance already runs the code that calls the functions. No SET lock_timeout here: the runner sets it per migration.
--
-- Down-note (forward-only): to go back, restore the grants and policies of 0802 lines 60-114 and 0902 lines 73-76 and 91. The TypeScript
-- participants calling the 2503 functions keep working either way.

DROP POLICY contact_system_merge_update ON patient.patient_contact;
DROP POLICY coverage_system_merge_update ON patient.insurance_coverage;
DROP POLICY consent_system_merge_update ON patient.consent;
DROP POLICY preference_system_merge_update ON patient.communication_preference;
DROP POLICY preference_system_merge_delete ON patient.communication_preference;
DROP POLICY careteam_system_merge_update ON patient.care_team_member;
DROP POLICY flag_system_merge_update ON patient.duplicate_flag;
DROP POLICY reservation_system_merge_update ON scheduling.slot_reservation;

REVOKE UPDATE (patient_id) ON patient.patient_contact, patient.insurance_coverage, patient.communication_preference FROM app_worker;
REVOKE UPDATE (patient_id, status, reason) ON patient.consent FROM app_worker;
REVOKE DELETE ON patient.communication_preference FROM app_worker;
REVOKE UPDATE (patient_id, to_date, end_reason) ON patient.care_team_member FROM app_worker;
REVOKE UPDATE (patient_id, candidate_patient_id, status, resolved_reason) ON patient.duplicate_flag FROM app_worker;
REVOKE UPDATE (patient_id) ON scheduling.slot_reservation FROM app_worker;
