-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies (M-1, M-2) and least-privilege grants for the admin realm (ARCHITECTURE
-- 21.2-21.4, 22.4; ticket BE-05). Templates used: T-CONF(admin) (audience staff, session realm admin_pool), T-PRINCIPAL,
-- T-SIGNIN, T-SIGNIN-CLAIM (the B2 pre-verification read, TO identity_signin_ro only), T-REVOKE (kill switch and role removal,
-- keyed by app.revoke_principal_id) and T-SYS.
--
-- What this file adds to the audience `anonymous` list of 21.3 (all of them match nothing until the API has set the named
-- setting after, or for, its own check):
--   (2) T-SIGNIN: session insert for the admin realm; admin_credential insert and update; enrolment_token update to used
--   (3) T-SIGNIN-CLAIM on principal and admin_credential, TO identity_signin_ro
--   (4) enrolment_token SELECT by app.auth_enrolment_token_hash
--   (5) webauthn_challenge by app.webauthn_challenge_id; INSERT for purposes sign_in and enrol only
-- Nothing here is readable by `public`.

ALTER TABLE identity.role_change_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.role_change_request FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.enrolment_token     ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.enrolment_token     FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.admin_credential    ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.admin_credential    FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.webauthn_challenge  ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.webauthn_challenge  FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.elevation_grant     ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.elevation_grant     FORCE  ROW LEVEL SECURITY;

-- principal and person: the claim read, admin provisioning, the kill switch -----------------------------------------------
-- T-SIGNIN-CLAIM: one admin principal by the typed handle, active only (a suspended or disabled handle looks like an unknown
-- one, 26.1). Column grants below limit what identity_signin_ro can see to id, organisation_id, realm, subject, status.
CREATE POLICY principal_signin_claim ON identity.principal
  FOR SELECT TO identity_signin_ro
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND realm = 'admin_pool' AND status = 'active'
     AND subject = (SELECT kernel.setting('app.auth_claim_handle')));
-- T-CONF(admin) provisioning (POST /admin/principals): an admin-realm principal with no credential, or a pre-registered
-- google principal that has no subject yet and so can hold no role (SEC01-F-08).
CREATE POLICY principal_admin_insert ON identity.principal
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND status = 'active'
     AND ((realm = 'admin_pool' AND subject IS NOT NULL AND email IS NULL)
          OR (realm = 'google' AND subject IS NULL AND email IS NOT NULL AND preregistered_at IS NOT NULL)));
CREATE POLICY person_admin_insert ON identity.person
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND status = 'active');
-- T-REVOKE: the kill switch disables exactly the principal named in app.revoke_principal_id.
CREATE POLICY principal_revoke_update ON identity.principal
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND id = (SELECT kernel.uuid1('app.revoke_principal_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND id = (SELECT kernel.uuid1('app.revoke_principal_id')));
-- The kill switch and a role removal also reach the target's sessions, in any admin session of the actor.
CREATE POLICY session_revoke_select ON identity.session
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND principal_id = (SELECT kernel.uuid1('app.revoke_principal_id')));
CREATE POLICY session_revoke_update ON identity.session
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND principal_id = (SELECT kernel.uuid1('app.revoke_principal_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND principal_id = (SELECT kernel.uuid1('app.revoke_principal_id')));
-- T-SIGNIN on session for the admin realm: the insert after the assertion verified (26.1).
CREATE POLICY session_signin_insert_admin ON identity.session
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND token_hash = decode((SELECT kernel.setting('app.session_token_hash')), 'hex')
     AND realm = 'admin_pool'
     AND EXISTS (SELECT 1 FROM identity.principal p
                 WHERE p.id = session.principal_id AND p.person_id = session.person_id AND p.realm = session.realm
                   AND p.realm = (SELECT kernel.setting('app.auth_realm'))
                   AND p.subject = (SELECT kernel.setting('app.auth_subject'))
                   AND p.status = 'active'));

-- role_assignment: only by applying an approved request (C4) ---------------------------------------------------------------
CREATE POLICY role_assignment_admin_insert ON identity.role_assignment
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND EXISTS (SELECT 1 FROM identity.role_change_request r
                 WHERE r.id = role_assignment.granted_via_request_id AND r.status = 'approved'
                   AND r.subject_principal_id = role_assignment.principal_id
                   AND r.approver_person_id = (SELECT kernel.uuid1('app.person_id'))));
CREATE POLICY role_assignment_admin_read ON identity.role_assignment
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY role_assignment_admin_revoke ON identity.role_assignment
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND EXISTS (SELECT 1 FROM identity.role_change_request r
                 WHERE r.subject_principal_id = role_assignment.principal_id AND r.status = 'approved'
                   AND r.approver_person_id = (SELECT kernel.uuid1('app.person_id'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');

-- role_change_request: T-CONF(admin) -------------------------------------------------------------------------------------
CREATE POLICY role_change_request_admin_read ON identity.role_change_request
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY role_change_request_admin_insert ON identity.role_change_request
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND requester_person_id = (SELECT kernel.uuid1('app.person_id')) AND status = 'requested');
CREATE POLICY role_change_request_admin_update ON identity.role_change_request
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY role_change_request_system_select ON identity.role_change_request
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY role_change_request_system_update ON identity.role_change_request
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- enrolment_token ---------------------------------------------------------------------------------------------------------
CREATE POLICY enrolment_token_admin_read ON identity.enrolment_token
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY enrolment_token_admin_insert ON identity.enrolment_token
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND requested_by_person_id = (SELECT kernel.uuid1('app.person_id')) AND status = 'requested');
CREATE POLICY enrolment_token_admin_update ON identity.enrolment_token
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
-- 21.3 item (4): the presented token's hash is the key; nothing else is readable by anonymous.
CREATE POLICY enrolment_token_lookup ON identity.enrolment_token
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND token_hash = decode((SELECT kernel.setting('app.auth_enrolment_token_hash')), 'hex'));
-- T-SIGNIN: the token is marked used once the credential is registered, for the verified principal.
CREATE POLICY enrolment_token_signin_update ON identity.enrolment_token
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND token_hash = decode((SELECT kernel.setting('app.auth_enrolment_token_hash')), 'hex')
     AND EXISTS (SELECT 1 FROM identity.principal p
                 WHERE p.id = enrolment_token.principal_id AND p.realm = (SELECT kernel.setting('app.auth_realm'))
                   AND p.subject = (SELECT kernel.setting('app.auth_subject'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND status IN ('approved', 'used'));
CREATE POLICY enrolment_token_system_select ON identity.enrolment_token
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY enrolment_token_system_update ON identity.enrolment_token
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- admin_credential --------------------------------------------------------------------------------------------------------
CREATE POLICY admin_credential_admin_read ON identity.admin_credential
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
-- T-SIGNIN-CLAIM: live credentials of the claimed active admin principal; public columns only (grants below).
CREATE POLICY admin_credential_signin_claim ON identity.admin_credential
  FOR SELECT TO identity_signin_ro
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND revoked_at IS NULL
     AND EXISTS (SELECT 1 FROM identity.principal p
                 WHERE p.id = admin_credential.principal_id AND p.realm = 'admin_pool' AND p.status = 'active'
                   AND p.subject = (SELECT kernel.setting('app.auth_claim_handle'))));
-- T-SIGNIN: after the verified enrolment (insert) or assertion (counter, last use, revocation on regression).
CREATE POLICY admin_credential_signin_insert ON identity.admin_credential
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND EXISTS (SELECT 1 FROM identity.principal p
                 WHERE p.id = admin_credential.principal_id AND p.realm = (SELECT kernel.setting('app.auth_realm'))
                   AND p.subject = (SELECT kernel.setting('app.auth_subject')) AND p.status = 'active'));
CREATE POLICY admin_credential_signin_select ON identity.admin_credential
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND EXISTS (SELECT 1 FROM identity.principal p
                 WHERE p.id = admin_credential.principal_id AND p.realm = (SELECT kernel.setting('app.auth_realm'))
                   AND p.subject = (SELECT kernel.setting('app.auth_subject'))));
CREATE POLICY admin_credential_signin_update ON identity.admin_credential
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND EXISTS (SELECT 1 FROM identity.principal p
                 WHERE p.id = admin_credential.principal_id AND p.realm = (SELECT kernel.setting('app.auth_realm'))
                   AND p.subject = (SELECT kernel.setting('app.auth_subject'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous');
-- The same two writes at elevation, under the admin's own session (T-PRINCIPAL).
CREATE POLICY admin_credential_principal_update ON identity.admin_credential
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND principal_id = (SELECT kernel.uuid1('app.principal_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND principal_id = (SELECT kernel.uuid1('app.principal_id')));
-- T-REVOKE: the kill switch revokes the target's credentials (a disabled principal cannot sign in anyway).
CREATE POLICY admin_credential_revoke_update ON identity.admin_credential
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND principal_id = (SELECT kernel.uuid1('app.revoke_principal_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND principal_id = (SELECT kernel.uuid1('app.revoke_principal_id')));
CREATE POLICY admin_credential_system_select ON identity.admin_credential
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- webauthn_challenge (SEC01-F-06, B2-5; T-4) -------------------------------------------------------------------------------
CREATE POLICY webauthn_challenge_anon_select ON identity.webauthn_challenge
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous' AND purpose IN ('sign_in', 'enrol')
     AND id = (SELECT kernel.uuid1('app.webauthn_challenge_id')));
CREATE POLICY webauthn_challenge_anon_update ON identity.webauthn_challenge
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous' AND purpose IN ('sign_in', 'enrol')
     AND id = (SELECT kernel.uuid1('app.webauthn_challenge_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous' AND purpose IN ('sign_in', 'enrol'));
CREATE POLICY webauthn_challenge_anon_insert ON identity.webauthn_challenge
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND purpose IN ('sign_in', 'enrol') AND session_id IS NULL);
CREATE POLICY webauthn_challenge_staff_select ON identity.webauthn_challenge
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND purpose IN ('elevation', 'tx_sign')
     AND id = (SELECT kernel.uuid1('app.webauthn_challenge_id'))
     AND principal_id = (SELECT kernel.uuid1('app.principal_id'))
     AND session_id = (SELECT kernel.uuid1('app.session_id')));
CREATE POLICY webauthn_challenge_staff_update ON identity.webauthn_challenge
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND purpose IN ('elevation', 'tx_sign')
     AND id = (SELECT kernel.uuid1('app.webauthn_challenge_id'))
     AND principal_id = (SELECT kernel.uuid1('app.principal_id'))
     AND session_id = (SELECT kernel.uuid1('app.session_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY webauthn_challenge_staff_insert ON identity.webauthn_challenge
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND purpose IN ('elevation', 'tx_sign')
     AND principal_id = (SELECT kernel.uuid1('app.principal_id'))
     AND session_id = (SELECT kernel.uuid1('app.session_id')));
-- T-SYS: the purge every 10 minutes (identity.purge_challenges, 33.1).
CREATE POLICY webauthn_challenge_system_select ON identity.webauthn_challenge
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY webauthn_challenge_system_delete ON identity.webauthn_challenge
  FOR DELETE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- elevation_grant (C1) ----------------------------------------------------------------------------------------------------
CREATE POLICY elevation_grant_principal_select ON identity.elevation_grant
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND person_id = (SELECT kernel.uuid1('app.person_id')));
CREATE POLICY elevation_grant_principal_insert ON identity.elevation_grant
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND person_id = (SELECT kernel.uuid1('app.person_id'))
     AND session_id = (SELECT kernel.uuid1('app.session_id')));
-- Sign-out of the own session ends its grants (T-PRINCIPAL).
CREATE POLICY elevation_grant_principal_revoke ON identity.elevation_grant
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND person_id = (SELECT kernel.uuid1('app.person_id'))
     AND session_id = (SELECT kernel.uuid1('app.session_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
-- T-REVOKE: the target's grants, through the target's sessions (the sub-select is itself filtered by session_revoke_select).
CREATE POLICY elevation_grant_revoke_select ON identity.elevation_grant
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND session_id IN (SELECT s.id FROM identity.session s WHERE s.principal_id = (SELECT kernel.uuid1('app.revoke_principal_id'))));
CREATE POLICY elevation_grant_revoke_update ON identity.elevation_grant
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND session_id IN (SELECT s.id FROM identity.session s WHERE s.principal_id = (SELECT kernel.uuid1('app.revoke_principal_id'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY elevation_grant_system_select ON identity.elevation_grant
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY elevation_grant_system_update ON identity.elevation_grant
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- Grants -------------------------------------------------------------------------------------------------------------------
REVOKE ALL ON identity.role_change_request, identity.enrolment_token, identity.admin_credential,
  identity.webauthn_challenge, identity.elevation_grant FROM PUBLIC;

GRANT SELECT ON identity.role_change_request, identity.enrolment_token, identity.admin_credential,
  identity.webauthn_challenge, identity.elevation_grant TO app_api, app_worker;

-- identity_signin_ro (21.2): column-level SELECT only, so sign_count is read for the comparison and never selected otherwise.
GRANT SELECT (id, organisation_id, realm, subject, status) ON identity.principal TO identity_signin_ro;
GRANT SELECT (id, organisation_id, principal_id, public_key, sign_count, transports, revoked_at)
  ON identity.admin_credential TO identity_signin_ro;

GRANT INSERT (id, organisation_id, requester_person_id, subject_principal_id, change, before, request_hash, status, expires_at, created_by)
  ON identity.role_change_request TO app_api;
GRANT UPDATE (status, approver_person_id, decided_at) ON identity.role_change_request TO app_api, app_worker;

GRANT INSERT (id, organisation_id, principal_id, requested_by_person_id, expires_at, status, created_by)
  ON identity.enrolment_token TO app_api;
GRANT UPDATE (token_hash, approved_by_person_id, expires_at, used_at, status) ON identity.enrolment_token TO app_api;
GRANT UPDATE (status) ON identity.enrolment_token TO app_worker;

GRANT INSERT (id, organisation_id, principal_id, public_key, sign_count, aaguid, transports, backup_eligible,
              user_verified_at_enrol, enrolment_token_id)
  ON identity.admin_credential TO app_api;
GRANT UPDATE (sign_count, last_used_at, revoked_at, revoke_reason) ON identity.admin_credential TO app_api;

GRANT INSERT (id, organisation_id, purpose, principal_id, session_id, challenge, bound_hash, expires_at)
  ON identity.webauthn_challenge TO app_api;
GRANT UPDATE (used_at) ON identity.webauthn_challenge TO app_api;
GRANT DELETE ON identity.webauthn_challenge TO app_worker;

GRANT INSERT (id, organisation_id, session_id, person_id, issued_at, expires_at, assertion_at, method, credential_id)
  ON identity.elevation_grant TO app_api;
GRANT UPDATE (revoked_at, revoke_reason) ON identity.elevation_grant TO app_api, app_worker;

-- Provisioning and kill switch on the existing tables (column grants stay narrow).
GRANT UPDATE (status, disabled_reason) ON identity.principal TO app_api;
GRANT INSERT (id, organisation_id, role_id, principal_id, location_id, granted_via_request_id, created_by)
  ON identity.role_assignment TO app_api;
GRANT UPDATE (revoked_at) ON identity.role_assignment TO app_api;
