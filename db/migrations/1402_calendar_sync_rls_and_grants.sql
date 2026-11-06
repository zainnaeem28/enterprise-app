-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for calendar_sync (ARCHITECTURE 21.4, 22.9, 25.9;
-- ticket BE-14). Every policy names its roles (M-2) and requires the organisation.
--   calendar_link: T-PRINCIPAL for a google-realm doctor (own row), T-CONF admin read (the operations view), T-SYS for the worker.
--     The doctor's API role never reads sync_token or discarded_token_hash (column grants); it may reset sync_token to NULL on a re-link.
--   watch_channel, event_map: T-SYS only. No API role has any right on them (the push route verifies the HMAC token without a read).
--
-- Cross-module, additive and narrow (departure D2 in the module README): the OAuth callback runs as the doctor, and BD-11 lets the API
-- write an outbound secret reference, but the policies of 0401 let only the admin realm do so. Three policies allow a google-realm doctor
-- to see the one google_calendar connection and to write exactly the reference named 'cal-<own principal id>' of class outbound.

ALTER TABLE calendar_sync.calendar_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_sync.calendar_link FORCE  ROW LEVEL SECURITY;
ALTER TABLE calendar_sync.watch_channel ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_sync.watch_channel FORCE  ROW LEVEL SECURITY;
ALTER TABLE calendar_sync.event_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_sync.event_map FORCE  ROW LEVEL SECURITY;

-- calendar_link ---------------------------------------------------------------------------------------------------
CREATE POLICY calendar_link_own_select ON calendar_sync.calendar_link
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND calendar_link.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY calendar_link_admin_select ON calendar_sync.calendar_link
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY calendar_link_system_select ON calendar_sync.calendar_link
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY calendar_link_own_insert ON calendar_sync.calendar_link
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND calendar_link.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id'))
     AND status = 'pending_consent' AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY calendar_link_own_update ON calendar_sync.calendar_link
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND calendar_link.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND calendar_link.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY calendar_link_own_delete ON calendar_sync.calendar_link
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND calendar_link.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY calendar_link_system_update ON calendar_sync.calendar_link
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- watch_channel (worker only) -------------------------------------------------------------------------------------
CREATE POLICY watch_channel_system_select ON calendar_sync.watch_channel
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY watch_channel_system_insert ON calendar_sync.watch_channel
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY watch_channel_system_delete ON calendar_sync.watch_channel
  FOR DELETE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- event_map (worker only) -----------------------------------------------------------------------------------------
CREATE POLICY event_map_system_select ON calendar_sync.event_map
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY event_map_system_insert ON calendar_sync.event_map
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY event_map_system_update ON calendar_sync.event_map
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- Grants ----------------------------------------------------------------------------------------------------------
REVOKE ALL ON calendar_sync.calendar_link, calendar_sync.watch_channel, calendar_sync.event_map FROM PUBLIC;

GRANT SELECT (clinician_principal_id, organisation_id, google_calendar_id, status, token_secret_name, last_synced_at, last_error_code,
              created_at, row_version, updated_at)
  ON calendar_sync.calendar_link TO app_api;
GRANT INSERT (clinician_principal_id, organisation_id, google_calendar_id, status, token_secret_name, created_by)
  ON calendar_sync.calendar_link TO app_api;
GRANT UPDATE (google_calendar_id, status, sync_token, last_error_code) ON calendar_sync.calendar_link TO app_api;
GRANT DELETE ON calendar_sync.calendar_link TO app_api;
GRANT SELECT ON calendar_sync.calendar_link TO app_worker;
GRANT UPDATE (status, sync_token, discarded_token_hash, last_synced_at, last_error_code) ON calendar_sync.calendar_link TO app_worker;

GRANT SELECT, DELETE ON calendar_sync.watch_channel TO app_worker;
GRANT INSERT (id, organisation_id, clinician_principal_id, channel_id, resource_id, token_key_version, expires_at, created_by_job)
  ON calendar_sync.watch_channel TO app_worker;

GRANT SELECT ON calendar_sync.event_map TO app_worker;
GRANT INSERT (occupancy_id, organisation_id, clinician_principal_id, google_event_id, state, created_by_job)
  ON calendar_sync.event_map TO app_worker;
GRANT UPDATE (state) ON calendar_sync.event_map TO app_worker;

-- The doctor's OAuth callback (25.9, 29.3): see the google_calendar connection and write the own outbound token reference ---------
CREATE POLICY connection_calendar_select ON integration_core.connection
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND kind = 'google_calendar');
CREATE POLICY secret_ref_calendar_select ON integration_core.secret_ref
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND class = 'outbound' AND name = 'cal-' || (SELECT kernel.uuid1('app.principal_id'))::text
     AND EXISTS (SELECT 1 FROM integration_core.connection c WHERE c.id = secret_ref.connection_id AND c.kind = 'google_calendar'));
CREATE POLICY secret_ref_calendar_insert ON integration_core.secret_ref
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND class = 'outbound' AND name = 'cal-' || (SELECT kernel.uuid1('app.principal_id'))::text
     AND EXISTS (SELECT 1 FROM integration_core.connection c WHERE c.id = secret_ref.connection_id AND c.kind = 'google_calendar'));
CREATE POLICY secret_ref_calendar_update ON integration_core.secret_ref
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND class = 'outbound' AND name = 'cal-' || (SELECT kernel.uuid1('app.principal_id'))::text
     AND EXISTS (SELECT 1 FROM integration_core.connection c WHERE c.id = secret_ref.connection_id AND c.kind = 'google_calendar'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND class = 'outbound' AND name = 'cal-' || (SELECT kernel.uuid1('app.principal_id'))::text
     AND EXISTS (SELECT 1 FROM integration_core.connection c WHERE c.id = secret_ref.connection_id AND c.kind = 'google_calendar'));
