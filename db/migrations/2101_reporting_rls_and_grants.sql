-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and grants for the reporting read models (ARCHITECTURE 22.15, 21.4; M-1..M-4).
--   * writer: app_worker, audience system, job scope org (T-SYS). Insert, update and delete, because a refresh replaces the whole model.
--   * readers: app_api in the admin realm (T-CONF); the compliance summary only with the btg_grants slice (T-SLICE) and limited PHI access.
--   * reporting_ro: SELECT on the four operations tables only (22.15 lists it for them), by organisation. Its session sets app.org_id and
--     app.audience = 'system' (a read-only reporting session is not a patient, staff or anonymous caller), so its policies match neither
--     `anonymous` nor `public` (M-5). It gets no policy and no privilege on the compliance summary, and none on anything outside schema
--     reporting (M-4). It does not use kernel functions: it holds no right in schema kernel.
-- Whether the caller holds reporting.ops.read is the route guard's decision (27.2); the policies limit the realm.

ALTER TABLE reporting.ops_integration_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.ops_integration_health FORCE ROW LEVEL SECURITY;
ALTER TABLE reporting.ops_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.ops_queue FORCE ROW LEVEL SECURITY;
ALTER TABLE reporting.ops_calendar_staleness ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.ops_calendar_staleness FORCE ROW LEVEL SECURITY;
ALTER TABLE reporting.ops_alert_backlog ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.ops_alert_backlog FORCE ROW LEVEL SECURITY;
ALTER TABLE reporting.compliance_btg_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.compliance_btg_summary FORCE ROW LEVEL SECURITY;

CREATE POLICY ops_integration_health_admin_select ON reporting.ops_integration_health FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY ops_integration_health_ro_select ON reporting.ops_integration_health FOR SELECT TO reporting_ro
  USING (organisation_id::text = current_setting('app.org_id', true) AND current_setting('app.audience', true) = 'system');
CREATE POLICY ops_queue_admin_select ON reporting.ops_queue FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY ops_queue_ro_select ON reporting.ops_queue FOR SELECT TO reporting_ro
  USING (organisation_id::text = current_setting('app.org_id', true) AND current_setting('app.audience', true) = 'system');
CREATE POLICY ops_calendar_staleness_admin_select ON reporting.ops_calendar_staleness FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY ops_calendar_staleness_ro_select ON reporting.ops_calendar_staleness FOR SELECT TO reporting_ro
  USING (organisation_id::text = current_setting('app.org_id', true) AND current_setting('app.audience', true) = 'system');
CREATE POLICY ops_alert_backlog_admin_select ON reporting.ops_alert_backlog FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY ops_alert_backlog_ro_select ON reporting.ops_alert_backlog FOR SELECT TO reporting_ro
  USING (organisation_id::text = current_setting('app.org_id', true) AND current_setting('app.audience', true) = 'system');
CREATE POLICY ops_integration_health_system_all ON reporting.ops_integration_health FOR ALL TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY ops_queue_system_all ON reporting.ops_queue FOR ALL TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY ops_calendar_staleness_system_all ON reporting.ops_calendar_staleness FOR ALL TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY ops_alert_backlog_system_all ON reporting.ops_alert_backlog FOR ALL TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY compliance_btg_summary_system_all ON reporting.compliance_btg_summary FOR ALL TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

CREATE POLICY compliance_btg_summary_slice_select ON reporting.compliance_btg_summary
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND (SELECT kernel.setting('app.phi_access')) = 'limited'
     AND 'btg_grants' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));

REVOKE ALL ON ALL TABLES IN SCHEMA reporting FROM PUBLIC, app_api, app_worker, reporting_ro;
GRANT SELECT ON reporting.ops_integration_health, reporting.ops_queue, reporting.ops_calendar_staleness,
  reporting.ops_alert_backlog, reporting.compliance_btg_summary TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON reporting.ops_integration_health, reporting.ops_queue, reporting.ops_calendar_staleness,
  reporting.ops_alert_backlog, reporting.compliance_btg_summary TO app_worker;
GRANT SELECT ON reporting.ops_integration_health, reporting.ops_queue, reporting.ops_calendar_staleness,
  reporting.ops_alert_backlog TO reporting_ro;
