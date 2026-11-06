-- migration-class: expand
-- FORCE ROW LEVEL SECURITY on the identity tables (M-1), role-targeted policies (M-2; templates of ARCHITECTURE 21.4:
-- T-CONF(staff), T-PRINCIPAL, T-SIGNIN, T-PAT-OWN, T-SYS) and least-privilege grants (ticket BE-04).
--
-- Audience `anonymous` matches exactly these policies (the identity part of the 21.3 closed list): the session lookup by
-- token hash, and T-SIGNIN on person, principal and session. T-SIGNIN matches nothing until the API has set
-- app.auth_subject after its own verification (26.1). Nothing else here matches `anonymous` or `public` except the two
-- T-DIRECTORY policies of 0503.
--
-- Left to later tickets, on purpose: T-STAFF policies on patient_link and proxy_grant need patient.staff_scope (BE-08);
-- T-REVOKE, the B2 claim policies and the admin writes belong to BE-05 (migrations 2200-2299).

ALTER TABLE identity.person          ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.person          FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.principal       ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.principal       FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.session         ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.session         FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.role            ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.role            FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.permission      ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.permission      FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.role_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.role_permission FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.role_assignment FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.staff_profile   ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.staff_profile   FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.licensed_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.licensed_state  FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.patient_link    ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.patient_link    FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.proxy_grant     ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.proxy_grant     FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.push_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.push_subscription FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.staff_support   ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.staff_support   FORCE  ROW LEVEL SECURITY;

-- identity.person -----------------------------------------------------------
-- T-CONF(staff) read; T-PRINCIPAL (own person); T-SIGNIN insert; T-SYS read.
CREATE POLICY person_staff_read ON identity.person
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff');
CREATE POLICY person_own_read ON identity.person
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
     AND id = (SELECT kernel.uuid1('app.person_id')));
CREATE POLICY person_signin_insert ON identity.person
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND (SELECT kernel.setting('app.auth_subject')) IS NOT NULL
     AND status = 'active');
CREATE POLICY person_system_read ON identity.person
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- identity.principal ----------------------------------------------------------
CREATE POLICY principal_staff_read ON identity.principal
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff');
CREATE POLICY principal_own_read ON identity.principal
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
     AND id = (SELECT kernel.uuid1('app.principal_id')));
-- T-SIGNIN: the row belongs to the verified subject. A pre-registered google principal (subject null) matches by the
-- verified, lower-cased email (26.1). The API sets app.auth_* only after its own verification.
CREATE POLICY principal_signin_select ON identity.principal
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND realm = (SELECT kernel.setting('app.auth_realm'))
     AND (subject = (SELECT kernel.setting('app.auth_subject'))
          OR (realm = 'google' AND subject IS NULL AND lower(email) = (SELECT kernel.setting('app.auth_email')))));
-- SEC01-F-07: only the patient and google realms are provisioned on a sign-in path.
CREATE POLICY principal_signin_insert ON identity.principal
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND realm IN ('patient_pool', 'google')
     AND realm = (SELECT kernel.setting('app.auth_realm'))
     AND subject = (SELECT kernel.setting('app.auth_subject'))
     AND (realm <> 'google' OR email = (SELECT kernel.setting('app.auth_email')))
     AND status = 'active');
CREATE POLICY principal_signin_update ON identity.principal
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND realm = (SELECT kernel.setting('app.auth_realm'))
     AND (subject = (SELECT kernel.setting('app.auth_subject'))
          OR (realm = 'google' AND subject IS NULL AND lower(email) = (SELECT kernel.setting('app.auth_email')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND realm = (SELECT kernel.setting('app.auth_realm'))
     AND subject = (SELECT kernel.setting('app.auth_subject')));
CREATE POLICY principal_system_read ON identity.principal
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- identity.session --------------------------------------------------------------
-- The one lookup per request (26.2): by the hash of the presented cookie, audience anonymous, nothing else.
CREATE POLICY session_lookup ON identity.session
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND token_hash = decode((SELECT kernel.setting('app.session_token_hash')), 'hex'));
-- T-SIGNIN insert: the new token's hash and the verified principal, in the same realm and person.
CREATE POLICY session_signin_insert ON identity.session
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND token_hash = decode((SELECT kernel.setting('app.session_token_hash')), 'hex')
     AND realm IN ('patient_pool', 'google')
     AND EXISTS (SELECT 1 FROM identity.principal p
                 WHERE p.id = session.principal_id AND p.person_id = session.person_id AND p.realm = session.realm
                   AND p.realm = (SELECT kernel.setting('app.auth_realm'))
                   AND p.subject = (SELECT kernel.setting('app.auth_subject'))
                   AND p.status = 'active'));
-- T-PRINCIPAL: the own session (touch, token rotation, sign-out).
CREATE POLICY session_principal_select ON identity.session
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
     AND principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY session_principal_update ON identity.session
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
     AND principal_id = (SELECT kernel.uuid1('app.principal_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
     AND principal_id = (SELECT kernel.uuid1('app.principal_id')));
-- T-SYS: purge and revocation by jobs.
CREATE POLICY session_system_select ON identity.session
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY session_system_update ON identity.session
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY session_system_delete ON identity.session
  FOR DELETE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- role, permission, role_permission (reference data) ---------------------------------
-- T-CONF read for the authenticated audiences (the guard and the scope builder read them in every request); the worker
-- applies the reference data as `system`. No admin write here: the mapping changes only through a role-change request (C4).
CREATE POLICY role_read ON identity.role
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner'));
CREATE POLICY role_system_select ON identity.role
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY role_system_insert ON identity.role
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY role_system_update ON identity.role
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

CREATE POLICY permission_read ON identity.permission
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner'));
CREATE POLICY permission_system_select ON identity.permission
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY permission_system_insert ON identity.permission
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY permission_system_update ON identity.permission
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

CREATE POLICY role_permission_read ON identity.role_permission
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner'));
CREATE POLICY role_permission_system_select ON identity.role_permission
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY role_permission_system_insert ON identity.role_permission
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY role_permission_system_delete ON identity.role_permission
  FOR DELETE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- identity.role_assignment --------------------------------------------------------
CREATE POLICY role_assignment_staff_read ON identity.role_assignment
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff');
CREATE POLICY role_assignment_own_read ON identity.role_assignment
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
     AND principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY role_assignment_system_select ON identity.role_assignment
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY role_assignment_system_update ON identity.role_assignment
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- identity.staff_profile, licensed_state, staff_support (T-CONF(staff) read) -----------------
CREATE POLICY staff_profile_staff_read ON identity.staff_profile
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff');
CREATE POLICY staff_profile_system_select ON identity.staff_profile
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
-- licensed_state: plain T-CONF (the telehealth licensing check also runs for a patient transaction).
CREATE POLICY licensed_state_read ON identity.licensed_state
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner'));
CREATE POLICY licensed_state_system_select ON identity.licensed_state
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY staff_support_staff_read ON identity.staff_support
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff');
CREATE POLICY staff_support_system_select ON identity.staff_support
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- identity.patient_link ------------------------------------------------------------
-- T-PRINCIPAL read of the own links. The INSERT is open to patient_scope_owner only: the link is created inside
-- patient.register (BE-08), never by an API statement. T-SYS for the merge participant (patients-scope job).
CREATE POLICY patient_link_principal_read ON identity.patient_link
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY patient_link_scope_owner_insert ON identity.patient_link
  FOR INSERT TO patient_scope_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient'));
CREATE POLICY patient_link_system_select ON identity.patient_link
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY patient_link_system_update ON identity.patient_link
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY patient_link_system_delete ON identity.patient_link
  FOR DELETE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));

-- identity.proxy_grant -------------------------------------------------------------
-- T-PRINCIPAL (proxy), T-PAT-OWN (the patient's own proxies; a proxy never reads these rows by this policy), T-SYS.
CREATE POLICY proxy_grant_proxy_read ON identity.proxy_grant
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND proxy_principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY proxy_grant_patient_read ON identity.proxy_grant
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
-- A proxy asks for access: a `requested` row for itself, nothing more.
CREATE POLICY proxy_grant_proxy_request ON identity.proxy_grant
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND proxy_principal_id = (SELECT kernel.uuid1('app.principal_id'))
     AND status = 'requested' AND verified_by IS NULL AND revoked_at IS NULL);
-- The patient revokes their own proxy.
CREATE POLICY proxy_grant_patient_revoke ON identity.proxy_grant
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids'))
     AND status IN ('requested', 'verified', 'active'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids'))
     AND status = 'revoked' AND revoke_reason = 'patient');
CREATE POLICY proxy_grant_system_select ON identity.proxy_grant
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY proxy_grant_system_update ON identity.proxy_grant
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- identity.push_subscription (T-PRINCIPAL) ---------------------------------------------
CREATE POLICY push_subscription_principal ON identity.push_subscription
  FOR ALL TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
     AND principal_id = (SELECT kernel.uuid1('app.principal_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
     AND principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY push_subscription_system_select ON identity.push_subscription
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- Grants -------------------------------------------------------------------------
REVOKE ALL ON identity.person, identity.principal, identity.session, identity.role, identity.permission,
  identity.role_permission, identity.role_assignment, identity.staff_profile, identity.licensed_state,
  identity.patient_link, identity.proxy_grant, identity.push_subscription, identity.staff_support FROM PUBLIC;

GRANT SELECT ON identity.person, identity.principal, identity.session, identity.role, identity.permission,
  identity.role_permission, identity.role_assignment, identity.staff_profile, identity.licensed_state,
  identity.patient_link, identity.proxy_grant, identity.push_subscription, identity.staff_support
  TO app_api, app_worker;

-- Sign-in provisioning and the session columns (21.2, SEC01-F-09): no other column of a session can change after insert.
GRANT INSERT (id, organisation_id, display_name, status, created_by) ON identity.person TO app_api;
GRANT INSERT (id, organisation_id, person_id, realm, subject, email, status, last_sign_in_at, preregistered_at, created_by)
  ON identity.principal TO app_api;
GRANT UPDATE (subject, last_sign_in_at) ON identity.principal TO app_api;
GRANT INSERT (id, organisation_id, token_hash, principal_id, person_id, realm, audience, auth_time, amr, csrf_hash,
              idle_expires_at, absolute_expires_at, last_seen_at, last_interaction_at, ip, user_agent, created_by)
  ON identity.session TO app_api;
GRANT UPDATE (last_seen_at, last_interaction_at, idle_expires_at, token_hash, csrf_hash, revoked_at, revoke_reason)
  ON identity.session TO app_api;

-- Reference data job (T-SYS).
GRANT INSERT, UPDATE ON identity.role, identity.permission TO app_worker;
GRANT INSERT, DELETE ON identity.role_permission TO app_worker;
GRANT UPDATE (revoked_at) ON identity.role_assignment TO app_worker;
GRANT UPDATE (revoked_at, revoke_reason) ON identity.session TO app_worker;
GRANT DELETE ON identity.session TO app_worker;

-- Patient links and proxy grants.
GRANT INSERT ON identity.patient_link TO patient_scope_owner;
GRANT UPDATE (patient_id) ON identity.patient_link TO app_worker;
GRANT DELETE ON identity.patient_link TO app_worker;
GRANT INSERT (id, organisation_id, proxy_principal_id, patient_id, relationship, scope, patient_display_name, status, created_by)
  ON identity.proxy_grant TO app_api;
GRANT UPDATE (status, revoked_at, revoke_reason) ON identity.proxy_grant TO app_api;
GRANT UPDATE (patient_id, status, revoked_at, revoke_reason) ON identity.proxy_grant TO app_worker;

-- Own push subscriptions.
GRANT INSERT (id, organisation_id, principal_id, endpoint, p256dh, auth, user_agent, created_by) ON identity.push_subscription TO app_api;
GRANT UPDATE (revoked_at) ON identity.push_subscription TO app_api;
