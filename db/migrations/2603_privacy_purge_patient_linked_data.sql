-- migration-class: expand
-- Retention purge of the patient-linked data outside the clinical record (HEAAA-790 round-1 finding F2; decision HEAAA-880 D-880-1..6;
-- owner ruling 2026-11-11 C, items 1 and 2; ticket HEAAA-789/HEAAA-881). Companion of 2600-2602.
--
-- 2601 purged clinical.*, consents and documents. Everything else that points at a patient stayed for ever. 2601 itself (not released yet, so
-- changed in place: the functions belong to privacy_retention_owner, which app_owner cannot replace) now extends
-- privacy.purge_medical_record so that, when the medical-record retention ends and in the same gated transaction (same job check, same
-- legal-hold and document-retention deferral), the closure's rows in these classes are removed too, children first:
--   scheduling (waitlist offers and entries, queue entries, check-ins, no-show flags, reservations and their occupancy rows), telehealth
--   (join tokens, participants, sessions, location confirmations), messaging (messages, thread participants, threads, tasks),
--   notifications (receipts, read marks, notifications, staff alerts and their events), patient (contacts, insurance, care relationships,
--   care team, duplicate flags, staff scope, merge history, match checks), identity (proxy grants, patient links).
-- The patient-realm sign-in (principal and person) is de-identified when it is linked only to these patients and to nobody else.
-- patient.patient becomes a tombstone (D-880-3): id, organisation, MRN (never issued twice), status 'purged', created_at, purged_at. The
-- audit trail and privacy.* documentation are not touched (they have their own periods); purge_hipaa_documentation deletes the tombstone
-- once no privacy.* row refers to it.
-- A table that carries a patient id and is in neither the purge list nor the exempt list fails the catalog test (D-880-5).
--
-- This file holds what those function bodies need: the rights and policies of the role, the tombstone column and guard, the de-identification
-- guard of the sign-in, and the refusing triggers with the same exemption as in 2601: WHEN (current_user <> 'privacy_retention_owner').
--
-- Down-note (forward-only): to go back, restore the 2601 bodies of purge_medical_record, purge_hipaa_documentation and delete_nonrecord_data,
-- the previous bodies of patient.guard_merged_root and identity.guard_principal, drop the policies and revoke the grants named here,
-- restore the triggers without the WHEN condition, and re-add the NOT NULL constraints and the status check on patient.patient once no
-- row is purged.

-- The tombstone: patient.patient. The column is added here; the relaxed constraints are in 2604 (contract), 2605 (new constraints NOT VALID)
-- and 2606 (validation), as the migration rules require.
ALTER TABLE patient.patient ADD COLUMN purged_at timestamptz;
ALTER TABLE patient.patient ALTER COLUMN given_name DROP NOT NULL;
ALTER TABLE patient.patient ALTER COLUMN family_name DROP NOT NULL;
ALTER TABLE patient.patient ALTER COLUMN date_of_birth DROP NOT NULL;
ALTER TABLE patient.patient ALTER COLUMN state_code DROP NOT NULL;
ALTER TABLE patient.patient ALTER COLUMN preferred_language DROP NOT NULL;

-- Only the retention role sets or clears 'purged' (previous body plus two branches; a purged row accepts no later change).
CREATE OR REPLACE FUNCTION patient.guard_merged_root()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.mrn IS DISTINCT FROM OLD.mrn OR NEW.created_via IS DISTINCT FROM OLD.created_via
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a patient keeps its id, organisation, record number and origin' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status = 'purged' OR NEW.status = 'purged' THEN
    -- D2603: a record is purged (tombstoned) only by the retention role, once, from active or merged.
    IF current_user <> 'privacy_retention_owner' OR OLD.status = 'purged' OR NEW.status <> 'purged' THEN
      RAISE EXCEPTION 'a purged patient is set and changed only by the retention purge' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'merged' THEN
    RAISE EXCEPTION 'patient.merged' USING ERRCODE = 'PM001';
  END IF;
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.merged_into IS DISTINCT FROM OLD.merged_into)
     AND NOT (OLD.status = 'active' AND NEW.status = 'merged' AND NEW.merged_into IS NOT NULL) THEN
    RAISE EXCEPTION 'merged is terminal and is set only by complete_merge' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE POLICY patient_retention_select ON patient.patient FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY patient_retention_update ON patient.patient FOR UPDATE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND id = ANY (kernel.uuids('app.job_patient_ids')) AND status IN ('active', 'merged'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND id = ANY (kernel.uuids('app.job_patient_ids')) AND status = 'purged');
-- The tombstone goes when the HIPAA documentation that refers to it goes (purge_hipaa_documentation, organisation scope).
CREATE POLICY patient_retention_select_tombstone ON patient.patient FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org' AND status = 'purged');
CREATE POLICY patient_retention_delete ON patient.patient FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org' AND status = 'purged');
GRANT SELECT ON patient.patient TO privacy_retention_owner;
GRANT UPDATE (given_name, family_name, middle_name, date_of_birth, sex_at_birth, gender_identity, phone_e164, email, address, state_code,
  preferred_language, photo_document_id, preferred_pharmacy, merged_into, status, purged_at) ON patient.patient TO privacy_retention_owner;
GRANT DELETE ON patient.patient TO privacy_retention_owner;

-- Grants and policies of the retention role for the purged classes ---------------------------------------------------------------
GRANT USAGE ON SCHEMA scheduling, telehealth, messaging, notifications TO privacy_retention_owner;
GRANT SELECT ON scheduling.waitlist_offer,
  scheduling.waitlist_entry,
  scheduling.queue_entry,
  scheduling.check_in,
  scheduling.no_show_flag,
  telehealth.join_token,
  telehealth.participant,
  telehealth.video_session,
  telehealth.location_confirmation,
  scheduling.slot_occupancy,
  scheduling.slot_reservation,
  messaging.message,
  messaging.thread_participant,
  messaging.thread,
  messaging.task,
  notifications.delivery_receipt,
  notifications.in_app_read,
  notifications.notification,
  notifications.staff_alert_event,
  notifications.staff_alert,
  patient.patient_contact,
  patient.insurance_coverage,
  patient.care_relationship,
  patient.care_team_member,
  patient.duplicate_flag,
  patient.staff_scope,
  patient.merge_residue,
  patient.merge_request,
  patient.patient_merge,
  patient.match_check TO privacy_retention_owner;
GRANT DELETE ON scheduling.waitlist_offer,
  scheduling.waitlist_entry,
  scheduling.queue_entry,
  scheduling.check_in,
  scheduling.no_show_flag,
  telehealth.join_token,
  telehealth.participant,
  telehealth.video_session,
  telehealth.location_confirmation,
  scheduling.slot_occupancy,
  scheduling.slot_reservation,
  messaging.message,
  messaging.thread_participant,
  messaging.thread,
  messaging.task,
  notifications.delivery_receipt,
  notifications.in_app_read,
  notifications.notification,
  notifications.staff_alert_event,
  notifications.staff_alert,
  patient.patient_contact,
  patient.insurance_coverage,
  patient.care_relationship,
  patient.care_team_member,
  patient.duplicate_flag,
  patient.staff_scope,
  patient.merge_residue,
  patient.merge_request,
  patient.patient_merge,
  patient.match_check,
  identity.proxy_grant,
  identity.patient_link TO privacy_retention_owner;
GRANT SELECT (id, organisation_id, proxy_principal_id, patient_id) ON identity.proxy_grant TO privacy_retention_owner;
GRANT SELECT ON identity.person TO privacy_retention_owner;
GRANT UPDATE (display_name, status) ON identity.person TO privacy_retention_owner;
GRANT UPDATE (email, subject, last_sign_in_at) ON identity.principal TO privacy_retention_owner;

CREATE POLICY waitlist_offer_retention_select ON scheduling.waitlist_offer FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND (patient_id = ANY (kernel.uuids('app.job_patient_ids')) OR EXISTS (SELECT 1 FROM scheduling.slot_reservation r WHERE r.id = waitlist_offer.occupancy_id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY waitlist_offer_retention_delete ON scheduling.waitlist_offer FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND (patient_id = ANY (kernel.uuids('app.job_patient_ids')) OR EXISTS (SELECT 1 FROM scheduling.slot_reservation r WHERE r.id = waitlist_offer.occupancy_id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY waitlist_entry_retention_select ON scheduling.waitlist_entry FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY waitlist_entry_retention_delete ON scheduling.waitlist_entry FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY queue_entry_retention_select ON scheduling.queue_entry FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY queue_entry_retention_delete ON scheduling.queue_entry FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY check_in_retention_select ON scheduling.check_in FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY check_in_retention_delete ON scheduling.check_in FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY no_show_flag_retention_select ON scheduling.no_show_flag FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND EXISTS (SELECT 1 FROM scheduling.slot_reservation r WHERE r.id = no_show_flag.reservation_id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY no_show_flag_retention_delete ON scheduling.no_show_flag FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND EXISTS (SELECT 1 FROM scheduling.slot_reservation r WHERE r.id = no_show_flag.reservation_id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY join_token_retention_select ON telehealth.join_token FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY join_token_retention_delete ON telehealth.join_token FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY participant_retention_select ON telehealth.participant FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY participant_retention_delete ON telehealth.participant FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY video_session_retention_select ON telehealth.video_session FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY video_session_retention_delete ON telehealth.video_session FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY location_confirmation_retention_select ON telehealth.location_confirmation FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY location_confirmation_retention_delete ON telehealth.location_confirmation FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY slot_occupancy_retention_select ON scheduling.slot_occupancy FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND EXISTS (SELECT 1 FROM scheduling.slot_reservation r WHERE r.id = slot_occupancy.id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY slot_occupancy_retention_delete ON scheduling.slot_occupancy FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND EXISTS (SELECT 1 FROM scheduling.slot_reservation r WHERE r.id = slot_occupancy.id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY slot_reservation_retention_select ON scheduling.slot_reservation FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY slot_reservation_retention_delete ON scheduling.slot_reservation FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY message_retention_select ON messaging.message FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND EXISTS (SELECT 1 FROM messaging.thread t WHERE t.id = message.thread_id AND t.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY message_retention_delete ON messaging.message FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND EXISTS (SELECT 1 FROM messaging.thread t WHERE t.id = message.thread_id AND t.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY thread_participant_retention_select ON messaging.thread_participant FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND EXISTS (SELECT 1 FROM messaging.thread t WHERE t.id = thread_participant.thread_id AND t.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY thread_participant_retention_delete ON messaging.thread_participant FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND EXISTS (SELECT 1 FROM messaging.thread t WHERE t.id = thread_participant.thread_id AND t.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY thread_retention_select ON messaging.thread FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY thread_retention_delete ON messaging.thread FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY task_retention_select ON messaging.task FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY task_retention_delete ON messaging.task FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY delivery_receipt_retention_select ON notifications.delivery_receipt FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND EXISTS (SELECT 1 FROM notifications.notification n WHERE n.id = delivery_receipt.notification_id AND n.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY delivery_receipt_retention_delete ON notifications.delivery_receipt FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND EXISTS (SELECT 1 FROM notifications.notification n WHERE n.id = delivery_receipt.notification_id AND n.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY in_app_read_retention_select ON notifications.in_app_read FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND (patient_id = ANY (kernel.uuids('app.job_patient_ids')) OR EXISTS (SELECT 1 FROM notifications.notification n WHERE n.id = in_app_read.notification_id AND n.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY in_app_read_retention_delete ON notifications.in_app_read FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND (patient_id = ANY (kernel.uuids('app.job_patient_ids')) OR EXISTS (SELECT 1 FROM notifications.notification n WHERE n.id = in_app_read.notification_id AND n.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY notification_retention_select ON notifications.notification FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY notification_retention_delete ON notifications.notification FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY staff_alert_event_retention_select ON notifications.staff_alert_event FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND (patient_id = ANY (kernel.uuids('app.job_patient_ids')) OR EXISTS (SELECT 1 FROM notifications.staff_alert a WHERE a.id = staff_alert_event.alert_id AND a.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY staff_alert_event_retention_delete ON notifications.staff_alert_event FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND (patient_id = ANY (kernel.uuids('app.job_patient_ids')) OR EXISTS (SELECT 1 FROM notifications.staff_alert a WHERE a.id = staff_alert_event.alert_id AND a.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY staff_alert_retention_select ON notifications.staff_alert FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY staff_alert_retention_delete ON notifications.staff_alert FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY patient_contact_retention_select ON patient.patient_contact FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY patient_contact_retention_delete ON patient.patient_contact FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY insurance_coverage_retention_select ON patient.insurance_coverage FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY insurance_coverage_retention_delete ON patient.insurance_coverage FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY care_relationship_retention_select ON patient.care_relationship FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY care_relationship_retention_delete ON patient.care_relationship FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY care_team_member_retention_select ON patient.care_team_member FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY care_team_member_retention_delete ON patient.care_team_member FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY duplicate_flag_retention_select ON patient.duplicate_flag FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND (patient_id = ANY (kernel.uuids('app.job_patient_ids')) OR candidate_patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY duplicate_flag_retention_delete ON patient.duplicate_flag FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND (patient_id = ANY (kernel.uuids('app.job_patient_ids')) OR candidate_patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY staff_scope_retention_select ON patient.staff_scope FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY staff_scope_retention_delete ON patient.staff_scope FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY merge_residue_retention_select ON patient.merge_residue FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND (survivor_id = ANY (kernel.uuids('app.job_patient_ids')) OR merged_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY merge_residue_retention_delete ON patient.merge_residue FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND (survivor_id = ANY (kernel.uuids('app.job_patient_ids')) OR merged_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY merge_request_retention_select ON patient.merge_request FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND (survivor_id = ANY (kernel.uuids('app.job_patient_ids')) OR merged_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY merge_request_retention_delete ON patient.merge_request FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND (survivor_id = ANY (kernel.uuids('app.job_patient_ids')) OR merged_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY patient_merge_retention_delete ON patient.patient_merge FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND (merged_id = ANY (kernel.uuids('app.job_patient_ids')) OR direct_survivor_id = ANY (kernel.uuids('app.job_patient_ids')) OR final_survivor_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY match_check_retention_select ON patient.match_check FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND candidate_patient_ids && kernel.uuids('app.job_patient_ids'));
CREATE POLICY match_check_retention_delete ON patient.match_check FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND candidate_patient_ids && kernel.uuids('app.job_patient_ids'));
-- Read: who is a proxy for whom in the organisation (only id, proxy and patient columns are granted); delete: this closure's grants.
CREATE POLICY proxy_grant_retention_select ON identity.proxy_grant FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients');
CREATE POLICY proxy_grant_retention_delete ON identity.proxy_grant FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY patient_link_retention_delete ON identity.patient_link FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));

-- To leave a sign-in alone that is also linked to another patient, the function must see all links of the organisation (it returns none of
-- them); principals are read only by id, person, realm and status for the same reason. Both reads happen only inside the gated definer function.
ALTER POLICY patient_link_retention_select ON identity.patient_link USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients');
REVOKE SELECT ON identity.principal FROM privacy_retention_owner;
GRANT SELECT (id, organisation_id, person_id, realm, status) ON identity.principal TO privacy_retention_owner;
CREATE POLICY principal_retention_org_select ON identity.principal FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients');
CREATE POLICY person_retention_select ON identity.person FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM identity.principal q WHERE q.person_id = person.id AND q.realm = 'patient_pool'
                   AND EXISTS (SELECT 1 FROM identity.patient_link l WHERE l.principal_id = q.id AND l.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY person_retention_update ON identity.person FOR UPDATE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM identity.principal q WHERE q.person_id = person.id AND q.realm = 'patient_pool'
                   AND EXISTS (SELECT 1 FROM identity.patient_link l WHERE l.principal_id = q.id AND l.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND status = 'disabled');

-- A de-identified sign-in: only the retention role may change the subject and e-mail of a bound principal (previous body plus one branch).
CREATE OR REPLACE FUNCTION identity.guard_principal()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.realm IS DISTINCT FROM OLD.realm OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id THEN
    RAISE EXCEPTION 'a principal keeps its identity, person, realm and organisation' USING ERRCODE = 'PS001';
  END IF;
  IF current_user = 'privacy_retention_owner' THEN
    -- D2603: the retention purge de-identifies a disabled patient-realm principal (subject replaced, e-mail removed).
    IF OLD.realm <> 'patient_pool' OR NEW.status <> 'disabled' THEN
      RAISE EXCEPTION 'the retention purge de-identifies only a disabled patient sign-in' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.subject IS NOT NULL AND NEW.subject IS DISTINCT FROM OLD.subject THEN
    RAISE EXCEPTION 'a bound principal subject never changes' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.subject IS NOT NULL AND NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'the email of a bound principal never changes' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$function$;

-- The refusing triggers: one extra condition, so only the retention role passes.
CREATE OR REPLACE TRIGGER merge_residue_append_only BEFORE DELETE OR UPDATE ON patient.merge_residue FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION patient.refuse_residue_change();
CREATE OR REPLACE TRIGGER no_show_flag_insert_only BEFORE DELETE OR UPDATE ON scheduling.no_show_flag FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION scheduling.flow_refuse_change();
CREATE OR REPLACE TRIGGER location_confirmation_insert_only BEFORE DELETE OR UPDATE ON telehealth.location_confirmation FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION telehealth.refuse_change();
CREATE OR REPLACE TRIGGER thread_no_delete BEFORE DELETE ON messaging.thread FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION messaging.refuse_change();
CREATE OR REPLACE TRIGGER message_append_only BEFORE DELETE OR UPDATE ON messaging.message FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION messaging.refuse_change();
CREATE OR REPLACE TRIGGER task_no_delete BEFORE DELETE ON messaging.task FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION messaging.refuse_change();
CREATE OR REPLACE TRIGGER thread_participant_guard BEFORE INSERT OR DELETE OR UPDATE ON messaging.thread_participant FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION messaging.guard_participant();
CREATE OR REPLACE TRIGGER notification_no_delete BEFORE DELETE ON notifications.notification FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION notifications.refuse_delete();
CREATE OR REPLACE TRIGGER delivery_receipt_append_only BEFORE DELETE OR UPDATE ON notifications.delivery_receipt FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION notifications.refuse_change();
CREATE OR REPLACE TRIGGER in_app_read_append_only BEFORE DELETE OR UPDATE ON notifications.in_app_read FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION notifications.refuse_change();
CREATE OR REPLACE TRIGGER staff_alert_no_delete BEFORE DELETE ON notifications.staff_alert FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION notifications.refuse_delete();
CREATE OR REPLACE TRIGGER staff_alert_event_append_only BEFORE DELETE OR UPDATE ON notifications.staff_alert_event FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION notifications.refuse_change();

-- The three definer functions (delete_nonrecord_data, purge_medical_record, purge_hipaa_documentation) are changed in 2601 itself: they are owned by
-- privacy_retention_owner, which app_owner cannot replace, and 2600-2602 are not released yet.
