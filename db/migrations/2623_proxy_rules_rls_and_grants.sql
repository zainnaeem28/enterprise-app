-- migration-class: expand
-- HEAAA-791: row-level security and grants for the proxy rules of 2620.
--   * the invitee reads and accepts an invitation addressed to the e-mail of their own account (the e-mail code is checked by the API);
--   * the patient (never a proxy) invites a proxy and changes the scopes of a non-guardian grant;
--   * staff of a location the patient is cared for at (T-STAFF through patient.staff_scope) link a guardian and revoke any grant;
--   * the extra scopes: a proxy holding `documents` reads the documents released to the patient, one holding `messages` reads the
--     patient's threads and messages. Both go through identity.proxy_allows(), which reads the caller's own active grants, so a
--     revocation or an age-out cuts access in the next statement. Writes stay closed to proxies (T-PAT-OWN is unchanged).

ALTER TABLE identity.proxy_invite_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.proxy_invite_code FORCE  ROW LEVEL SECURITY;

-- identity.proxy_grant -------------------------------------------------------------
CREATE POLICY proxy_grant_invitee_read ON identity.proxy_grant
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND proxy_principal_id IS NULL AND status IN ('requested', 'verified')
     AND invited_email = (SELECT p.email FROM identity.principal p WHERE p.id = (SELECT kernel.uuid1('app.principal_id'))));
CREATE POLICY proxy_grant_invitee_accept ON identity.proxy_grant
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND proxy_principal_id IS NULL AND status IN ('requested', 'verified')
     AND invited_email = (SELECT p.email FROM identity.principal p WHERE p.id = (SELECT kernel.uuid1('app.principal_id'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND proxy_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND status = 'active');
-- An adult patient invites a proxy for their own record.
CREATE POLICY proxy_grant_patient_invite ON identity.proxy_grant
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids'))
     AND proxy_principal_id IS NULL AND invited_email IS NOT NULL AND source = 'patient_invite'
     AND status = 'requested' AND NOT guardian AND verified_by IS NULL AND revoked_at IS NULL
     AND created_by = (SELECT kernel.uuid1('app.principal_id')));
-- The patient changes what an open grant of theirs covers (the guard trigger keeps this to the scopes of a non-guardian grant).
CREATE POLICY proxy_grant_patient_scopes ON identity.proxy_grant
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids'))
     AND NOT guardian AND status IN ('requested', 'verified', 'active'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids'))
     AND NOT guardian AND status IN ('requested', 'verified', 'active'));
-- The proxy leaves.
CREATE POLICY proxy_grant_proxy_leave ON identity.proxy_grant
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND proxy_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND status = 'active')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND proxy_principal_id = (SELECT kernel.uuid1('app.principal_id'))
     AND status = 'revoked' AND revoke_reason = 'patient' AND ended_by = 'proxy');
-- Staff: T-STAFF template (patient.staff_scope at one of the caller's locations, or a break-glass grant), realm google.
-- Staff read: proxy_grant_staff_select (0702, qualified by 0705) already applies.
-- Staff link a guardian: an invitation whose relationship document they checked.
CREATE POLICY proxy_grant_staff_link ON identity.proxy_grant
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = proxy_grant.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids')))
     AND proxy_principal_id IS NULL AND invited_email IS NOT NULL AND source = 'staff_link' AND guardian
     AND relationship IN ('parent', 'guardian') AND status = 'verified' AND revoked_at IS NULL
     AND verified_by = (SELECT kernel.uuid1('app.principal_id')) AND verification_document_id IS NOT NULL
     AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY proxy_grant_staff_revoke ON identity.proxy_grant
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = proxy_grant.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids')))
          OR patient_id = ANY (kernel.uuids('app.btg_patient_ids')))
     AND status IN ('requested', 'verified', 'active'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND status = 'revoked' AND revoke_reason = 'staff' AND ended_by = 'staff');

-- identity.proxy_invite_code -------------------------------------------------------
-- The worker writes it (system, organisation job); the invitee reads and counts attempts on it while the grant is visible to them.
CREATE POLICY invite_code_system_select ON identity.proxy_invite_code
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY invite_code_system_insert ON identity.proxy_invite_code
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY invite_code_system_update ON identity.proxy_invite_code
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY invite_code_invitee_select ON identity.proxy_invite_code
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND EXISTS (SELECT 1 FROM identity.proxy_grant g WHERE g.id = proxy_invite_code.grant_id));
CREATE POLICY invite_code_invitee_update ON identity.proxy_invite_code
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND EXISTS (SELECT 1 FROM identity.proxy_grant g WHERE g.id = proxy_invite_code.grant_id AND g.proxy_principal_id IS NULL))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient');

-- Grants ---------------------------------------------------------------------------
REVOKE ALL ON identity.proxy_invite_code FROM PUBLIC;
GRANT SELECT ON identity.proxy_invite_code TO app_api, app_worker;
GRANT UPDATE (attempts) ON identity.proxy_invite_code TO app_api;
GRANT INSERT (grant_id, organisation_id, salt, code_hash, expires_at, sent_at, created_by_job) ON identity.proxy_invite_code TO app_worker;
GRANT UPDATE (salt, code_hash, attempts, expires_at, sent_at) ON identity.proxy_invite_code TO app_worker;

GRANT INSERT (scopes, guardian, source, invited_email, patient_birth_date, adolescent_from, valid_until, verified_by, verification_document_id)
  ON identity.proxy_grant TO app_api;
GRANT UPDATE (scopes, proxy_principal_id, accepted_at, ended_by) ON identity.proxy_grant TO app_api;
GRANT UPDATE (valid_until, adolescent_from, age_out_notice_at, ended_by) ON identity.proxy_grant TO app_worker;

-- The extra scopes -------------------------------------------------------------------
-- documents: what document_own_select shows the patient from the release rule (clean or confirmed, patient-visible classes); never the
-- proxy's own uploads (a proxy has none: T-PAT-OWN still refuses every write).
CREATE POLICY document_proxy_select ON documents.document
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND document.patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND identity.proxy_allows(document.patient_id, 'documents')
     AND status <> 'deleted'
     AND classification IN ('insurance_card', 'consent', 'patient_upload_other', 'questionnaire_attachment') AND status IN ('clean', 'confirmed'));
CREATE POLICY version_proxy_select ON documents.document_version
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND document_version.patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND identity.proxy_allows(document_version.patient_id, 'documents')
     AND EXISTS (SELECT 1 FROM documents.document d WHERE d.id = document_version.document_id));
-- messages: the patient's threads and, through the thread, their messages (message_patient_select checks the thread under RLS).
CREATE POLICY thread_proxy_select ON messaging.thread
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND kind = 'patient'
     AND thread.patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND identity.proxy_allows(thread.patient_id, 'messages'));
