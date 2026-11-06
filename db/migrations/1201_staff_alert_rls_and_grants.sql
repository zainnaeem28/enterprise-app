-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for the staff-alert tables (ARCHITECTURE
-- 22.13, 21.4; ticket BE-07).
--
-- T-STAFF (SHARED-BOUNDARIES 6.1: "this staff member may see this patient") needs `patient.staff_scope`, which arrives with
-- BE-08 (same deferral as 0601 NOT-N3 and identity 0502). Until then `notifications.staff_scope_allows_patient` returns
-- FALSE, so the policies FAIL CLOSED: a staff session reads, acknowledges and creates only alerts without a patient, and
-- a patient-bound alert (red_flag, note_unsigned) is invisible to every staff session. BE-08 or INT-02 replaces the body of
-- this one function with the `patient.staff_scope` check (CREATE OR REPLACE, no policy change). Nothing here matches
-- `anonymous` or `public`.

CREATE FUNCTION notifications.staff_scope_allows_patient(patient uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT false $$;
REVOKE ALL ON FUNCTION notifications.staff_scope_allows_patient(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notifications.staff_scope_allows_patient(uuid) TO app_api;

ALTER TABLE notifications.staff_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications.staff_alert FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications.staff_alert_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications.staff_alert_event FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications.staff_alert_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications.staff_alert_setting FORCE ROW LEVEL SECURITY;

-- staff_alert, staff --------------------------------------------------------------------------------------------
-- SELECT: the targets (and, below, the creator).
CREATE POLICY staff_alert_target_select ON notifications.staff_alert
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff'
     AND (SELECT kernel.uuid1('app.principal_id')) = ANY (target_principal_ids)
     AND (patient_id IS NULL OR notifications.staff_scope_allows_patient(patient_id)));
CREATE POLICY staff_alert_creator_select ON notifications.staff_alert
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff'
     AND created_by = (SELECT kernel.uuid1('app.principal_id'))
     AND patient_id IS NOT NULL AND notifications.staff_scope_allows_patient(patient_id));
-- INSERT (draft 6 AF-02, draft 7 TDR-12): only a red flag, only realm google, only for a patient in scope. The creator is
-- usually not a target, so there is no target condition. Every other type is written by a worker under T-SYS.
CREATE POLICY staff_alert_staff_insert ON notifications.staff_alert
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND type = 'red_flag' AND patient_id IS NOT NULL AND notifications.staff_scope_allows_patient(patient_id)
     AND created_by = (SELECT kernel.uuid1('app.principal_id'))
     AND status = 'open' AND escalation_level = 0 AND acknowledged_by IS NULL);
-- UPDATE: a target acknowledges. The column grant limits the columns; the check limits the values.
CREATE POLICY staff_alert_target_acknowledge ON notifications.staff_alert
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff'
     AND (SELECT kernel.uuid1('app.principal_id')) = ANY (target_principal_ids)
     AND (patient_id IS NULL OR notifications.staff_scope_allows_patient(patient_id)))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND status = 'acknowledged' AND acknowledged_by = (SELECT kernel.uuid1('app.principal_id'))
     AND escalate_at IS NULL);

-- staff_alert, system (worker) ----------------------------------------------------------------------------------
CREATE POLICY staff_alert_system_select ON notifications.staff_alert
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY staff_alert_system_insert ON notifications.staff_alert
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY staff_alert_system_update ON notifications.staff_alert
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- staff_alert_event ----------------------------------------------------------------------------------------------
-- SELECT as staff_alert: the sub-select runs under the alert's own read policies.
CREATE POLICY staff_alert_event_select ON notifications.staff_alert_event
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff'
     AND EXISTS (SELECT 1 FROM notifications.staff_alert a WHERE a.id = staff_alert_event.alert_id));
-- INSERT (draft 7 TDR-12): own principal; `created` by the creator of a red flag; `delivered`, `acknowledged`, `closed` by a
-- target. `escalated` and every event of a non-staff type is T-SYS only.
CREATE POLICY staff_alert_event_staff_insert ON notifications.staff_alert_event
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff'
     AND principal_id = (SELECT kernel.uuid1('app.principal_id'))
     AND EXISTS (SELECT 1 FROM notifications.staff_alert a
                  WHERE a.id = staff_alert_event.alert_id
                    AND a.patient_id IS NOT DISTINCT FROM staff_alert_event.patient_id
                    AND ((kind = 'created' AND a.created_by = (SELECT kernel.uuid1('app.principal_id')) AND a.type = 'red_flag')
                      OR (kind IN ('delivered', 'acknowledged', 'closed')
                          AND (SELECT kernel.uuid1('app.principal_id')) = ANY (a.target_principal_ids)))));
CREATE POLICY staff_alert_event_system_select ON notifications.staff_alert_event
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY staff_alert_event_system_insert ON notifications.staff_alert_event
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- staff_alert_setting: T-CONF(staff) read; the admin realm writes (configuration, audited by the service).
CREATE POLICY staff_alert_setting_select ON notifications.staff_alert_setting
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff');
CREATE POLICY staff_alert_setting_admin_insert ON notifications.staff_alert_setting
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY staff_alert_setting_admin_update ON notifications.staff_alert_setting
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY staff_alert_setting_admin_delete ON notifications.staff_alert_setting
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY staff_alert_setting_system_select ON notifications.staff_alert_setting
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system');

-- Grants ---------------------------------------------------------------------------------------------------------
REVOKE ALL ON notifications.staff_alert, notifications.staff_alert_event, notifications.staff_alert_setting FROM PUBLIC;
GRANT SELECT ON notifications.staff_alert, notifications.staff_alert_event, notifications.staff_alert_setting TO app_api, app_worker;

GRANT INSERT (id, organisation_id, type, severity, patient_id, resource_type, resource_id, location_id, target_kind,
              target_principal_ids, target_role_key, target_location_ids, target_permission, status, escalation_level,
              escalate_at, created_by) ON notifications.staff_alert TO app_api;
GRANT INSERT (id, organisation_id, type, severity, patient_id, resource_type, resource_id, location_id, target_kind,
              target_principal_ids, target_role_key, target_location_ids, target_permission, status, escalation_level,
              escalate_at, created_by_job) ON notifications.staff_alert TO app_worker;
-- api: acknowledge only. worker: escalate, add targets, close, and re-point on merge (patient_id).
GRANT UPDATE (status, acknowledged_by, acknowledged_at, escalate_at) ON notifications.staff_alert TO app_api;
GRANT UPDATE (status, escalation_level, escalate_at, target_principal_ids, patient_id) ON notifications.staff_alert TO app_worker;

GRANT INSERT (id, organisation_id, alert_id, patient_id, kind, principal_id, at, created_by) ON notifications.staff_alert_event TO app_api;
GRANT INSERT (id, organisation_id, alert_id, patient_id, kind, principal_id, at, created_by_job) ON notifications.staff_alert_event TO app_worker;

GRANT INSERT (id, organisation_id, alert_type, location_id, escalate_after_min, escalate_to_duty, created_by) ON notifications.staff_alert_setting TO app_api;
GRANT UPDATE (escalate_after_min, escalate_to_duty) ON notifications.staff_alert_setting TO app_api;
GRANT DELETE ON notifications.staff_alert_setting TO app_api;
