-- migration-class: expand
-- Owner ruling 2026-11-11 (C) item 4, D-2 / C-06 (HEAAA-793): an administrator records each clinician's licensed states through
-- PUT /admin/staff-profiles/{principalId}. Until now identity.licensed_state was read-only for app_api (0502), so the rows could only be
-- written by a fixture. This file lets the admin_pool staff scope (the same predicate as organisation.operating_state, 0301) insert,
-- update and delete rows of its own organisation, and nothing else: the patient, partner and system scopes keep their read-only policies,
-- and app_worker gets no write. No row is inserted here (SBR-17): the organisation enters the real values at go-live.
-- Down-note (forward-only): DROP the three policies and REVOKE INSERT, UPDATE, DELETE ON identity.licensed_state FROM app_api.

CREATE POLICY licensed_state_admin_insert ON identity.licensed_state
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY licensed_state_admin_update ON identity.licensed_state
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY licensed_state_admin_delete ON identity.licensed_state
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');

GRANT INSERT, DELETE ON identity.licensed_state TO app_api;
GRANT UPDATE (licence_number, expires_on) ON identity.licensed_state TO app_api;
