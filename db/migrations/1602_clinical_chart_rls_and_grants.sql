-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for the clinical chart tables (ARCHITECTURE 21.4,
-- 22.11; SHARED-BOUNDARIES 6.2, 6.3; ticket BE-16). Templates: T-STAFF (written out, the outer column qualified), T-ADMIN-BTG,
-- T-SYS, T-CONF(staff) for the reference ranges, T-CONF for the terminology. Every policy names its roles (M-2).
--
-- Chart rows are read by staff in scope (a care relationship at one of their locations, or a break-the-glass grant) and by a BTG
-- admin. WHO among those staff may read the chart is the route guard's business (clinical.chart.read is assignment-bound, 27.4);
-- the policy decides which rows a transaction can reach at all. There is no patient-audience policy: the portal has no chart in R1.
-- The tables stay owned by app_owner; FORCE makes ownership grant nothing. What may change in a row, and how, is the trigger's
-- business (1601); a policy here never decides a step.

ALTER TABLE clinical.problem ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.problem FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinical.allergy ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.allergy FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinical.medication_statement ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.medication_statement FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinical.vital_sign ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.vital_sign FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinical.vital_range ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.vital_range FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinical.terminology_concept ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.terminology_concept FORCE  ROW LEVEL SECURITY;

-- clinical.problem: T-STAFF, T-ADMIN-BTG (read), T-SYS (read, and the merge's re-point)
CREATE POLICY problem_staff_select ON clinical.problem
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = problem.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR problem.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY problem_staff_insert ON clinical.problem
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = problem.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR problem.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND recorded_by = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY problem_staff_update ON clinical.problem
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = problem.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR problem.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = problem.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR problem.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY problem_btg_select ON clinical.problem
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND problem.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY problem_system_select ON clinical.problem
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND problem.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY problem_system_update ON clinical.problem
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND problem.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND problem.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- clinical.allergy: T-STAFF, T-ADMIN-BTG (read), T-SYS (read, and the merge's re-point)
CREATE POLICY allergy_staff_select ON clinical.allergy
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = allergy.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR allergy.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY allergy_staff_insert ON clinical.allergy
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = allergy.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR allergy.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND recorded_by = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY allergy_staff_update ON clinical.allergy
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = allergy.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR allergy.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = allergy.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR allergy.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY allergy_btg_select ON clinical.allergy
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND allergy.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY allergy_system_select ON clinical.allergy
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND allergy.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY allergy_system_update ON clinical.allergy
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND allergy.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND allergy.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- clinical.medication_statement: T-STAFF, T-ADMIN-BTG (read), T-SYS (read, and the merge's re-point)
CREATE POLICY medication_staff_select ON clinical.medication_statement
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = medication_statement.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR medication_statement.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY medication_staff_insert ON clinical.medication_statement
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = medication_statement.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR medication_statement.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND recorded_by = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY medication_staff_update ON clinical.medication_statement
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = medication_statement.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR medication_statement.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = medication_statement.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR medication_statement.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY medication_btg_select ON clinical.medication_statement
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND medication_statement.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY medication_system_select ON clinical.medication_statement
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND medication_statement.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY medication_system_update ON clinical.medication_statement
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND medication_statement.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND medication_statement.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- clinical.vital_sign: T-STAFF (read, and append), T-ADMIN-BTG (read), T-SYS (read). Append-only: no UPDATE or DELETE policy exists.
CREATE POLICY vital_staff_select ON clinical.vital_sign
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = vital_sign.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR vital_sign.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY vital_staff_insert ON clinical.vital_sign
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = vital_sign.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR vital_sign.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND by_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY vital_btg_select ON clinical.vital_sign
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND vital_sign.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY vital_system_select ON clinical.vital_sign
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND vital_sign.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- clinical.vital_range: T-CONF(staff) read (staff of either realm and system); writes only for an admin_pool principal.
CREATE POLICY range_staff_select ON clinical.vital_range
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff');
CREATE POLICY range_system_select ON clinical.vital_range
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY range_admin_insert ON clinical.vital_range
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY range_admin_update ON clinical.vital_range
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND retired_by = (SELECT kernel.uuid1('app.principal_id')));
-- clinical.terminology_concept: T-CONF read for every authenticated audience; the load job (system) is the only writer.
CREATE POLICY terminology_read ON clinical.terminology_concept
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner'));
CREATE POLICY terminology_system_select ON clinical.terminology_concept
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY terminology_system_insert ON clinical.terminology_concept
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY terminology_system_update ON clinical.terminology_concept
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system');

-- Grants -------------------------------------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA clinical FROM PUBLIC;

GRANT SELECT ON clinical.problem, clinical.allergy, clinical.medication_statement, clinical.vital_sign, clinical.vital_range,
  clinical.terminology_concept TO app_api, app_worker;

-- app_api: record and change entries (the status, the dates, the free text of an uncoded entry or its coding); append vitals; the
-- admin routes create and retire ranges. The patient and the author are fixed at the insert.
GRANT INSERT (id, organisation_id, patient_id, code_system, code, display, coded, onset_date, resolved_date, recorded_by, created_by)
  ON clinical.problem TO app_api;
GRANT UPDATE (status, onset_date, resolved_date, code_system, code, display, coded) ON clinical.problem TO app_api;
GRANT INSERT (id, organisation_id, patient_id, code_system, code, display, coded, category, reaction, severity, onset_date, resolved_date, recorded_by, created_by)
  ON clinical.allergy TO app_api;
GRANT UPDATE (status, onset_date, resolved_date, reaction, severity, code_system, code, display, coded) ON clinical.allergy TO app_api;
GRANT INSERT (id, organisation_id, patient_id, rxnorm_code, display, coded, dose_text, start_date, end_date, recorded_by, created_by)
  ON clinical.medication_statement TO app_api;
GRANT UPDATE (status, dose_text, start_date, end_date, rxnorm_code, display, coded) ON clinical.medication_statement TO app_api;
GRANT INSERT (id, organisation_id, patient_id, encounter_id, check_in_id, loinc_code, value, unit, range_status, range_id, range_low, range_high,
              measured_at, by_principal_id, corrects_id, entered_in_error, created_by)
  ON clinical.vital_sign TO app_api;
GRANT INSERT (id, organisation_id, loinc_code, unit, sex, age_years, low, high, approved_by_note, created_by) ON clinical.vital_range TO app_api;
GRANT UPDATE (status, retired_at, retired_by) ON clinical.vital_range TO app_api;

-- app_worker: the merge participant re-points the three lists (system job, the job's exact patient IDs); the terminology load.
GRANT UPDATE (patient_id) ON clinical.problem, clinical.allergy, clinical.medication_statement TO app_worker;
GRANT INSERT (system, code, organisation_id, display, active, release) ON clinical.terminology_concept TO app_worker;
GRANT UPDATE (display, active, release, loaded_at) ON clinical.terminology_concept TO app_worker;

