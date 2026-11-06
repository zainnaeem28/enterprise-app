-- migration-class: expand
-- FORCE ROW LEVEL SECURITY on every kernel table (M-1), role-targeted policies
-- (M-2, ARCHITECTURE 21.4 templates), and the least-privilege grants.
-- Every policy names its roles; none is TO PUBLIC. The org predicate is in every policy.

ALTER TABLE kernel.idempotency_key      ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.idempotency_key      FORCE  ROW LEVEL SECURITY;
ALTER TABLE kernel.setting              ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.setting              FORCE  ROW LEVEL SECURITY;
ALTER TABLE kernel.reference_data_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.reference_data_version FORCE  ROW LEVEL SECURITY;
ALTER TABLE kernel.rate_counter         ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.rate_counter         FORCE  ROW LEVEL SECURITY;

-- kernel.idempotency_key ---------------------------------------------------
-- T-PRINCIPAL: a principal sees and writes only its own keys (a stored response may hold PHI).
-- Authenticated audiences only: anonymous and public transactions have no principal (M-5 audience lists).
CREATE POLICY idempotency_key_principal ON kernel.idempotency_key
  FOR ALL TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
     AND principal_id = (SELECT kernel.uuid1('app.principal_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
     AND principal_id = (SELECT kernel.uuid1('app.principal_id')));
-- T-SYS (organisation-wide job): the purge job reads and deletes expired keys.
CREATE POLICY idempotency_key_system_select ON kernel.idempotency_key
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY idempotency_key_system_delete ON kernel.idempotency_key
  FOR DELETE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- kernel.setting -----------------------------------------------------------
-- T-CONF read: authenticated audiences only. Audience 'system' counts only for app_worker (6.2).
-- Never 'anonymous' or 'public' except the pre_auth rows below.
CREATE POLICY setting_read ON kernel.setting
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
-- anonymous SELECT where pre_auth (draft 7, TDR-11): session lifetimes, sign-in limits, egress CIDRs.
CREATE POLICY setting_read_pre_auth ON kernel.setting
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'anonymous'
     AND pre_auth);
-- T-CONF write: admin_pool staff, or the worker as 'system'. The admin API never sets pre_auth.
CREATE POLICY setting_insert ON kernel.setting
  FOR INSERT TO app_api, app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND NOT pre_auth)
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY setting_update ON kernel.setting
  FOR UPDATE TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND NOT pre_auth)
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND NOT pre_auth)
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY setting_delete ON kernel.setting
  FOR DELETE TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND NOT pre_auth)
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));

-- kernel.reference_data_version --------------------------------------------
CREATE POLICY reference_data_version_read ON kernel.reference_data_version
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY reference_data_version_system_insert ON kernel.reference_data_version
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY reference_data_version_system_update ON kernel.reference_data_version
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- kernel.rate_counter ------------------------------------------------------
-- The one rule (TDR-08): organisation only, for every audience including anonymous. Keys are keyed hashes.
CREATE POLICY rate_counter_org ON kernel.rate_counter
  FOR ALL TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')));

-- Grants: nothing to PUBLIC; app_owner owns the tables and is not granted DML. ----------
REVOKE ALL ON kernel.idempotency_key, kernel.setting, kernel.reference_data_version, kernel.rate_counter FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE         ON kernel.idempotency_key        TO app_api;
GRANT SELECT, DELETE                 ON kernel.idempotency_key        TO app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.setting                TO app_api, app_worker;
GRANT SELECT                         ON kernel.reference_data_version TO app_api;
GRANT SELECT, INSERT, UPDATE         ON kernel.reference_data_version TO app_worker;
GRANT SELECT, INSERT, UPDATE         ON kernel.rate_counter           TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.rate_counter           TO app_worker;
