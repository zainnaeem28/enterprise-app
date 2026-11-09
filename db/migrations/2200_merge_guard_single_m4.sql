-- migration-class: expand
-- INT03-F03 (HEAAA-312), HEAAA-310 ruling Part A (document ruling rev d9504db5-1908-43fb-8226-82f8b923fddf), ARCHITECTURE A-2/A-3 / SHARED-BOUNDARIES SB-A1/SB-A2.
-- One merge write guard for every M4 table: patient.guard_open_patient is attached to the 18 tables that carried a module copy
-- (clinical chart, front door and notes; privacy; messaging). Trigger names are kept so the BEFORE-trigger order is unchanged.
-- The attach runs as an owner step (21.2 point 5): the grant to app_owner exists only between the first and the last step, and
-- the runner refuses the file if it is still there at commit. The copy functions are dropped by 2201 (contract).

-- 2201 drops the copy functions as their owner, which needs USAGE on their schema; 2202 takes it back.
GRANT USAGE ON SCHEMA clinical, privacy TO patient_scope_owner;

SET LOCAL ROLE patient_scope_owner;
GRANT EXECUTE ON FUNCTION patient.guard_open_patient() TO app_owner;
RESET ROLE;

DROP TRIGGER problem_guard_open ON clinical.problem;
DROP TRIGGER allergy_guard_open ON clinical.allergy;
DROP TRIGGER medication_guard_open ON clinical.medication_statement;
DROP TRIGGER vital_sign_guard_open ON clinical.vital_sign;
DROP TRIGGER questionnaire_response_guard_open ON clinical.questionnaire_response;
DROP TRIGGER triage_assessment_guard_open ON clinical.triage_assessment;
DROP TRIGGER referral_guard_open ON clinical.referral;
DROP TRIGGER consent_exception_guard_open ON clinical.consent_exception;
DROP TRIGGER follow_up_guard_open ON clinical.follow_up;
DROP TRIGGER encounter_guard_open ON clinical.encounter;
DROP TRIGGER note_guard_open ON clinical.note;
DROP TRIGGER note_cosign_guard_open ON clinical.note_cosign;
DROP TRIGGER note_addendum_guard_open ON clinical.note_addendum;
DROP TRIGGER request_guard_open ON privacy.request;
DROP TRIGGER export_package_guard_open ON privacy.export_package;
DROP TRIGGER thread_guard_open ON messaging.thread;
DROP TRIGGER message_guard_open ON messaging.message;
DROP TRIGGER task_guard_open ON messaging.task;

CREATE TRIGGER problem_guard_open BEFORE INSERT OR UPDATE ON clinical.problem FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER allergy_guard_open BEFORE INSERT OR UPDATE ON clinical.allergy FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER medication_guard_open BEFORE INSERT OR UPDATE ON clinical.medication_statement FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER vital_sign_guard_open BEFORE INSERT OR UPDATE ON clinical.vital_sign FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER questionnaire_response_guard_open BEFORE INSERT OR UPDATE ON clinical.questionnaire_response FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER triage_assessment_guard_open BEFORE INSERT OR UPDATE ON clinical.triage_assessment FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER referral_guard_open BEFORE INSERT OR UPDATE ON clinical.referral FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER consent_exception_guard_open BEFORE INSERT OR UPDATE ON clinical.consent_exception FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER follow_up_guard_open BEFORE INSERT OR UPDATE ON clinical.follow_up FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER encounter_guard_open BEFORE INSERT OR UPDATE ON clinical.encounter FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER note_guard_open BEFORE INSERT OR UPDATE ON clinical.note FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER note_cosign_guard_open BEFORE INSERT OR UPDATE ON clinical.note_cosign FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER note_addendum_guard_open BEFORE INSERT OR UPDATE ON clinical.note_addendum FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER request_guard_open BEFORE INSERT OR UPDATE ON privacy.request FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER export_package_guard_open BEFORE INSERT OR UPDATE ON privacy.export_package FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER thread_guard_open BEFORE INSERT OR UPDATE ON messaging.thread FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER message_guard_open BEFORE INSERT OR UPDATE ON messaging.message FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER task_guard_open BEFORE INSERT OR UPDATE ON messaging.task FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();

SET LOCAL ROLE patient_scope_owner;
REVOKE EXECUTE ON FUNCTION patient.guard_open_patient() FROM app_owner;
RESET ROLE;
