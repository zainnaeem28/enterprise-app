-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for the clinical front-door tables (ARCHITECTURE 21.4,
-- 22.11; SHARED-BOUNDARIES 6.2, 6.3; ticket BE-18). Templates: T-PAT-OWN (the patient fills in their own questionnaire), T-STAFF
-- (written out, the outer column qualified), T-ADMIN-BTG (read), T-SLICE(consents) (the exception record, read), T-SYS. Every
-- policy names its roles (M-2). The tables stay owned by app_owner; FORCE makes ownership grant nothing.
--
-- What a policy decides is which rows a transaction can reach; WHO may take which STEP of a referral or a follow-up is the
-- triggers' business (1701). A policy never decides a step. The two referral-specific rules of 22.11 are here:
--   * clinical.referral is also readable by the staff of the TARGET location while the referral is sent, accepted or declined (the
--     accept re-check reads the row it locks); everyone else needs the care relationship or BTG, as for every patient row;
--   * clinical.referral_inbox has no patient column and a location-only read policy; its insert policy is the draft 7 text: only
--     for a SENT, INTERNAL referral the sender can see, and only for the location that referral names.
-- Triage assessments and consent exceptions are append-only: no UPDATE or DELETE policy exists for them.

ALTER TABLE clinical.questionnaire_response ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.questionnaire_response FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinical.triage_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.triage_assessment FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinical.referral ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.referral FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinical.referral_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.referral_inbox FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinical.consent_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.consent_exception FORCE  ROW LEVEL SECURITY;
ALTER TABLE clinical.follow_up ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.follow_up FORCE  ROW LEVEL SECURITY;
-- clinical.questionnaire_response: T-PAT-OWN (own patient, draft until submitted), T-STAFF (read), T-ADMIN-BTG (read), T-SYS (read, merge re-point)
CREATE POLICY qr_patient_select ON clinical.questionnaire_response
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND questionnaire_response.patient_id = ANY (kernel.uuids('app.patient_ids')));
CREATE POLICY qr_patient_insert ON clinical.questionnaire_response
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND questionnaire_response.patient_id = ANY (kernel.uuids('app.patient_ids')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY qr_patient_update ON clinical.questionnaire_response
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND questionnaire_response.patient_id = ANY (kernel.uuids('app.patient_ids')) AND status = 'in_progress')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND questionnaire_response.patient_id = ANY (kernel.uuids('app.patient_ids')));
CREATE POLICY qr_staff_select ON clinical.questionnaire_response
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = questionnaire_response.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR questionnaire_response.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY qr_btg_select ON clinical.questionnaire_response
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND questionnaire_response.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY qr_system_select ON clinical.questionnaire_response
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND questionnaire_response.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY qr_system_merge_update ON clinical.questionnaire_response
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND questionnaire_response.patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND questionnaire_response.patient_id = ANY (kernel.uuids('app.job_patient_ids')));
-- clinical.triage_assessment: T-STAFF (read, and append at the caller's own location), T-ADMIN-BTG (read), T-SYS (read). Append-only.
CREATE POLICY triage_staff_select ON clinical.triage_assessment
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = triage_assessment.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR triage_assessment.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY triage_staff_insert ON clinical.triage_assessment
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = triage_assessment.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR triage_assessment.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND location_id = ANY (kernel.uuids('app.location_ids')) AND by_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY triage_btg_select ON clinical.triage_assessment
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND triage_assessment.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY triage_system_select ON clinical.triage_assessment
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND triage_assessment.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- clinical.referral: T-STAFF plus the target location's staff for a sent referral, T-ADMIN-BTG (read), T-SYS (read, merge re-point)
CREATE POLICY referral_staff_select ON clinical.referral
  FOR SELECT TO app_api
  USING ((organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = referral.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR referral.patient_id = ANY (kernel.uuids('app.btg_patient_ids')))) OR (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND referral.status IN ('sent', 'accepted', 'declined') AND referral.target_kind IN ('internal_location', 'internal_service') AND referral.target_location_id = ANY (kernel.uuids('app.location_ids'))));
CREATE POLICY referral_staff_insert ON clinical.referral
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = referral.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR referral.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND status = 'draft' AND from_location_id = ANY (kernel.uuids('app.location_ids')) AND from_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY referral_staff_update ON clinical.referral
  FOR UPDATE TO app_api
  USING ((organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = referral.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR referral.patient_id = ANY (kernel.uuids('app.btg_patient_ids')))) OR (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND referral.status IN ('sent', 'accepted', 'declined') AND referral.target_kind IN ('internal_location', 'internal_service') AND referral.target_location_id = ANY (kernel.uuids('app.location_ids'))))
  WITH CHECK ((organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = referral.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR referral.patient_id = ANY (kernel.uuids('app.btg_patient_ids')))) OR (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND referral.status IN ('sent', 'accepted', 'declined') AND referral.target_kind IN ('internal_location', 'internal_service') AND referral.target_location_id = ANY (kernel.uuids('app.location_ids'))));
CREATE POLICY referral_btg_select ON clinical.referral
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND referral.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY referral_system_select ON clinical.referral
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND referral.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY referral_system_merge_update ON clinical.referral
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND referral.patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND referral.patient_id = ANY (kernel.uuids('app.job_patient_ids')));
-- clinical.referral_inbox: location-only read; insert only for a sent internal referral the sender can see (22.11, draft 7); the
-- receiving location decides a pending row.
CREATE POLICY inbox_staff_select ON clinical.referral_inbox
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND target_location_id = ANY (kernel.uuids('app.location_ids')));
CREATE POLICY inbox_staff_insert ON clinical.referral_inbox
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND created_by = (SELECT kernel.uuid1('app.principal_id')) AND EXISTS (SELECT 1 FROM clinical.referral r WHERE r.id = referral_inbox.referral_id AND r.status = 'sent' AND r.target_kind IN ('internal_location', 'internal_service') AND r.target_location_id = referral_inbox.target_location_id));
CREATE POLICY inbox_staff_update ON clinical.referral_inbox
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND target_location_id = ANY (kernel.uuids('app.location_ids')) AND status = 'pending')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND target_location_id = ANY (kernel.uuids('app.location_ids')));
-- clinical.consent_exception: T-STAFF (read, and append), T-ADMIN-BTG (read), T-SLICE(consents) (read, compliance), T-SYS (read). Append-only.
CREATE POLICY cexc_staff_select ON clinical.consent_exception
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = consent_exception.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR consent_exception.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY cexc_staff_insert ON clinical.consent_exception
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = consent_exception.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR consent_exception.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND by_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY cexc_btg_select ON clinical.consent_exception
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND consent_exception.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY cexc_slice_select ON clinical.consent_exception
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'consents' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));
CREATE POLICY cexc_system_select ON clinical.consent_exception
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND consent_exception.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- clinical.follow_up: T-STAFF (read, create at the caller's own location, change), T-ADMIN-BTG (read), T-SYS (read, merge re-point)
CREATE POLICY followup_staff_select ON clinical.follow_up
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = follow_up.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR follow_up.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY followup_staff_insert ON clinical.follow_up
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = follow_up.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR follow_up.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND location_id = ANY (kernel.uuids('app.location_ids')) AND requested_by = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY followup_staff_update ON clinical.follow_up
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = follow_up.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR follow_up.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = follow_up.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR follow_up.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY followup_btg_select ON clinical.follow_up
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND follow_up.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY followup_system_select ON clinical.follow_up
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND follow_up.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY followup_system_merge_update ON clinical.follow_up
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND follow_up.patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND follow_up.patient_id = ANY (kernel.uuids('app.job_patient_ids')));

-- Grants -------------------------------------------------------------------------------------------------------------
GRANT SELECT ON clinical.questionnaire_response, clinical.triage_assessment, clinical.referral, clinical.referral_inbox,
  clinical.consent_exception, clinical.follow_up TO app_api;
GRANT SELECT ON clinical.questionnaire_response, clinical.triage_assessment, clinical.referral, clinical.consent_exception,
  clinical.follow_up TO app_worker;

-- app_api. The patient and the author are fixed at the insert; the state machine is the trigger's.
GRANT INSERT (id, organisation_id, patient_id, reservation_id, template_key, template_version, answers, created_by)
  ON clinical.questionnaire_response TO app_api;
GRANT UPDATE (answers, status, submitted_at, red_flag) ON clinical.questionnaire_response TO app_api;
GRANT INSERT (id, organisation_id, check_in_id, patient_id, location_id, category, symptoms, notes, red_flag, alert_id, by_principal_id, assessed_at, supersedes_id, created_by)
  ON clinical.triage_assessment TO app_api;
GRANT INSERT (id, organisation_id, patient_id, from_location_id, from_principal_id, target_kind, target_location_id, target_service_id,
              target_external_text, reason, created_by)
  ON clinical.referral TO app_api;
GRANT UPDATE (target_kind, target_location_id, target_service_id, target_external_text, reason, status, decided_by, decided_at, decline_reason)
  ON clinical.referral TO app_api;
GRANT INSERT (referral_id, organisation_id, target_location_id, patient_label_ref, created_by) ON clinical.referral_inbox TO app_api;
GRANT UPDATE (status, decided_at) ON clinical.referral_inbox TO app_api;
GRANT INSERT (id, organisation_id, encounter_id, patient_id, missing_templates, reason, by_principal_id, created_by)
  ON clinical.consent_exception TO app_api;
GRANT INSERT (id, organisation_id, patient_id, location_id, service_id, requested_by, owner_principal_id, due_on, reason, created_by)
  ON clinical.follow_up TO app_api;
GRANT UPDATE (owner_principal_id, due_on, reason, service_id, status, booked_reservation_id, closed_at) ON clinical.follow_up TO app_api;

-- app_worker: the merge participant re-points the R rows (a system job, the job's exact patient IDs); nothing else is written by a job.
GRANT UPDATE (patient_id) ON clinical.questionnaire_response, clinical.referral, clinical.follow_up TO app_worker;
