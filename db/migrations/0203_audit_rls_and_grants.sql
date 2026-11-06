-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies (ARCHITECTURE 21.4 templates T-SLICE, T-SYS, T-PRINCIPAL) and the
-- least-privilege grants of the audit tables (section 6 "Grants"; SAR-07). Every policy names its roles, carries the
-- organisation predicate and an audience condition, so no audit policy can match `anonymous` or `public` (21.3 list).
--
-- Audit INSERT is allowed for the authenticated audiences and for `system` (app_worker only). Events of an
-- unauthenticated request (a failed sign-in) cannot be written under the complete anonymous list of 21.3: see the module
-- README, open note AUD-N1.
--
-- No role gets UPDATE or DELETE on audit.event or audit.anchor, and audit_archiver gets nothing here (its partition
-- procedure is DO-09b, design only). RETURNING on an audit INSERT needs a SELECT policy too, so the module never uses it.

ALTER TABLE audit.event      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.event      FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit.anchor     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.anchor     FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit.btg_grant  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.btg_grant  FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit.btg_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.btg_review FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit.export_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.export_job FORCE  ROW LEVEL SECURITY;

-- audit.event ---------------------------------------------------------------
CREATE POLICY event_insert ON audit.event
  FOR INSERT TO app_api, app_worker, scheduling_booking_owner, patient_scope_owner, patient_match_owner, integration_receiver_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
-- T-SLICE(audit_events): the compliance officer's audit viewer.
CREATE POLICY event_slice_select ON audit.event
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND (SELECT kernel.setting('app.phi_access')) = 'limited'
     AND 'audit_events' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));
-- T-SYS: anchoring, verification and export read every row of the organisation.
CREATE POLICY event_system_select ON audit.event
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- audit.anchor --------------------------------------------------------------
CREATE POLICY anchor_system_insert ON audit.anchor
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'));
CREATE POLICY anchor_system_select ON audit.anchor
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'));
CREATE POLICY anchor_slice_select ON audit.anchor
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND (SELECT kernel.setting('app.phi_access')) = 'limited'
     AND 'audit_events' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));

-- audit.btg_grant -----------------------------------------------------------
-- T-PRINCIPAL: the holder reads its own grants (the scope build reads the active ones, activeBtgGrants).
CREATE POLICY btg_grant_principal_select ON audit.btg_grant
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff'
     AND holder_principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY btg_grant_slice_select ON audit.btg_grant
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND (SELECT kernel.setting('app.phi_access')) = 'limited'
     AND 'btg_grants' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));
CREATE POLICY btg_grant_system_select ON audit.btg_grant
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- openBtg: a staff principal opens a grant for itself, never for anyone else.
CREATE POLICY btg_grant_open ON audit.btg_grant
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff'
     AND holder_principal_id = (SELECT kernel.uuid1('app.principal_id'))
     AND holder_person_id = (SELECT kernel.uuid1('app.person_id'))
     AND holder_realm = (SELECT kernel.setting('app.realm'))
     AND review_status = 'pending' AND revoked_at IS NULL);
-- reviewBtg: review fields only, compliance slice only.
CREATE POLICY btg_grant_review ON audit.btg_grant
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND (SELECT kernel.setting('app.phi_access')) = 'limited'
     AND 'btg_grants' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND (SELECT kernel.setting('app.phi_access')) = 'limited'
     AND 'btg_grants' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));

-- audit.btg_review ----------------------------------------------------------
CREATE POLICY btg_review_slice_select ON audit.btg_review
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND (SELECT kernel.setting('app.phi_access')) = 'limited'
     AND 'btg_grants' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));
CREATE POLICY btg_review_slice_insert ON audit.btg_review
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND (SELECT kernel.setting('app.phi_access')) = 'limited'
     AND 'btg_grants' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ','))
     AND reviewer_person_id = (SELECT kernel.uuid1('app.person_id')));

-- audit.export_job ----------------------------------------------------------
CREATE POLICY export_job_slice_select ON audit.export_job
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND (SELECT kernel.setting('app.phi_access')) = 'limited'
     AND 'audit_events' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));
CREATE POLICY export_job_slice_insert ON audit.export_job
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND (SELECT kernel.setting('app.phi_access')) = 'limited'
     AND 'audit_events' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ','))
     AND requested_by_person_id = (SELECT kernel.uuid1('app.person_id'))
     AND status = 'queued');
CREATE POLICY export_job_system_select ON audit.export_job
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'));
CREATE POLICY export_job_system_update ON audit.export_job
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'));

-- Grants ----------------------------------------------------------------------
-- Nothing to PUBLIC, nothing to app_owner (revoked in 0200-0202). Insert and select only on the event and the anchor.
GRANT INSERT, SELECT ON audit.event TO app_api, app_worker;
GRANT INSERT ON audit.event TO scheduling_booking_owner, patient_scope_owner, patient_match_owner, integration_receiver_owner;
GRANT INSERT, SELECT ON audit.anchor TO app_worker;
GRANT SELECT ON audit.anchor TO app_api;
GRANT SELECT, INSERT ON audit.btg_grant TO app_api;
GRANT UPDATE (review_status, revoked_at) ON audit.btg_grant TO app_api;
GRANT SELECT ON audit.btg_grant TO app_worker;
GRANT SELECT, INSERT ON audit.btg_review TO app_api;
GRANT SELECT, INSERT ON audit.export_job TO app_api;
GRANT SELECT ON audit.export_job TO app_worker;
GRANT UPDATE (status, row_count, object_key, expires_at, last_occurred_at, last_event_id, chunks_done)
  ON audit.export_job TO app_worker;
