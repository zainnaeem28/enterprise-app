-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for the merge tables, and the merge writes that
-- 0702 left to this ticket (ARCHITECTURE 21.4, 22.16, 25.4; SHARED-BOUNDARIES 6.2, 9.2; ticket BE-09). Every policy names its roles (M-2).
--
-- merge_request and merge_residue are reached only through the patient_scope_owner functions of 0803: app_api and app_worker
-- get no right on them. The patient tables below get the one write each that the merge participant of the patient module needs,
-- for app_worker in a patients-scope system job and only for the job's exact patient IDs (SBR-03), as identity (0502) and
-- notifications (0601) did for theirs.

ALTER TABLE patient.merge_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.merge_request FORCE  ROW LEVEL SECURITY;
ALTER TABLE patient.merge_residue ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.merge_residue FORCE  ROW LEVEL SECURITY;

-- merge_request: the function-owner role, in a staff transaction (request, decision) or a system one (execution).
CREATE POLICY merge_request_scope_owner_select ON patient.merge_request
  FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'system'));
CREATE POLICY merge_request_scope_owner_insert ON patient.merge_request
  FOR INSERT TO patient_scope_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff');
CREATE POLICY merge_request_scope_owner_update ON patient.merge_request
  FOR UPDATE TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'system'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'system'));
CREATE POLICY merge_residue_scope_owner_select ON patient.merge_residue
  FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY merge_residue_scope_owner_insert ON patient.merge_residue
  FOR INSERT TO patient_scope_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients');
GRANT SELECT, INSERT, UPDATE ON patient.merge_request TO patient_scope_owner;
GRANT SELECT, INSERT ON patient.merge_residue TO patient_scope_owner;

-- The merge map: complete_merge writes it (a new row, and the final survivor of the rows that pointed at the merged patient).
CREATE POLICY merge_map_scope_owner_insert ON patient.patient_merge
  FOR INSERT TO patient_scope_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients');
CREATE POLICY merge_map_scope_owner_update ON patient.patient_merge
  FOR UPDATE TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients');
GRANT INSERT ON patient.patient_merge TO patient_scope_owner;
GRANT UPDATE (final_survivor_id) ON patient.patient_merge TO patient_scope_owner;

-- complete_merge ends the merged patient's relationships and moves them to the survivor (care_relationship: SELECT, INSERT, UPDATE
-- exist since 0702); it also writes the root and the scope rows with the grants of 0702. The root's merged state is set by
-- UPDATE (status, merged_into) there. Nothing else is added for it.

-- The merge participant of the patient module (app_worker, patients-scope system job, the job's exact IDs).
GRANT UPDATE (patient_id) ON patient.patient_contact, patient.insurance_coverage TO app_worker;
GRANT UPDATE (patient_id, status, reason) ON patient.consent TO app_worker;
GRANT UPDATE (patient_id) ON patient.communication_preference TO app_worker;
GRANT DELETE ON patient.communication_preference TO app_worker;
GRANT UPDATE (patient_id, to_date, end_reason) ON patient.care_team_member TO app_worker;
GRANT UPDATE (patient_id, candidate_patient_id, status, resolved_reason) ON patient.duplicate_flag TO app_worker;

CREATE POLICY contact_system_merge_update ON patient.patient_contact
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY coverage_system_merge_update ON patient.insurance_coverage
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY consent_system_merge_update ON patient.consent
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY preference_system_merge_update ON patient.communication_preference
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY preference_system_merge_delete ON patient.communication_preference
  FOR DELETE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY careteam_system_merge_update ON patient.care_team_member
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));

-- duplicate_flag: a flag of ANOTHER patient that names the merged patient as its candidate gets the survivor as candidate (22.16),
-- so the system job also sees and updates rows whose candidate is one of the job's IDs.
CREATE POLICY flag_system_candidate_select ON patient.duplicate_flag
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND candidate_patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY flag_system_merge_update ON patient.duplicate_flag
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND (patient_id = ANY (kernel.uuids('app.job_patient_ids')) OR candidate_patient_id = ANY (kernel.uuids('app.job_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients');
