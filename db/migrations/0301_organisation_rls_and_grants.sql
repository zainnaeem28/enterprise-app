-- migration-class: expand
-- FORCE ROW LEVEL SECURITY on the organisation tables (M-1), role-targeted policies (M-2; templates T-CONF and
-- T-CONF(staff) of ARCHITECTURE 21.4) and least-privilege grants (ticket BE-03).
-- Read: T-CONF for configuration a patient transaction needs (booking policy, operating states, templates, flags, C0 reference
-- rows); T-CONF(staff) for the C1 catalogue rows patients must not read from base tables (room, service with internal_name and
-- prices, service links): patients read services and links only through the C0 views of 22.5.1 (0302).
-- Write: audience staff with realm admin_pool (API guard checks the permission), never anything else. The worker writes only
-- the reference data (jurisdiction) as audience system. Nothing here matches audience anonymous or public (21.3).

ALTER TABLE organisation.organisation ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.organisation FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.jurisdiction ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.jurisdiction FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.location ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.location FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.room ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.room FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.opening_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.opening_hours FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.holiday ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.holiday FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.service ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.service FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.service_location ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.service_location FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.service_clinician ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.service_clinician FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.booking_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.booking_policy FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.consent_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.consent_template FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.questionnaire_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.questionnaire_template FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.service_required_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.service_required_consent FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.feature_flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.feature_flag FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.banner ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.banner FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation.operating_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation.operating_state FORCE  ROW LEVEL SECURITY;

-- organisation.organisation
CREATE POLICY organisation_read ON organisation.organisation
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY organisation_admin_insert ON organisation.organisation
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY organisation_admin_update ON organisation.organisation
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY organisation_admin_delete ON organisation.organisation
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.jurisdiction
CREATE POLICY jurisdiction_read ON organisation.jurisdiction
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY jurisdiction_admin_insert ON organisation.jurisdiction
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY jurisdiction_admin_update ON organisation.jurisdiction
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY jurisdiction_admin_delete ON organisation.jurisdiction
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY jurisdiction_system_insert ON organisation.jurisdiction
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY jurisdiction_system_update ON organisation.jurisdiction
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- organisation.location
CREATE POLICY location_read ON organisation.location
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY location_admin_insert ON organisation.location
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY location_admin_update ON organisation.location
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY location_admin_delete ON organisation.location
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.room
CREATE POLICY room_read ON organisation.room
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) = 'staff'
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY room_admin_insert ON organisation.room
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY room_admin_update ON organisation.room
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY room_admin_delete ON organisation.room
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.opening_hours
CREATE POLICY opening_hours_read ON organisation.opening_hours
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY opening_hours_admin_insert ON organisation.opening_hours
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY opening_hours_admin_update ON organisation.opening_hours
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY opening_hours_admin_delete ON organisation.opening_hours
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.holiday
CREATE POLICY holiday_read ON organisation.holiday
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY holiday_admin_insert ON organisation.holiday
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY holiday_admin_update ON organisation.holiday
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY holiday_admin_delete ON organisation.holiday
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.service
CREATE POLICY service_read ON organisation.service
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) = 'staff'
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY service_admin_insert ON organisation.service
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY service_admin_update ON organisation.service
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY service_admin_delete ON organisation.service
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.service_location
CREATE POLICY service_location_read ON organisation.service_location
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) = 'staff'
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY service_location_admin_insert ON organisation.service_location
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY service_location_admin_update ON organisation.service_location
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY service_location_admin_delete ON organisation.service_location
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.service_clinician
CREATE POLICY service_clinician_read ON organisation.service_clinician
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) = 'staff'
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY service_clinician_admin_insert ON organisation.service_clinician
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY service_clinician_admin_update ON organisation.service_clinician
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY service_clinician_admin_delete ON organisation.service_clinician
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.booking_policy
CREATE POLICY booking_policy_read ON organisation.booking_policy
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY booking_policy_admin_insert ON organisation.booking_policy
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY booking_policy_admin_update ON organisation.booking_policy
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY booking_policy_admin_delete ON organisation.booking_policy
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.consent_template
CREATE POLICY consent_template_read ON organisation.consent_template
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY consent_template_admin_insert ON organisation.consent_template
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY consent_template_admin_update ON organisation.consent_template
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY consent_template_admin_delete ON organisation.consent_template
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.questionnaire_template
CREATE POLICY questionnaire_template_read ON organisation.questionnaire_template
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY questionnaire_template_admin_insert ON organisation.questionnaire_template
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY questionnaire_template_admin_update ON organisation.questionnaire_template
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY questionnaire_template_admin_delete ON organisation.questionnaire_template
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.service_required_consent
CREATE POLICY service_required_consent_read ON organisation.service_required_consent
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY service_required_consent_admin_insert ON organisation.service_required_consent
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY service_required_consent_admin_update ON organisation.service_required_consent
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY service_required_consent_admin_delete ON organisation.service_required_consent
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.feature_flag
CREATE POLICY feature_flag_read ON organisation.feature_flag
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY feature_flag_admin_insert ON organisation.feature_flag
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY feature_flag_admin_update ON organisation.feature_flag
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY feature_flag_admin_delete ON organisation.feature_flag
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.banner
CREATE POLICY banner_read ON organisation.banner
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY banner_admin_insert ON organisation.banner
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY banner_admin_update ON organisation.banner
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY banner_admin_delete ON organisation.banner
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- organisation.operating_state
CREATE POLICY operating_state_read ON organisation.operating_state
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) IN ('staff', 'patient', 'partner')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));
CREATE POLICY operating_state_admin_insert ON organisation.operating_state
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY operating_state_admin_update ON organisation.operating_state
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));
CREATE POLICY operating_state_admin_delete ON organisation.operating_state
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'));

-- Grants: nothing to PUBLIC. app_owner owns the tables and is granted no DML (FORCE makes ownership grant nothing).
REVOKE ALL ON organisation.organisation,
  organisation.jurisdiction,
  organisation.location,
  organisation.room,
  organisation.opening_hours,
  organisation.holiday,
  organisation.service,
  organisation.service_location,
  organisation.service_clinician,
  organisation.booking_policy,
  organisation.consent_template,
  organisation.questionnaire_template,
  organisation.service_required_consent,
  organisation.feature_flag,
  organisation.banner,
  organisation.operating_state
  FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON organisation.organisation,
  organisation.jurisdiction,
  organisation.location,
  organisation.room,
  organisation.opening_hours,
  organisation.holiday,
  organisation.service,
  organisation.service_location,
  organisation.service_clinician,
  organisation.booking_policy,
  organisation.consent_template,
  organisation.questionnaire_template,
  organisation.service_required_consent,
  organisation.feature_flag,
  organisation.banner,
  organisation.operating_state
  TO app_api;
GRANT SELECT ON organisation.organisation,
  organisation.jurisdiction,
  organisation.location,
  organisation.room,
  organisation.opening_hours,
  organisation.holiday,
  organisation.service,
  organisation.service_location,
  organisation.service_clinician,
  organisation.booking_policy,
  organisation.consent_template,
  organisation.questionnaire_template,
  organisation.service_required_consent,
  organisation.feature_flag,
  organisation.banner,
  organisation.operating_state
  TO app_worker;
GRANT INSERT, UPDATE ON organisation.jurisdiction TO app_worker;
