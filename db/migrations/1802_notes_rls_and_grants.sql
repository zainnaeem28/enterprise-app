-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for the encounter and note tables (ARCHITECTURE 21.4,
-- 22.11; SHARED-BOUNDARIES 6.2, 6.3; ticket BE-17). Templates: T-STAFF (written out, the outer column qualified), T-ADMIN-BTG, T-SYS.
-- Every policy names its roles (M-2).
--
-- Rows are read by staff in scope (a care relationship at one of their locations, or a break-the-glass grant) and by a BTG admin.
-- WHO among those staff may read a note is the service's business (the chart-level assignment rule, 27.4); the policy decides which
-- rows a transaction can reach at all, and pins the writer: an encounter is written by its clinician, a note by its author, a
-- co-signature and an addendum by their signer. What may change in a row, and how, is the trigger's business (1801); a policy here
-- never decides a step. There is no patient-audience policy: the portal has no notes in R1. The worker reads (the reminder, the
-- export) and, for the merge, re-points the patient of the R rows.

ALTER TABLE clinical.encounter ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.encounter FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinical.note ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.note FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinical.note_cosign ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.note_cosign FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinical.note_addendum ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.note_addendum FORCE  ROW LEVEL SECURITY;
-- clinical.encounter: T-STAFF (read, start by the clinician, move by the clinician), T-ADMIN-BTG (read), T-SYS (read, and the merge's re-point)
CREATE POLICY encounter_staff_select ON clinical.encounter
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = encounter.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR encounter.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY encounter_staff_insert ON clinical.encounter
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = encounter.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR encounter.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY encounter_staff_update ON clinical.encounter
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = encounter.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR encounter.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = encounter.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR encounter.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY encounter_btg_select ON clinical.encounter
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND encounter.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY encounter_system_select ON clinical.encounter
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND encounter.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY encounter_system_update ON clinical.encounter
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND encounter.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND encounter.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- clinical.note: T-STAFF (read; write by the author; sign by the author or the encounter's clinician; co-sign by the supervisor named), T-ADMIN-BTG (read), T-SYS
CREATE POLICY note_staff_select ON clinical.note
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = note.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR note.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY note_staff_insert ON clinical.note
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = note.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR note.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND author_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY note_staff_update ON clinical.note
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = note.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR note.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND (author_principal_id = (SELECT kernel.uuid1('app.principal_id')) OR cosign_required_from = (SELECT kernel.uuid1('app.principal_id')) OR EXISTS (SELECT 1 FROM clinical.encounter e WHERE e.id = note.encounter_id AND e.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = note.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR note.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY note_btg_select ON clinical.note
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND note.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY note_system_select ON clinical.note
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND note.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY note_system_update ON clinical.note
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND note.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND note.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- clinical.note_cosign: T-STAFF (read, and append by the supervisor), T-ADMIN-BTG (read), T-SYS (read). Append-only: no UPDATE or DELETE policy exists.
CREATE POLICY cosign_staff_select ON clinical.note_cosign
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = note_cosign.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR note_cosign.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY cosign_staff_insert ON clinical.note_cosign
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = note_cosign.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR note_cosign.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND supervisor_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY cosign_btg_select ON clinical.note_cosign
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND note_cosign.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY cosign_system_select ON clinical.note_cosign
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND note_cosign.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- clinical.note_addendum: T-STAFF (read, and append by the author), T-ADMIN-BTG (read), T-SYS (read). Append-only: no UPDATE or DELETE policy exists.
CREATE POLICY addendum_staff_select ON clinical.note_addendum
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = note_addendum.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR note_addendum.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY addendum_staff_insert ON clinical.note_addendum
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = note_addendum.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR note_addendum.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND author_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY addendum_btg_select ON clinical.note_addendum
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND note_addendum.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY addendum_system_select ON clinical.note_addendum
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND note_addendum.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- Grants -------------------------------------------------------------------------------------------------------------
GRANT SELECT ON clinical.encounter, clinical.note, clinical.note_cosign, clinical.note_addendum TO app_api, app_worker;

-- app_api. The patient, the clinician and the author are fixed at the insert; the state machines are the triggers'. No DELETE anywhere.
GRANT INSERT (id, organisation_id, patient_id, location_id, reservation_id, clinician_principal_id, mode, status, started_at, created_by)
  ON clinical.encounter TO app_api;
GRANT UPDATE (status, started_at, ended_at, note_deferred_reason) ON clinical.encounter TO app_api;
GRANT INSERT (id, organisation_id, encounter_id, patient_id, author_principal_id, template_id, body, created_by)
  ON clinical.note TO app_api;
GRANT UPDATE (body, status, submitted_for_cosign_at, cosign_required_from, signed_at, signed_by) ON clinical.note TO app_api;
GRANT INSERT (note_id, organisation_id, patient_id, supervisor_principal_id, created_by) ON clinical.note_cosign TO app_api;
GRANT INSERT (id, organisation_id, note_id, patient_id, author_principal_id, body, created_by) ON clinical.note_addendum TO app_api;

-- app_worker: the merge participant re-points the R rows (a system job, the job's exact patient IDs); nothing else is written by a job.
GRANT UPDATE (patient_id) ON clinical.encounter, clinical.note TO app_worker;
