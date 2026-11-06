-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for the documents tables (ARCHITECTURE 21.4, 22.7;
-- SHARED-BOUNDARIES 6.2, 6.3; ticket BE-10). Templates: T-PAT-OWN, T-STAFF (written out, the outer column qualified), T-SLICE(consents)
-- for classification = 'consent' only, T-SLICE(incidents) for holds, T-ADMIN-BTG, T-SYS. Every policy names its roles (M-2).
--
-- A patient sees what they uploaded and the documents released to them (insurance card, consent, other upload, questionnaire
-- attachment) once those are clean or confirmed; never a document that is deleted. A proxy sees none (D-7: appointments only), because
-- T-PAT-OWN excludes proxy_patient_ids. The tables stay owned by app_owner; FORCE makes ownership grant nothing.
-- Who may take which STEP (clean, confirmed, deleted, scan results) is the trigger's business (1001): a policy here only decides
-- which rows a caller reaches.

ALTER TABLE documents.document ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents.document FORCE  ROW LEVEL SECURITY;
ALTER TABLE documents.document_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents.document_version FORCE  ROW LEVEL SECURITY;
ALTER TABLE documents.legal_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents.legal_hold FORCE  ROW LEVEL SECURITY;
ALTER TABLE documents.deletion_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents.deletion_request FORCE  ROW LEVEL SECURITY;

CREATE POLICY document_own_select ON documents.document
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND document.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT document.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND status <> 'deleted' AND (uploaded_by = (SELECT kernel.uuid1('app.principal_id')) OR (classification IN ('insurance_card', 'consent', 'patient_upload_other', 'questionnaire_attachment') AND status IN ('clean', 'confirmed'))));
CREATE POLICY document_own_insert ON documents.document
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND document.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT document.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND upload_channel = 'patient' AND uploaded_by = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')) AND status = 'awaiting_upload' AND classification IN ('insurance_card', 'id_document', 'patient_upload_other', 'questionnaire_attachment'));
CREATE POLICY document_own_update ON documents.document
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND document.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT document.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND uploaded_by = (SELECT kernel.uuid1('app.principal_id')) AND status = 'awaiting_upload')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND document.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT document.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND uploaded_by = (SELECT kernel.uuid1('app.principal_id')) AND status IN ('awaiting_upload', 'scanning'));
CREATE POLICY document_staff_select ON documents.document
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = document.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR document.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY document_staff_insert ON documents.document
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = document.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR document.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND upload_channel = 'staff' AND uploaded_by = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')) AND status = 'awaiting_upload');
CREATE POLICY document_staff_update ON documents.document
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = document.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR document.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = document.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR document.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY document_slice_select ON documents.document
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'consents' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')) AND classification = 'consent');
CREATE POLICY document_btg_select ON documents.document
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND document.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY document_system_select ON documents.document
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND document.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY document_system_update ON documents.document
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND document.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND document.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY version_own_select ON documents.document_version
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND document_version.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT document_version.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND EXISTS (SELECT 1 FROM documents.document d WHERE d.id = document_version.document_id));
CREATE POLICY version_own_insert ON documents.document_version
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND document_version.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT document_version.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY version_own_update ON documents.document_version
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND document_version.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT document_version.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND EXISTS (SELECT 1 FROM documents.document d WHERE d.id = document_version.document_id))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND document_version.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT document_version.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY version_staff_select ON documents.document_version
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = document_version.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR document_version.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY version_staff_insert ON documents.document_version
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = document_version.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR document_version.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY version_staff_update ON documents.document_version
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = document_version.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR document_version.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = document_version.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR document_version.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY version_slice_select ON documents.document_version
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'consents' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')) AND EXISTS (SELECT 1 FROM documents.document d WHERE d.id = document_version.document_id));
CREATE POLICY version_btg_select ON documents.document_version
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND document_version.patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY version_system_select ON documents.document_version
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND document_version.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY version_system_update ON documents.document_version
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND document_version.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND document_version.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY hold_staff_select ON documents.legal_hold
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = legal_hold.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR legal_hold.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY hold_staff_insert ON documents.legal_hold
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = legal_hold.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR legal_hold.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY hold_slice_select ON documents.legal_hold
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'incidents' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));
CREATE POLICY hold_system_select ON documents.legal_hold
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND legal_hold.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY request_own_select ON documents.deletion_request
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND deletion_request.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT deletion_request.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY request_own_insert ON documents.deletion_request
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND deletion_request.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT deletion_request.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND requested_by = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')) AND outcome IN ('pending', 'refused_legal_hold', 'refused_retention'));
CREATE POLICY request_staff_select ON documents.deletion_request
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = deletion_request.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR deletion_request.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY request_staff_insert ON documents.deletion_request
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = deletion_request.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR deletion_request.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND requested_by = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')) AND outcome IN ('pending', 'refused_legal_hold', 'refused_retention'));
CREATE POLICY request_staff_update ON documents.deletion_request
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = deletion_request.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR deletion_request.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND outcome = 'pending')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = deletion_request.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR deletion_request.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY request_system_select ON documents.deletion_request
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND deletion_request.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY request_system_update ON documents.deletion_request
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND deletion_request.patient_id = ANY (kernel.uuids('app.job_patient_ids')))) AND outcome = 'pending')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND deletion_request.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- Grants -------------------------------------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA documents FROM PUBLIC;

GRANT SELECT ON documents.document, documents.document_version, documents.legal_hold, documents.deletion_request TO app_api, app_worker;

-- app_api: the upload (document and its first version), completing it (scan request time and status), staff classification and
-- confirmation, holds, deletion requests and their decision.
GRANT INSERT (id, organisation_id, patient_id, classification, status, current_version, uploaded_by, upload_channel, created_by)
  ON documents.document TO app_api;
GRANT UPDATE (status, classification, confirmed_by, confirmed_at, retention_until, deleted_at) ON documents.document TO app_api;
GRANT INSERT (document_id, version, organisation_id, patient_id, object_key, bucket, size_bytes, content_type, declared_content_type, created_by)
  ON documents.document_version TO app_api;
GRANT UPDATE (scan_requested_at) ON documents.document_version TO app_api;
GRANT INSERT (id, organisation_id, document_id, patient_id, action, reason, by_person_id, created_by) ON documents.legal_hold TO app_api;
GRANT INSERT (id, organisation_id, document_id, patient_id, requested_by, outcome, reason_recorded, decided_at, created_by)
  ON documents.deletion_request TO app_api;
GRANT UPDATE (outcome, reason_recorded, decided_at, decided_by) ON documents.deletion_request TO app_api;

-- app_worker: the scan and OCR jobs, the retention sweep, and the merge participant (patients-scope system job, the job's exact IDs).
GRANT UPDATE (status, suggested_classification, patient_id) ON documents.document TO app_worker;
GRANT UPDATE (patient_id, object_key, bucket, sha256, size_bytes, content_type, scan_status, scanned_at, ocr_status, object_removed_at)
  ON documents.document_version TO app_worker;
GRANT UPDATE (patient_id) ON documents.deletion_request TO app_worker;
