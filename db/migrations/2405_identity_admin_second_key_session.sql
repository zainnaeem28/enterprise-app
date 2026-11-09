-- migration-class: expand
-- BE05-R3-S01: the enrolment token is spent at the first key. The second key is registered under the admin's own session
-- (the one the enrolment created, amr 'enrol'), not with the token. These are the staff-side counterparts of the anonymous
-- policies of 2402: a challenge of purpose 'enrol' bound to the session and the principal, and the credential insert.
CREATE POLICY webauthn_challenge_staff_enrol_select ON identity.webauthn_challenge
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND purpose = 'enrol'
     AND id = (SELECT kernel.uuid1('app.webauthn_challenge_id'))
     AND principal_id = (SELECT kernel.uuid1('app.principal_id'))
     AND session_id = (SELECT kernel.uuid1('app.session_id')));
CREATE POLICY webauthn_challenge_staff_enrol_update ON identity.webauthn_challenge
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND purpose = 'enrol'
     AND id = (SELECT kernel.uuid1('app.webauthn_challenge_id'))
     AND principal_id = (SELECT kernel.uuid1('app.principal_id'))
     AND session_id = (SELECT kernel.uuid1('app.session_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY webauthn_challenge_staff_enrol_insert ON identity.webauthn_challenge
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND purpose = 'enrol'
     AND principal_id = (SELECT kernel.uuid1('app.principal_id'))
     AND session_id = (SELECT kernel.uuid1('app.session_id')));
-- The credential: own principal, and only from a live session that the enrolment created (amr 'enrol').
CREATE POLICY admin_credential_session_insert ON identity.admin_credential
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND principal_id = (SELECT kernel.uuid1('app.principal_id'))
     AND EXISTS (SELECT 1 FROM identity.session s
                 WHERE s.id = (SELECT kernel.uuid1('app.session_id')) AND s.revoked_at IS NULL AND 'enrol' = ANY (s.amr)));
