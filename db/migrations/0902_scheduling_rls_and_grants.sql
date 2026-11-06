-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for the booking tables (ARCHITECTURE 21.4, 22.8;
-- SHARED-BOUNDARIES 6.2, 6.3, 6.5; ticket BE-11). Templates: T-PAT-APPT, T-STAFF (written out), T-ADMIN-BTG, T-SYS. Every policy
-- names its roles (M-2).
--
-- slot_occupancy is PHI-free and readable by organisation for the audiences patient, staff and system (6.5), so the booking
-- transaction of any caller sees every active hold and appointment of a doctor or room. Only the scheduling.occupy and
-- scheduling.set_status definer functions (owner scheduling_booking_owner) write it; app_api and app_worker have SELECT only.
-- As with the patient tables (0702), the tables stay owned by app_owner so later tickets can alter them; FORCE ROW LEVEL SECURITY
-- makes ownership grant nothing, and the functions themselves are owned by the function-owner role (0903).

ALTER TABLE scheduling.slot_occupancy ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.slot_occupancy FORCE  ROW LEVEL SECURITY;
ALTER TABLE scheduling.slot_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.slot_reservation FORCE  ROW LEVEL SECURITY;

-- slot_occupancy ---------------------------------------------------------------------------------------------------
CREATE POLICY occupancy_api_select ON scheduling.slot_occupancy
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff'));
CREATE POLICY occupancy_system_select ON scheduling.slot_occupancy
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY occupancy_owner_select ON scheduling.slot_occupancy
  FOR SELECT TO scheduling_booking_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));
CREATE POLICY occupancy_owner_insert ON scheduling.slot_occupancy
  FOR INSERT TO scheduling_booking_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));
CREATE POLICY occupancy_owner_update ON scheduling.slot_occupancy
  FOR UPDATE TO scheduling_booking_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));

-- slot_reservation ------------------------------------------------------------------------------------------------------
-- T-PAT-APPT: the patient and, for appointments, their proxies (D-7: proxy_patient_ids are in patient_ids).
CREATE POLICY reservation_patient_select ON scheduling.slot_reservation
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')));
CREATE POLICY reservation_patient_insert ON scheduling.slot_reservation
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND booked_via IN ('patient', 'proxy') AND booked_by_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY reservation_patient_update ON scheduling.slot_reservation
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')));
-- T-STAFF (google realm): the patients the staff member's locations care for, and BTG patients. A booking is made only at a
-- location the staff member holds (TC-BK-11).
CREATE POLICY reservation_staff_select ON scheduling.slot_reservation
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = slot_reservation.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY reservation_staff_insert ON scheduling.slot_reservation
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = slot_reservation.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND booked_via = 'staff' AND location_id = ANY (kernel.uuids('app.location_ids')) AND booked_by_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY reservation_staff_update ON scheduling.slot_reservation
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = slot_reservation.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = slot_reservation.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
-- T-ADMIN-BTG: an admin-realm holder of an active break-the-glass grant reads the patient's reservations.
CREATE POLICY reservation_btg_select ON scheduling.slot_reservation
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
-- T-SYS: reads (reminders, export, sweep, waitlist) and, in a patients-scope merge job, the re-pointing of the job's exact IDs.
CREATE POLICY reservation_system_select ON scheduling.slot_reservation
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- The waitlist offer job (25.6) books for the patient it offers the slot to: a patients-scope job for exactly that patient.
CREATE POLICY reservation_system_insert ON scheduling.slot_reservation
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND patient_id = ANY (kernel.uuids('app.job_patient_ids')) AND booked_via = 'waitlist');
CREATE POLICY reservation_system_merge_update ON scheduling.slot_reservation
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));

-- Grants -------------------------------------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA scheduling FROM PUBLIC;

GRANT SELECT ON scheduling.slot_occupancy TO app_api, app_worker;
GRANT SELECT, INSERT ON scheduling.slot_occupancy TO scheduling_booking_owner;
GRANT UPDATE (status, expires_at) ON scheduling.slot_occupancy TO scheduling_booking_owner;

GRANT SELECT ON scheduling.slot_reservation TO app_api, app_worker;
GRANT INSERT (id, organisation_id, patient_id, service_id, location_id, clinician_principal_id, mode, reason, patient_stated_state,
              licensing_result, booked_by_principal_id, booked_via, follow_up_of_encounter_id, created_by)
  ON scheduling.slot_reservation TO app_api;
GRANT UPDATE (rescheduled_from_id, cancel_reason, late_change) ON scheduling.slot_reservation TO app_api;
-- The merge participant (patients-scope system job, the job's exact IDs, SBR-03) and the waitlist offer's hold.
GRANT UPDATE (patient_id) ON scheduling.slot_reservation TO app_worker;
GRANT INSERT (id, organisation_id, patient_id, service_id, location_id, clinician_principal_id, mode, reason, patient_stated_state,
              licensing_result, booked_by_principal_id, booked_via, follow_up_of_encounter_id, created_by)
  ON scheduling.slot_reservation TO app_worker;

-- The merge write guard of 0901 reads the root's status as the function-owner role: three columns, organisation only, never a name.
CREATE POLICY patient_booking_guard_select ON patient.patient
  FOR SELECT TO scheduling_booking_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));
GRANT USAGE ON SCHEMA patient TO scheduling_booking_owner;
GRANT SELECT (id, organisation_id, status) ON patient.patient TO scheduling_booking_owner;
