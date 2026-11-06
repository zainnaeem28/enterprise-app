-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for the availability tables (ARCHITECTURE 21.4, 22.8;
-- ticket BE-12). Every policy names its roles (M-2) and requires the organisation.
--   availability_template, template_rule, blocked_time: T-CONF-STAFF(own). Read: the authenticated audiences staff and patient (slot
--     search runs in the caller's own transaction, so a patient transaction reads the periods; the API never returns kind or note to a
--     patient) and the system worker. Write: the admin realm, or a google-realm staff member for rows whose clinician is themselves.
--   busy_block: T-CONF read; no application role writes it here. Its writer is calendar-sync (BE-14), through a function.
--   roster_entry: T-CONF-STAFF(loc), read narrowed to staff and system (no patient need). Write: the admin realm, or a google-realm
--     staff member for their own locations and never for compliance_on_call.
-- The API guard still checks the permission and, on the staff routes, that {id} is the session's own principal (403).

ALTER TABLE scheduling.availability_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.availability_template FORCE  ROW LEVEL SECURITY;
ALTER TABLE scheduling.template_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.template_rule FORCE  ROW LEVEL SECURITY;
ALTER TABLE scheduling.blocked_time ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.blocked_time FORCE  ROW LEVEL SECURITY;
ALTER TABLE scheduling.busy_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.busy_block FORCE  ROW LEVEL SECURITY;
ALTER TABLE scheduling.roster_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.roster_entry FORCE  ROW LEVEL SECURITY;

CREATE POLICY availability_template_api_select ON scheduling.availability_template
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient'));
CREATE POLICY availability_template_system_select ON scheduling.availability_template
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY template_rule_api_select ON scheduling.template_rule
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient'));
CREATE POLICY template_rule_system_select ON scheduling.template_rule
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY blocked_time_api_select ON scheduling.blocked_time
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient'));
CREATE POLICY blocked_time_system_select ON scheduling.blocked_time
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY busy_block_api_select ON scheduling.busy_block
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient'));
CREATE POLICY busy_block_system_select ON scheduling.busy_block
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY roster_entry_api_select ON scheduling.roster_entry
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff');
CREATE POLICY roster_entry_system_select ON scheduling.roster_entry
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system');

CREATE POLICY availability_template_write_insert ON scheduling.availability_template
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool') OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND availability_template.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))));
CREATE POLICY availability_template_write_update ON scheduling.availability_template
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool') OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND availability_template.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool') OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND availability_template.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))));
CREATE POLICY template_rule_write_insert ON scheduling.template_rule
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool') OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND template_rule.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))));
CREATE POLICY template_rule_write_delete ON scheduling.template_rule
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool') OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND template_rule.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))));
CREATE POLICY blocked_time_write_insert ON scheduling.blocked_time
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool') OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND blocked_time.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))));
CREATE POLICY blocked_time_write_update ON scheduling.blocked_time
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool') OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND blocked_time.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool') OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND blocked_time.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))));
CREATE POLICY blocked_time_write_delete ON scheduling.blocked_time
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool') OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND blocked_time.clinician_principal_id = (SELECT kernel.uuid1('app.principal_id')))));
CREATE POLICY roster_entry_write_insert ON scheduling.roster_entry
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool') OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND roster_entry.location_id = ANY (kernel.uuids('app.location_ids')) AND roster_entry.duty <> 'compliance_on_call')));
CREATE POLICY roster_entry_write_update ON scheduling.roster_entry
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool') OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND roster_entry.location_id = ANY (kernel.uuids('app.location_ids')) AND roster_entry.duty <> 'compliance_on_call')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool') OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND roster_entry.location_id = ANY (kernel.uuids('app.location_ids')) AND roster_entry.duty <> 'compliance_on_call')));
CREATE POLICY roster_entry_write_delete ON scheduling.roster_entry
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool') OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND roster_entry.location_id = ANY (kernel.uuids('app.location_ids')) AND roster_entry.duty <> 'compliance_on_call')));

-- Grants -------------------------------------------------------------------------------------------------------------
REVOKE ALL ON scheduling.availability_template, scheduling.template_rule, scheduling.blocked_time, scheduling.busy_block, scheduling.roster_entry FROM PUBLIC;

GRANT SELECT ON scheduling.availability_template, scheduling.template_rule, scheduling.blocked_time, scheduling.busy_block, scheduling.roster_entry TO app_api, app_worker;

GRANT INSERT (id, organisation_id, clinician_principal_id, location_id, valid_from, valid_to, status, created_by)
  ON scheduling.availability_template TO app_api;
GRANT UPDATE (location_id, valid_from, valid_to, status) ON scheduling.availability_template TO app_api;

-- A template is replaced by deleting and inserting its rules, never by updating one in place.
GRANT INSERT (id, organisation_id, template_id, clinician_principal_id, weekday, start_local, end_local, service_ids, mode, room_id, overbookable, created_by)
  ON scheduling.template_rule TO app_api;
GRANT DELETE ON scheduling.template_rule TO app_api;

GRANT INSERT (id, organisation_id, clinician_principal_id, period, kind, note, created_by) ON scheduling.blocked_time TO app_api;
GRANT UPDATE (period, kind, note) ON scheduling.blocked_time TO app_api;
GRANT DELETE ON scheduling.blocked_time TO app_api;

GRANT INSERT (id, organisation_id, location_id, duty, principal_id, period, created_by) ON scheduling.roster_entry TO app_api;
GRANT UPDATE (principal_id, period) ON scheduling.roster_entry TO app_api;
GRANT DELETE ON scheduling.roster_entry TO app_api;
