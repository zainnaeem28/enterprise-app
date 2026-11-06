-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for integration_core (ARCHITECTURE 21.4:
-- T-CONF(admin) for the admin API, T-SYS for jobs) and the BD-11 write split: `outbound` references are written by app_api
-- (an admin-realm principal), `inbound_verification` references by app_worker only. Every policy names its roles and carries
-- the organisation predicate and an audience condition, so no policy here can match `anonymous` or `public`; the webhook
-- transaction reaches inbound_message only through the definer function of 0402. That one policy (inbound_message_receive)
-- is the single exception: a webhook has no session, so it runs with no audience or `anonymous`; it is TO
-- integration_receiver_owner only and the function refuses every other audience (open note INT-N1 in the module README).
-- Whether the admin has an active elevation grant is checked by the route guard (25.8); the policy limits the realm.

ALTER TABLE integration_core.connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_core.connection FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_core.secret_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_core.secret_ref FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_core.secret_change_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_core.secret_change_request FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_core.outbound_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_core.outbound_call FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_core.inbound_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_core.inbound_message FORCE ROW LEVEL SECURITY;

CREATE POLICY connection_admin_select ON integration_core.connection
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY connection_system_select ON integration_core.connection
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY connection_admin_insert ON integration_core.connection
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY connection_admin_update ON integration_core.connection
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY connection_system_update ON integration_core.connection
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY secret_ref_admin_select ON integration_core.secret_ref
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY secret_ref_system_select ON integration_core.secret_ref
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY secret_ref_outbound_insert ON integration_core.secret_ref
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND class = 'outbound');
CREATE POLICY secret_ref_outbound_update ON integration_core.secret_ref
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND class = 'outbound')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND class = 'outbound');
CREATE POLICY secret_ref_inbound_insert ON integration_core.secret_ref
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org'
     AND class = 'inbound_verification');
CREATE POLICY secret_ref_inbound_update ON integration_core.secret_ref
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org'
     AND class = 'inbound_verification')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org'
     AND class = 'inbound_verification');
CREATE POLICY scr_admin_select ON integration_core.secret_change_request
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY scr_system_select ON integration_core.secret_change_request
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY scr_admin_insert ON integration_core.secret_change_request
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND requester_person_id = (SELECT kernel.uuid1('app.person_id'))
     AND status = 'requested' AND approver_person_id IS NULL);
CREATE POLICY scr_admin_decide ON integration_core.secret_change_request
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND status = 'requested')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND status IN ('approved', 'rejected') AND approver_person_id = (SELECT kernel.uuid1('app.person_id'))
     AND approver_person_id <> requester_person_id);
CREATE POLICY scr_system_apply ON integration_core.secret_change_request
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org'
     AND status IN ('requested', 'approved'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org'
     AND status IN ('applied', 'rejected', 'expired'));
CREATE POLICY outbound_call_admin_select ON integration_core.outbound_call
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY outbound_call_system_select ON integration_core.outbound_call
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY outbound_call_system_insert ON integration_core.outbound_call
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY outbound_call_system_update ON integration_core.outbound_call
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org'
     AND outcome = 'pending')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY inbound_message_receive ON integration_core.inbound_message
  FOR INSERT TO integration_receiver_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND coalesce((SELECT kernel.setting('app.audience')), '') IN ('', 'anonymous')
     AND status = 'received' AND handler IS NULL);
CREATE POLICY inbound_message_system_select ON integration_core.inbound_message
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY inbound_message_system_update ON integration_core.inbound_message
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- Grants ----------------------------------------------------------------------------------------------------------
-- Nothing to PUBLIC or app_owner (revoked in 0400). Column-level grants keep each writer to the columns its path owns.
GRANT SELECT ON integration_core.connection, integration_core.secret_ref, integration_core.secret_change_request,
  integration_core.outbound_call TO app_api, app_worker;
GRANT INSERT (id, organisation_id, kind, vendor, settings, enabled, created_by) ON integration_core.connection TO app_api;
GRANT UPDATE (vendor, settings, enabled) ON integration_core.connection TO app_api;
GRANT UPDATE (health, health_changed_at, last_test_at, last_test_result) ON integration_core.connection TO app_worker;

GRANT INSERT (connection_id, name, organisation_id, class, secret_arn, current_version_id, rotated_at, rotated_by_person_id, created_by)
  ON integration_core.secret_ref TO app_api;
GRANT UPDATE (secret_arn, current_version_id, rotated_at, rotated_by_person_id) ON integration_core.secret_ref TO app_api;
GRANT INSERT (connection_id, name, organisation_id, class, secret_arn, current_version_id, rotated_at, created_by_job)
  ON integration_core.secret_ref TO app_worker;
GRANT UPDATE (secret_arn, current_version_id, rotated_at) ON integration_core.secret_ref TO app_worker;

GRANT INSERT (id, organisation_id, connection_id, name, requester_person_id, request_hash, canonical_request, expires_at,
              requester_assertion, created_by)
  ON integration_core.secret_change_request TO app_api;
GRANT UPDATE (status, approver_person_id, decided_at, approver_assertion) ON integration_core.secret_change_request TO app_api;
GRANT UPDATE (status, job_id, applied_version_id, applied_at) ON integration_core.secret_change_request TO app_worker;

GRANT INSERT ON integration_core.outbound_call TO app_worker;
GRANT UPDATE (outcome, error_class, http_status, latency_ms, vendor_ref) ON integration_core.outbound_call TO app_worker;

-- inbound_message: the definer owner (integration_receiver_owner, 0402) inserts through its own rights and the policy above;
-- the worker reads and moves the status. app_api has no right at all.
GRANT SELECT ON integration_core.inbound_message TO app_worker;
GRANT UPDATE (status, handler, error_class, handled_at, attempts) ON integration_core.inbound_message TO app_worker;
