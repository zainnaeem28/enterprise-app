-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for the flow tables (ARCHITECTURE 21.4, 22.8;
-- SHARED-BOUNDARIES 6.2, 6.3; ticket BE-13). Templates: T-PAT-APPT, T-STAFF (written out, the outer column qualified, SEC03-F01),
-- T-SYS. Every policy names its roles (M-2). The tables stay owned by app_owner; FORCE makes ownership grant nothing.
--
-- Who may take which STEP is the triggers' business (1301); a policy decides which rows a caller reaches.
--   * check_in: the desk (staff) and the patient's own QR check-in insert; nobody updates anything but the merge (patient_id).
--   * queue_entry: staff read and move it. The patient's QR check-in inserts the row in the same transaction (stage 'waiting', own
--     patient only); a patient never reads it back. This is the one addition to 22.8's "T-STAFF, T-SYS" and is insert-only.
--   * waitlist_entry, waitlist_offer: the patient (and proxy) and staff; the offer job (organisation scope) moves entry and offer
--     states and inserts offers for the one patient of a patients-scope job; a patients-scope job also re-points (the merge).
--   * no_show_flag: written by the organisation-scope no-show sweep, read by staff of the location.

ALTER TABLE scheduling.check_in ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.check_in FORCE  ROW LEVEL SECURITY;
ALTER TABLE scheduling.queue_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.queue_entry FORCE  ROW LEVEL SECURITY;
ALTER TABLE scheduling.waitlist_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.waitlist_entry FORCE  ROW LEVEL SECURITY;
ALTER TABLE scheduling.waitlist_offer ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.waitlist_offer FORCE  ROW LEVEL SECURITY;
ALTER TABLE scheduling.no_show_flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.no_show_flag FORCE  ROW LEVEL SECURITY;

CREATE POLICY check_in_patient_select ON scheduling.check_in
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND check_in.patient_id = ANY (kernel.uuids('app.patient_ids')));
CREATE POLICY check_in_staff_select ON scheduling.check_in
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = check_in.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR check_in.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY check_in_system_select ON scheduling.check_in
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND check_in.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY check_in_patient_insert ON scheduling.check_in
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND check_in.patient_id = ANY (kernel.uuids('app.patient_ids')) AND method = 'qr' AND by_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY check_in_staff_insert ON scheduling.check_in
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = check_in.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR check_in.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND method = 'desk' AND location_id = ANY (kernel.uuids('app.location_ids')) AND by_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY check_in_system_merge_update ON scheduling.check_in
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND check_in.patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND check_in.patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY queue_staff_select ON scheduling.queue_entry
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = queue_entry.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR queue_entry.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY queue_system_select ON scheduling.queue_entry
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND queue_entry.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY queue_staff_insert ON scheduling.queue_entry
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = queue_entry.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR queue_entry.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND location_id = ANY (kernel.uuids('app.location_ids')) AND stage = 'waiting' AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY queue_patient_insert ON scheduling.queue_entry
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND queue_entry.patient_id = ANY (kernel.uuids('app.patient_ids')) AND stage = 'waiting' AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY queue_staff_update ON scheduling.queue_entry
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = queue_entry.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR queue_entry.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND location_id = ANY (kernel.uuids('app.location_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = queue_entry.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR queue_entry.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND location_id = ANY (kernel.uuids('app.location_ids')));
CREATE POLICY queue_system_merge_update ON scheduling.queue_entry
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND queue_entry.patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND queue_entry.patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY waitlist_entry_patient_select ON scheduling.waitlist_entry
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND waitlist_entry.patient_id = ANY (kernel.uuids('app.patient_ids')));
CREATE POLICY waitlist_entry_staff_select ON scheduling.waitlist_entry
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = waitlist_entry.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR waitlist_entry.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY waitlist_entry_system_select ON scheduling.waitlist_entry
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND waitlist_entry.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY waitlist_entry_patient_insert ON scheduling.waitlist_entry
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND waitlist_entry.patient_id = ANY (kernel.uuids('app.patient_ids')) AND status = 'active' AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY waitlist_entry_staff_insert ON scheduling.waitlist_entry
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = waitlist_entry.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR waitlist_entry.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND status = 'active' AND (location_id IS NULL OR location_id = ANY (kernel.uuids('app.location_ids'))) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY waitlist_entry_patient_update ON scheduling.waitlist_entry
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND waitlist_entry.patient_id = ANY (kernel.uuids('app.patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND waitlist_entry.patient_id = ANY (kernel.uuids('app.patient_ids')) AND ((status = 'cancelled' AND cancel_reason = 'patient') OR status IN ('active', 'fulfilled')));
CREATE POLICY waitlist_entry_staff_update ON scheduling.waitlist_entry
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = waitlist_entry.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR waitlist_entry.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = waitlist_entry.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR waitlist_entry.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND status = 'cancelled' AND cancel_reason = 'staff');
CREATE POLICY waitlist_entry_system_update ON scheduling.waitlist_entry
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND waitlist_entry.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND waitlist_entry.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY waitlist_offer_patient_select ON scheduling.waitlist_offer
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND waitlist_offer.patient_id = ANY (kernel.uuids('app.patient_ids')));
CREATE POLICY waitlist_offer_staff_select ON scheduling.waitlist_offer
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = waitlist_offer.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR waitlist_offer.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY waitlist_offer_system_select ON scheduling.waitlist_offer
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND waitlist_offer.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY waitlist_offer_system_insert ON scheduling.waitlist_offer
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND waitlist_offer.patient_id = ANY (kernel.uuids('app.job_patient_ids')) AND status = 'offered');
CREATE POLICY waitlist_offer_patient_update ON scheduling.waitlist_offer
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND waitlist_offer.patient_id = ANY (kernel.uuids('app.patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND waitlist_offer.patient_id = ANY (kernel.uuids('app.patient_ids')));
CREATE POLICY waitlist_offer_system_update ON scheduling.waitlist_offer
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND waitlist_offer.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND waitlist_offer.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY no_show_flag_staff_select ON scheduling.no_show_flag
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND location_id = ANY (kernel.uuids('app.location_ids')));
CREATE POLICY no_show_flag_system_select ON scheduling.no_show_flag
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY no_show_flag_system_insert ON scheduling.no_show_flag
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- Grants -------------------------------------------------------------------------------------------------------------
REVOKE ALL ON scheduling.check_in, scheduling.queue_entry, scheduling.waitlist_entry, scheduling.waitlist_offer, scheduling.no_show_flag FROM PUBLIC;

GRANT SELECT ON scheduling.check_in, scheduling.queue_entry, scheduling.waitlist_entry, scheduling.waitlist_offer, scheduling.no_show_flag
  TO app_api, app_worker;

GRANT INSERT (id, organisation_id, patient_id, location_id, method, by_principal_id, previsit_status, created_by) ON scheduling.check_in TO app_api;
GRANT INSERT (id, organisation_id, patient_id, location_id, stage, created_by) ON scheduling.queue_entry TO app_api;
GRANT UPDATE (stage, assigned_clinician_principal_id, room_id, triage_category) ON scheduling.queue_entry TO app_api;
GRANT INSERT (id, organisation_id, patient_id, service_id, location_id, clinician_principal_id, "window", status, created_by) ON scheduling.waitlist_entry TO app_api;
GRANT UPDATE (status, cancel_reason) ON scheduling.waitlist_entry TO app_api;
GRANT UPDATE (status, decided_at) ON scheduling.waitlist_offer TO app_api;

-- app_worker: the merge participant re-points (patients-scope job, the job's exact IDs, SBR-03); the offer job inserts offers and
-- moves entries and offers; the no-show sweep inserts flags.
GRANT UPDATE (patient_id) ON scheduling.check_in, scheduling.queue_entry TO app_worker;
GRANT UPDATE (patient_id, status, cancel_reason) ON scheduling.waitlist_entry TO app_worker;
GRANT INSERT (id, organisation_id, waitlist_entry_id, patient_id, occupancy_id, status, expires_at) ON scheduling.waitlist_offer TO app_worker;
GRANT UPDATE (patient_id, status, decided_at) ON scheduling.waitlist_offer TO app_worker;
GRANT INSERT (reservation_id, organisation_id, location_id) ON scheduling.no_show_flag TO app_worker;

