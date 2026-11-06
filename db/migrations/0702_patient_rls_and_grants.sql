-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for the patient schema (ARCHITECTURE 21.4,
-- 22.6; SHARED-BOUNDARIES 6.2, 6.3; ticket BE-08). Templates: T-PAT-OWN, T-STAFF (written out, 21.4: patient.staff_sees is
-- not inlined by PostgreSQL), T-ADMIN-BTG, T-SLICE(consents), T-SYS, T-PRINCIPAL. Every policy names its roles (M-2).
--
-- Also here, because they were waiting for patient.staff_scope: the T-STAFF policies deferred by identity 0502
-- (patient_link, proxy_grant) and notifications 0601 (notification, delivery_receipt).
--
-- Ownership: the tables stay owned by app_owner. SHARED-BOUNDARIES 6.2 says the function-owner roles own "the tables only
-- they write", but app_owner holds those roles with INHERIT FALSE and the runner refuses SET ROLE, so a table owned by
-- patient_scope_owner could never be altered by a later ticket (BE-09 adds policies and columns here). The write path is
-- still only the definer functions: app_api and app_worker get no INSERT, UPDATE or DELETE on care_relationship,
-- staff_scope or patient_merge, and FORCE ROW LEVEL SECURITY makes ownership grant nothing. The functions themselves are
-- owned by the function-owner roles.

ALTER TABLE patient.patient ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.patient FORCE  ROW LEVEL SECURITY;
ALTER TABLE patient.patient_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.patient_contact FORCE  ROW LEVEL SECURITY;
ALTER TABLE patient.insurance_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.insurance_coverage FORCE  ROW LEVEL SECURITY;
ALTER TABLE patient.consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.consent FORCE  ROW LEVEL SECURITY;
ALTER TABLE patient.communication_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.communication_preference FORCE  ROW LEVEL SECURITY;
ALTER TABLE patient.care_relationship ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.care_relationship FORCE  ROW LEVEL SECURITY;
ALTER TABLE patient.staff_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.staff_scope FORCE  ROW LEVEL SECURITY;
ALTER TABLE patient.care_team_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.care_team_member FORCE  ROW LEVEL SECURITY;
ALTER TABLE patient.duplicate_flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.duplicate_flag FORCE  ROW LEVEL SECURITY;
ALTER TABLE patient.match_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.match_check FORCE  ROW LEVEL SECURITY;
ALTER TABLE patient.patient_merge ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient.patient_merge FORCE  ROW LEVEL SECURITY;

-- patient.patient: T-PAT-OWN (the patient's own row, never a proxy's), T-STAFF, T-ADMIN-BTG, T-SYS. No INSERT for app_api: register is the only way in.
CREATE POLICY patient_own_select ON patient.patient
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND id = ANY (kernel.uuids('app.patient_ids')) AND NOT id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY patient_own_update ON patient.patient
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND id = ANY (kernel.uuids('app.patient_ids')) AND NOT id = ANY (kernel.uuids('app.proxy_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND id = ANY (kernel.uuids('app.patient_ids')) AND NOT id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY patient_staff_select ON patient.patient
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY patient_staff_update ON patient.patient
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY patient_btg_select ON patient.patient
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY patient_system_select ON patient.patient
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY patient_scope_owner_select ON patient.patient
  FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));
CREATE POLICY patient_scope_owner_insert ON patient.patient
  FOR INSERT TO patient_scope_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));
CREATE POLICY patient_scope_owner_update ON patient.patient
  FOR UPDATE TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));
CREATE POLICY patient_match_owner_select ON patient.patient
  FOR SELECT TO patient_match_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff');

-- patient.patient_contact
CREATE POLICY contact_own_select ON patient.patient_contact
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY contact_own_insert ON patient.patient_contact
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY contact_own_update ON patient.patient_contact
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY contact_own_delete ON patient.patient_contact
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY contact_staff_select ON patient.patient_contact
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY contact_staff_insert ON patient.patient_contact
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY contact_staff_update ON patient.patient_contact
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY contact_staff_delete ON patient.patient_contact
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY contact_btg_select ON patient.patient_contact
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY contact_system_select ON patient.patient_contact
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- patient.insurance_coverage: the patient keeps their own cards; staff read and record the eligibility result (RA-R1-29).
CREATE POLICY coverage_own_select ON patient.insurance_coverage
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY coverage_own_insert ON patient.insurance_coverage
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND eligibility_status = 'unknown');
CREATE POLICY coverage_own_update ON patient.insurance_coverage
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY coverage_staff_select ON patient.insurance_coverage
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY coverage_staff_update ON patient.insurance_coverage
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY coverage_btg_select ON patient.insurance_coverage
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY coverage_system_select ON patient.insurance_coverage
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- patient.consent: T-PAT-OWN, T-STAFF, T-SLICE(consents), T-ADMIN-BTG, T-SYS. Rows are created pending; the patient signs as self (a proxy
-- does not sign, D-7 default); staff may witness. The signature columns must name the caller.
CREATE POLICY consent_own_select ON patient.consent
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY consent_own_insert ON patient.consent
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND status = 'pending');
CREATE POLICY consent_own_update ON patient.consent
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND status IN ('pending', 'signed'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND (status IN ('superseded', 'withdrawn') OR (status = 'signed' AND signer_relationship = 'self' AND signer_principal_id = (SELECT kernel.uuid1('app.principal_id')))));
CREATE POLICY consent_staff_select ON patient.consent
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY consent_staff_insert ON patient.consent
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND status = 'pending');
CREATE POLICY consent_staff_update ON patient.consent
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND status IN ('pending', 'signed'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND (status IN ('superseded', 'withdrawn') OR (status = 'signed' AND signer_relationship = 'staff_witnessed' AND signer_principal_id = (SELECT kernel.uuid1('app.principal_id')))));
CREATE POLICY consent_slice_select ON patient.consent
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'consents' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));
CREATE POLICY consent_btg_select ON patient.consent
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND patient_id = ANY (kernel.uuids('app.btg_patient_ids')));
CREATE POLICY consent_system_select ON patient.consent
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- patient.communication_preference: the patient's own; staff and jobs read (the recipient resolver reads it, 3.2 rule 7).
CREATE POLICY preference_own_select ON patient.communication_preference
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY preference_own_insert ON patient.communication_preference
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY preference_own_update ON patient.communication_preference
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY preference_staff_select ON patient.communication_preference
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY preference_system_select ON patient.communication_preference
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- patient.care_relationship: T-STAFF and T-SYS read; written only by the patient_scope_owner functions.
CREATE POLICY relationship_staff_select ON patient.care_relationship
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY relationship_system_select ON patient.care_relationship
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY relationship_scope_owner_select ON patient.care_relationship
  FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));
CREATE POLICY relationship_scope_owner_insert ON patient.care_relationship
  FOR INSERT TO patient_scope_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));
CREATE POLICY relationship_scope_owner_update ON patient.care_relationship
  FOR UPDATE TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));

-- patient.staff_scope: its own policy compares location_id with app.location_ids (staff), patient_id with the patient or job sets.
-- It reads settings only, so a T-STAFF probe from another table cannot recurse (6.3).
CREATE POLICY scope_staff_select ON patient.staff_scope
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND location_id = ANY (kernel.uuids('app.location_ids')));
CREATE POLICY scope_own_select ON patient.staff_scope
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY scope_system_select ON patient.staff_scope
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY scope_scope_owner_select ON patient.staff_scope
  FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));
CREATE POLICY scope_scope_owner_insert ON patient.staff_scope
  FOR INSERT TO patient_scope_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));
CREATE POLICY scope_scope_owner_delete ON patient.staff_scope
  FOR DELETE TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));

-- patient.care_team_member: T-STAFF and T-SYS.
CREATE POLICY careteam_staff_select ON patient.care_team_member
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY careteam_staff_insert ON patient.care_team_member
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY careteam_staff_update ON patient.care_team_member
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY careteam_system_select ON patient.care_team_member
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));

-- patient.duplicate_flag: staff who can see either patient see the flag; the API shows the other side only when it is in scope.
-- Only register (patient_scope_owner) inserts; staff resolve.
CREATE POLICY flag_staff_select ON patient.duplicate_flag
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) OR (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = candidate_patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR candidate_patient_id = ANY (kernel.uuids('app.btg_patient_ids')))));
CREATE POLICY flag_staff_update ON patient.duplicate_flag
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY flag_system_select ON patient.duplicate_flag
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY flag_scope_owner_select ON patient.duplicate_flag
  FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));
CREATE POLICY flag_scope_owner_insert ON patient.duplicate_flag
  FOR INSERT TO patient_scope_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));

-- patient.match_check: T-PRINCIPAL (the searching principal only), T-SYS purge. Written by match_candidates; marked used by register and attach.
CREATE POLICY match_check_principal_select ON patient.match_check
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY match_check_system_select ON patient.match_check
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY match_check_system_delete ON patient.match_check
  FOR DELETE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY match_check_match_owner_insert ON patient.match_check
  FOR INSERT TO patient_match_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));
CREATE POLICY match_check_scope_owner_select ON patient.match_check
  FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));
CREATE POLICY match_check_scope_owner_update ON patient.match_check
  FOR UPDATE TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));

-- patient.patient_merge: the merge map. The scope contributor reads it while the scope is being built, before app.patient_ids
-- exists, so the patient and BTG predicates look at the principal's own identity.patient_link, active identity.proxy_grant and
-- audit.btg_grant rows (each readable by that principal under its own policy) instead of at settings. Reads only: BE-09 adds the writer's policies.
CREATE POLICY merge_map_patient_select ON patient.patient_merge
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'patient' AND (EXISTS (SELECT 1 FROM identity.patient_link l WHERE l.principal_id = (SELECT kernel.uuid1('app.principal_id')) AND l.patient_id = final_survivor_id) OR EXISTS (SELECT 1 FROM identity.proxy_grant g WHERE g.proxy_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND g.patient_id = final_survivor_id AND g.status = 'active' AND (g.valid_until IS NULL OR g.valid_until >= current_date))));
CREATE POLICY merge_map_staff_select ON patient.patient_merge
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND ((SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = merged_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = final_survivor_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) ) OR EXISTS (SELECT 1 FROM audit.btg_grant b WHERE b.holder_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND b.patient_id = final_survivor_id AND b.revoked_at IS NULL AND b.expires_at > now())));
CREATE POLICY merge_map_system_select ON patient.patient_merge
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND (final_survivor_id = ANY (kernel.uuids('app.job_patient_ids')) OR merged_id = ANY (kernel.uuids('app.job_patient_ids'))))));
CREATE POLICY merge_map_scope_owner_select ON patient.patient_merge
  FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));

-- Deferred by identity 0502: T-STAFF read of the portal link and the proxy grants of the patients staff can see.
CREATE POLICY patient_link_staff_select ON identity.patient_link
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY proxy_grant_staff_select ON identity.proxy_grant
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
-- register links the new patient to the signed-in principal and refuses a second link: it reads that principal's links.
CREATE POLICY patient_link_scope_owner_select ON identity.patient_link
  FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient'
     AND principal_id = (SELECT kernel.uuid1('app.principal_id')));

-- Deferred by notifications 0601 (NOT-N3): staff read and cancel the notices of the patients they can see, and read receipts.
CREATE POLICY notification_staff_select ON notifications.notification
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY notification_staff_cancel ON notifications.notification
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND status IN ('queued', 'failed'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND status = 'cancelled');
CREATE POLICY delivery_receipt_staff_select ON notifications.delivery_receipt
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));

-- Grants ---------------------------------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA patient FROM PUBLIC;
REVOKE ALL ON SEQUENCE patient.mrn_seq FROM PUBLIC;

-- app_api: DML under RLS on the tables patients and staff maintain; read-only on the derived and definer-written tables.
GRANT SELECT ON patient.patient, patient.patient_contact, patient.insurance_coverage, patient.consent, patient.communication_preference,
  patient.care_relationship, patient.staff_scope, patient.care_team_member, patient.duplicate_flag, patient.match_check,
  patient.patient_merge TO app_api;
GRANT UPDATE (given_name, family_name, middle_name, date_of_birth, sex_at_birth, gender_identity, phone_e164, email, address,
  state_code, preferred_language, photo_document_id, preferred_pharmacy) ON patient.patient TO app_api;
GRANT INSERT, UPDATE, DELETE ON patient.patient_contact TO app_api;
GRANT INSERT (id, organisation_id, patient_id, payer_name, member_id, group_number, front_document_id, back_document_id, eligibility_status, created_by)
  ON patient.insurance_coverage TO app_api;
GRANT UPDATE (payer_name, member_id, group_number, front_document_id, back_document_id, eligibility_status, verified_at, verified_by, active)
  ON patient.insurance_coverage TO app_api;
GRANT INSERT (id, organisation_id, patient_id, template_key, template_version, status, created_by) ON patient.consent TO app_api;
GRANT UPDATE (status, signer_principal_id, signer_relationship, signed_name, signature_document_id, reason) ON patient.consent TO app_api;
GRANT INSERT, UPDATE ON patient.communication_preference TO app_api;
GRANT INSERT (id, organisation_id, patient_id, principal_id, role, from_date, created_by) ON patient.care_team_member TO app_api;
GRANT UPDATE (to_date, end_reason) ON patient.care_team_member TO app_api;
GRANT UPDATE (status, resolved_by, resolved_reason) ON patient.duplicate_flag TO app_api;

-- app_worker: reads under T-SYS (recipient resolution, export, drift check); purges expired match checks. BE-09 adds the merge writes.
GRANT SELECT ON patient.patient, patient.patient_contact, patient.insurance_coverage, patient.consent, patient.communication_preference,
  patient.care_relationship, patient.staff_scope, patient.care_team_member, patient.duplicate_flag, patient.match_check,
  patient.patient_merge TO app_worker;
GRANT DELETE ON patient.match_check TO app_worker;

-- patient_scope_owner: register inserts the root; the merge functions of BE-09 change status and merged_into only.
GRANT SELECT, INSERT ON patient.patient TO patient_scope_owner;
GRANT UPDATE (status, merged_into) ON patient.patient TO patient_scope_owner;
GRANT SELECT, INSERT, UPDATE ON patient.care_relationship TO patient_scope_owner;
GRANT SELECT, INSERT, DELETE ON patient.staff_scope TO patient_scope_owner;
GRANT SELECT ON patient.patient_merge TO patient_scope_owner;
GRANT SELECT, INSERT ON patient.duplicate_flag TO patient_scope_owner;
GRANT SELECT ON patient.match_check TO patient_scope_owner;
GRANT UPDATE (used_at) ON patient.match_check TO patient_scope_owner;
GRANT USAGE ON SEQUENCE patient.mrn_seq TO patient_scope_owner;
GRANT SELECT (principal_id, patient_id, organisation_id) ON identity.patient_link TO patient_scope_owner;

-- patient_match_owner: the identity columns of the root only (6.2), and the match check it writes.
GRANT SELECT (id, organisation_id, mrn, given_name, family_name, middle_name, date_of_birth, phone_e164, email, status, merged_into)
  ON patient.patient TO patient_match_owner;
GRANT SELECT, INSERT ON patient.match_check TO patient_match_owner;

-- The T-STAFF probes read patient.staff_scope as the invoker; the deferred policies on other modules' tables run as app_api,
-- which already holds SELECT on those tables.

