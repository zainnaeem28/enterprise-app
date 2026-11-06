-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for notifications (ARCHITECTURE 21.4, 22.13).
--
-- Deferred on purpose (same reason as identity 0502): T-STAFF needs patient.staff_scope, which arrives with BE-08. Until
-- then a `google`-realm session can neither read nor cancel patient-recipient notifications, and cannot read delivery
-- receipts; it can only insert a queued notification (send() works) and read its own principal notices. BE-08/INT-01
-- adds the T-STAFF SELECT/UPDATE policies on notification and SELECT on delivery_receipt. Nothing here matches `anonymous`
-- or `public`.

ALTER TABLE notifications.template ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications.template FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications.notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications.notification FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications.delivery_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications.delivery_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications.in_app_read ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications.in_app_read FORCE ROW LEVEL SECURITY;

-- template: plain T-CONF read (21.4: "used only where a patient transaction needs the rows": send() validates the
-- template inside the booking transaction). Templates are PHI-free configuration. Writes: admin_pool only.
CREATE POLICY template_select ON notifications.template
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient'));
CREATE POLICY template_system_select ON notifications.template
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY template_admin_insert ON notifications.template
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND status = 'draft');
CREATE POLICY template_admin_update ON notifications.template
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY template_admin_delete ON notifications.template
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND status = 'draft');

-- notification
CREATE POLICY notification_patient_select ON notifications.notification
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND channel = 'in_app'
     AND patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY notification_principal_select ON notifications.notification
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND recipient_kind = 'principal'
     AND principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY notification_system_select ON notifications.notification
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- send(): any authenticated API audience inserts a QUEUED row for the patient it acts for; a worker inserts under T-SYS.
CREATE POLICY notification_patient_insert ON notifications.notification
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND recipient_kind = 'patient'
     AND patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND status = 'queued' AND attempts = 0);
CREATE POLICY notification_staff_insert ON notifications.notification
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff'
     AND (recipient_kind = 'principal' OR (SELECT kernel.setting('app.realm')) = 'google')
     AND status = 'queued' AND attempts = 0);
CREATE POLICY notification_system_insert ON notifications.notification
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- cancel(): a patient cancels the in-app rows it can see; the worker updates anything in its job scope.
CREATE POLICY notification_patient_cancel ON notifications.notification
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND channel = 'in_app'
     AND patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids'))
     AND status IN ('queued', 'failed'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND status = 'cancelled');
CREATE POLICY notification_system_update ON notifications.notification
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- delivery_receipt: the inbound handler (worker) writes and reads; T-STAFF read arrives with BE-08.
CREATE POLICY delivery_receipt_system_select ON notifications.delivery_receipt
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY delivery_receipt_system_insert ON notifications.delivery_receipt
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- in_app_read: the patient (own, not a proxy) reads and inserts; the worker reads.
CREATE POLICY in_app_read_patient_select ON notifications.in_app_read
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY in_app_read_patient_insert ON notifications.in_app_read
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND patient_id = ANY (kernel.uuids('app.patient_ids'))
     AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY in_app_read_system_select ON notifications.in_app_read
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- Grants ---------------------------------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA notifications FROM PUBLIC;
GRANT SELECT ON notifications.template TO app_api, app_worker;
GRANT INSERT (id, organisation_id, key, channel, language, version, subject, body, variables, status, created_by) ON notifications.template TO app_api;
GRANT UPDATE (subject, body, variables, status, render_check_passed_at, published_at) ON notifications.template TO app_api;
GRANT DELETE ON notifications.template TO app_api;

GRANT SELECT ON notifications.notification TO app_api, app_worker;
GRANT INSERT (id, organisation_id, recipient_kind, patient_id, principal_id, template_key, template_version, channel, language,
              variables, status, attempts, send_after, dedupe_key, created_by) ON notifications.notification TO app_api;
GRANT INSERT (id, organisation_id, recipient_kind, patient_id, principal_id, template_key, template_version, channel, language,
              variables, status, attempts, send_after, dedupe_key, created_by_job) ON notifications.notification TO app_worker;
-- api: cancel only. worker: the send outcome and the merge re-point (patient_id).
GRANT UPDATE (status) ON notifications.notification TO app_api;
GRANT UPDATE (status, suppress_reason, error_class, provider_message_id, attempts, send_after, sent_at, language, patient_id)
  ON notifications.notification TO app_worker;

GRANT SELECT ON notifications.delivery_receipt TO app_worker;
GRANT INSERT (id, organisation_id, notification_id, patient_id, status, received_at, vendor_event_id, created_by_job)
  ON notifications.delivery_receipt TO app_worker;

GRANT SELECT ON notifications.in_app_read TO app_api, app_worker;
GRANT INSERT (notification_id, organisation_id, patient_id, read_at, created_by) ON notifications.in_app_read TO app_api;
