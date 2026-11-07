-- migration-class: expand
-- INT02-F02 (HEAAA-186), ruling HEAAA-190, ARCHITECTURE amendment A-3 / SHARED-BOUNDARIES SB-A2.
-- One merge write guard for every module (A-2): patient.guard_open_patient is attached to the 12 tables that carried a module
-- copy, to scheduling.slot_reservation (which carried the unlocked scheduling copy and the commit re-check) and to the two
-- notifications.staff_alert tables that had no guard at all. The attach runs as an owner step (21.2 point 5): the grant to
-- app_owner exists only between the first step and the last, and the runner refuses the file if it is still there at commit.
-- The copy functions are dropped by 1601 (contract).

-- 1601 drops the copy functions as their owner, which needs USAGE on their schema; 1602 takes it back.
GRANT USAGE ON SCHEMA documents, telehealth TO patient_scope_owner;

SET LOCAL ROLE patient_scope_owner;
GRANT EXECUTE ON FUNCTION patient.guard_open_patient() TO app_owner;
RESET ROLE;

DROP TRIGGER slot_reservation_guard_open ON scheduling.slot_reservation;
DROP TRIGGER slot_reservation_guard_open_commit ON scheduling.slot_reservation;
DROP TRIGGER document_guard_open ON documents.document;
DROP TRIGGER document_version_guard_open ON documents.document_version;
DROP TRIGGER legal_hold_guard_open ON documents.legal_hold;
DROP TRIGGER deletion_request_guard_open ON documents.deletion_request;
DROP TRIGGER check_in_guard_open ON scheduling.check_in;
DROP TRIGGER queue_entry_guard_open ON scheduling.queue_entry;
DROP TRIGGER waitlist_entry_guard_open ON scheduling.waitlist_entry;
DROP TRIGGER waitlist_offer_guard_open ON scheduling.waitlist_offer;
DROP TRIGGER video_session_guard_open ON telehealth.video_session;
DROP TRIGGER participant_guard_open ON telehealth.participant;
DROP TRIGGER join_token_guard_open ON telehealth.join_token;
DROP TRIGGER location_confirmation_guard_open ON telehealth.location_confirmation;

CREATE TRIGGER slot_reservation_guard_open BEFORE INSERT OR UPDATE ON scheduling.slot_reservation FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER document_guard_open BEFORE INSERT OR UPDATE ON documents.document FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER document_version_guard_open BEFORE INSERT OR UPDATE ON documents.document_version FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER legal_hold_guard_open BEFORE INSERT OR UPDATE ON documents.legal_hold FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER deletion_request_guard_open BEFORE INSERT OR UPDATE ON documents.deletion_request FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER check_in_guard_open BEFORE INSERT OR UPDATE ON scheduling.check_in FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER queue_entry_guard_open BEFORE INSERT OR UPDATE ON scheduling.queue_entry FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER waitlist_entry_guard_open BEFORE INSERT OR UPDATE ON scheduling.waitlist_entry FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER waitlist_offer_guard_open BEFORE INSERT OR UPDATE ON scheduling.waitlist_offer FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER video_session_guard_open BEFORE INSERT OR UPDATE ON telehealth.video_session FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER participant_guard_open BEFORE INSERT OR UPDATE ON telehealth.participant FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER join_token_guard_open BEFORE INSERT OR UPDATE ON telehealth.join_token FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER location_confirmation_guard_open BEFORE INSERT OR UPDATE ON telehealth.location_confirmation FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER staff_alert_guard_open BEFORE INSERT OR UPDATE ON notifications.staff_alert FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER staff_alert_event_guard_open BEFORE INSERT OR UPDATE ON notifications.staff_alert_event FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();

-- The scheduling copy read patient.patient as scheduling_booking_owner (0902). Nothing else of that role reads it (checked by
-- grep over db/migrations and the db-foundation suite), so the policy and the grants go with the copy (A-2).
DROP POLICY patient_booking_guard_select ON patient.patient;
REVOKE SELECT (id, organisation_id, status) ON patient.patient FROM scheduling_booking_owner;
REVOKE USAGE ON SCHEMA patient FROM scheduling_booking_owner;

SET LOCAL ROLE patient_scope_owner;
REVOKE EXECUTE ON FUNCTION patient.guard_open_patient() FROM app_owner;
RESET ROLE;
