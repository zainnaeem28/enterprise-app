-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for the telehealth tables (ARCHITECTURE 21.4, 22.10;
-- SHARED-BOUNDARIES 6.2, 6.3; ticket BE-15). Templates: T-PAT-APPT, T-STAFF (written out, the outer column qualified, SEC03-F01),
-- T-SYS. Every policy names its roles (M-2). The tables stay owned by app_owner; FORCE makes ownership grant nothing.
--
-- Who may take which STEP is the triggers' business (1501); a policy decides which rows a caller reaches.
--   * video_session: created only by the create_meeting job (a patients-scope job for the one patient); the host (the clinician of
--     the session, in their own patients' scope) opens and ends it; the patient reads it. The jobs (organisation scope) set the
--     meeting, end stale sessions, and a patients-scope job re-points it (the merge).
--   * participant: a patient or proxy reads and writes only their OWN row (device check, waiting, join). The host reads every
--     participant of their sessions, inserts their own host row, and admits or removes. The patient audience cannot move `admission`
--     (the trigger refuses it: column grants are per role, not per audience).
--   * join_token: the issuance record; own rows for a patient or proxy; the host reads the session's and revokes them at the end.
--   * location_confirmation: insert-only by the patient or proxy for themselves; staff of the patient read.

ALTER TABLE telehealth.video_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE telehealth.video_session FORCE  ROW LEVEL SECURITY;
ALTER TABLE telehealth.participant ENABLE ROW LEVEL SECURITY;
ALTER TABLE telehealth.participant FORCE  ROW LEVEL SECURITY;
ALTER TABLE telehealth.join_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE telehealth.join_token FORCE  ROW LEVEL SECURITY;
ALTER TABLE telehealth.location_confirmation ENABLE ROW LEVEL SECURITY;
ALTER TABLE telehealth.location_confirmation FORCE  ROW LEVEL SECURITY;
CREATE POLICY video_session_patient_select ON telehealth.video_session
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND video_session.patient_id = ANY (kernel.uuids('app.patient_ids')));
CREATE POLICY video_session_staff_select ON telehealth.video_session
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = video_session.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR video_session.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY video_session_system_select ON telehealth.video_session
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND video_session.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY video_session_system_insert ON telehealth.video_session
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND video_session.patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY video_session_system_update ON telehealth.video_session
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND video_session.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND video_session.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY video_session_host_update ON telehealth.video_session
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = video_session.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR video_session.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND video_session.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = video_session.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR video_session.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND video_session.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY participant_patient_select ON telehealth.participant
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND participant.patient_id = ANY (kernel.uuids('app.patient_ids')) AND participant.principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY participant_staff_select ON telehealth.participant
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = participant.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR participant.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY participant_system_select ON telehealth.participant
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND participant.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY participant_patient_insert ON telehealth.participant
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND participant.patient_id = ANY (kernel.uuids('app.patient_ids')) AND participant.principal_id = (SELECT kernel.uuid1('app.principal_id')) AND role IN ('patient', 'proxy') AND admission = 'waiting' AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY participant_host_insert ON telehealth.participant
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = participant.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR participant.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND participant.principal_id = (SELECT kernel.uuid1('app.principal_id')) AND role = 'clinician' AND admission = 'admitted' AND created_by = (SELECT kernel.uuid1('app.principal_id')) AND EXISTS (SELECT 1 FROM telehealth.video_session v WHERE v.id = participant.session_id AND v.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id'))));
CREATE POLICY participant_patient_update ON telehealth.participant
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND participant.patient_id = ANY (kernel.uuids('app.patient_ids')) AND participant.principal_id = (SELECT kernel.uuid1('app.principal_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND participant.patient_id = ANY (kernel.uuids('app.patient_ids')) AND participant.principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY participant_host_update ON telehealth.participant
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = participant.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR participant.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND EXISTS (SELECT 1 FROM telehealth.video_session v WHERE v.id = participant.session_id AND v.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = participant.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR participant.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND EXISTS (SELECT 1 FROM telehealth.video_session v WHERE v.id = participant.session_id AND v.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id'))));
CREATE POLICY participant_system_update ON telehealth.participant
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND participant.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND participant.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY join_token_patient_select ON telehealth.join_token
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND join_token.patient_id = ANY (kernel.uuids('app.patient_ids')) AND join_token.principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY join_token_staff_select ON telehealth.join_token
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = join_token.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR join_token.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY join_token_system_select ON telehealth.join_token
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND join_token.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY join_token_patient_insert ON telehealth.join_token
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND join_token.patient_id = ANY (kernel.uuids('app.patient_ids')) AND join_token.principal_id = (SELECT kernel.uuid1('app.principal_id')) AND status = 'issued' AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY join_token_host_insert ON telehealth.join_token
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = join_token.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR join_token.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND join_token.principal_id = (SELECT kernel.uuid1('app.principal_id')) AND status = 'issued' AND created_by = (SELECT kernel.uuid1('app.principal_id')) AND EXISTS (SELECT 1 FROM telehealth.video_session v WHERE v.id = join_token.session_id AND v.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id'))));
CREATE POLICY join_token_patient_update ON telehealth.join_token
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND join_token.patient_id = ANY (kernel.uuids('app.patient_ids')) AND join_token.principal_id = (SELECT kernel.uuid1('app.principal_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND join_token.patient_id = ANY (kernel.uuids('app.patient_ids')) AND join_token.principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY join_token_host_update ON telehealth.join_token
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = join_token.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR join_token.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND (join_token.principal_id = (SELECT kernel.uuid1('app.principal_id')) OR EXISTS (SELECT 1 FROM telehealth.video_session v WHERE v.id = join_token.session_id AND v.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = join_token.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR join_token.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND (join_token.principal_id = (SELECT kernel.uuid1('app.principal_id')) OR EXISTS (SELECT 1 FROM telehealth.video_session v WHERE v.id = join_token.session_id AND v.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))));
CREATE POLICY join_token_system_update ON telehealth.join_token
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND join_token.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND join_token.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY location_confirmation_patient_select ON telehealth.location_confirmation
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND location_confirmation.patient_id = ANY (kernel.uuids('app.patient_ids')) AND location_confirmation.principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY location_confirmation_staff_select ON telehealth.location_confirmation
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = location_confirmation.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR location_confirmation.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY location_confirmation_system_select ON telehealth.location_confirmation
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND location_confirmation.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY location_confirmation_patient_insert ON telehealth.location_confirmation
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND location_confirmation.patient_id = ANY (kernel.uuids('app.patient_ids')) AND location_confirmation.principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));

-- Grants -------------------------------------------------------------------------------------------------------------
REVOKE ALL ON telehealth.video_session, telehealth.participant, telehealth.join_token, telehealth.location_confirmation FROM PUBLIC;

GRANT SELECT ON telehealth.video_session, telehealth.participant, telehealth.join_token, telehealth.location_confirmation
  TO app_api, app_worker;

GRANT INSERT (id, organisation_id, session_id, patient_id, role, principal_id, admission, waiting_since, admitted_at, admitted_by, created_by)
  ON telehealth.participant TO app_api;
GRANT INSERT (id, organisation_id, session_id, participant_id, patient_id, principal_id, status, expires_at, created_by)
  ON telehealth.join_token TO app_api;
GRANT INSERT (id, organisation_id, reservation_id, patient_id, principal_id, stated_state, result, override_reason, created_by)
  ON telehealth.location_confirmation TO app_api;

GRANT UPDATE (status, opened_at, ended_at) ON telehealth.video_session TO app_api;
GRANT UPDATE (admission, admitted_at, admitted_by, waiting_since, joined_at, left_at, vendor_attendee_id, device_check, device_checked_at)
  ON telehealth.participant TO app_api;
GRANT UPDATE (status, revoked_at, revoke_reason) ON telehealth.join_token TO app_api;

-- app_worker: the create_meeting job inserts the session (patients scope, the one patient) and sets the meeting; the end_stale sweep
-- ends sessions and revokes their tokens (organisation scope); the merge participant re-points (patients-scope job, the job's exact
-- IDs, SBR-03).
GRANT INSERT (id, organisation_id, reservation_id, patient_id, clinician_principal_id) ON telehealth.video_session TO app_worker;
GRANT UPDATE (patient_id, vendor, vendor_meeting_id, status, opened_at, ended_at) ON telehealth.video_session TO app_worker;
GRANT UPDATE (patient_id, left_at) ON telehealth.participant TO app_worker;
GRANT UPDATE (patient_id, status, revoked_at, revoke_reason) ON telehealth.join_token TO app_worker;
