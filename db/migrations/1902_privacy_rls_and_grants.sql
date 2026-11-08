-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for the privacy tables (ARCHITECTURE 21.4, 22.14;
-- SHARED-BOUNDARIES 6.2, 6.3, 6.7; ticket BE-20). Templates: T-PAT-OWN, T-STAFF (create only), T-SLICE(privacy_requests),
-- T-SLICE(incidents), T-SYS. Every policy names its roles (M-2).
--
-- The patient sees and creates their own requests and sees (and takes) their own package once it is ready; a proxy sees none (D-7).
-- Staff with `privacy.request.create_for_patient` create a request for a patient in their scope and read nothing back. Compliance
-- (admin realm, `app.phi_access = limited`) reaches requests and package METADATA through the `privacy_requests` slice key, and the
-- incident register through `incidents`; nothing else, and no download route for a package exists for them (6.7). The worker builds
-- and expires packages, records the legal-hold check and completes export requests. What may change in a row, and how, is the
-- trigger's business (1901); a policy here never decides a step. There is no DELETE anywhere.

ALTER TABLE privacy.request ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy.request FORCE  ROW LEVEL SECURITY;
ALTER TABLE privacy.export_package ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy.export_package FORCE  ROW LEVEL SECURITY;
ALTER TABLE privacy.incident ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy.incident FORCE  ROW LEVEL SECURITY;
ALTER TABLE privacy.incident_patient ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy.incident_patient FORCE  ROW LEVEL SECURITY;

CREATE POLICY request_own_select ON privacy.request
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND request.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT request.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY request_own_insert ON privacy.request
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND request.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT request.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND channel = 'portal' AND requested_by_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')) AND status IN ('received', 'blocked_d8'));
CREATE POLICY request_staff_insert ON privacy.request
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = request.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR request.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND channel = 'staff' AND requested_by_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND created_by = (SELECT kernel.uuid1('app.principal_id')) AND status IN ('received', 'blocked_d8'));
CREATE POLICY request_slice_select ON privacy.request
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'privacy_requests' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));
CREATE POLICY request_slice_update ON privacy.request
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'privacy_requests' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'privacy_requests' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));
CREATE POLICY request_system_select ON privacy.request
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND request.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY request_system_update ON privacy.request
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND request.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND request.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY package_own_select ON privacy.export_package
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND export_package.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT export_package.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND status IN ('ready', 'released'));
CREATE POLICY package_own_update ON privacy.export_package
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND export_package.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT export_package.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND status = 'ready')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND export_package.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT export_package.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND status = 'released');
CREATE POLICY package_slice_select ON privacy.export_package
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'privacy_requests' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));
CREATE POLICY package_slice_insert ON privacy.export_package
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'privacy_requests' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')) AND status = 'assembling' AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY package_system_select ON privacy.export_package
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND export_package.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY package_system_update ON privacy.export_package
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND export_package.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND export_package.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY incident_slice_select ON privacy.incident
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'incidents' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));
CREATE POLICY incident_slice_insert ON privacy.incident
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'incidents' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY incident_slice_update ON privacy.incident
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'incidents' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'incidents' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));
CREATE POLICY incident_patient_slice_select ON privacy.incident_patient
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'incidents' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));
CREATE POLICY incident_patient_slice_insert ON privacy.incident_patient
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'incidents' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY incident_patient_slice_update ON privacy.incident_patient
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'incidents' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'incidents' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));

-- Grants -------------------------------------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA privacy FROM PUBLIC;

GRANT SELECT ON privacy.request, privacy.export_package, privacy.incident, privacy.incident_patient TO app_api, app_worker;

-- app_api: a request (patient or staff), its verification and decision (compliance), a package row at approval, its release (patient),
-- and the incident register.
GRANT INSERT (id, organisation_id, patient_id, kind, requested_by_principal_id, channel, detail, status, due_at, created_by)
  ON privacy.request TO app_api;
GRANT UPDATE (status, verification_method, verified_by_person_id, verified_at, decided_by_person_id, decided_at, decision_reason)
  ON privacy.request TO app_api;
GRANT INSERT (id, organisation_id, request_id, patient_id, status, created_by) ON privacy.export_package TO app_api;
GRANT UPDATE (status, released_at) ON privacy.export_package TO app_api;
GRANT INSERT (id, organisation_id, title, description, severity, status, discovered_at, notification_deadline, created_by)
  ON privacy.incident TO app_api;
GRANT UPDATE (title, description, severity, status, notification_deadline, closed_at) ON privacy.incident TO app_api;
GRANT INSERT (incident_id, patient_id, organisation_id, audit_event_ids, created_by) ON privacy.incident_patient TO app_api;
GRANT UPDATE (audit_event_ids) ON privacy.incident_patient TO app_api;

-- app_worker: the assembly and expiry of packages, the completion of a request, the legal-hold check, and the merge participant
-- (a patients-scope system job, the job's exact IDs).
GRANT UPDATE (status, legal_hold_documents, legal_hold_checked_at, patient_id) ON privacy.request TO app_worker;
GRANT UPDATE (status, object_key, size_bytes, part_counts, expires_at, failure_code, patient_id) ON privacy.export_package TO app_worker;
