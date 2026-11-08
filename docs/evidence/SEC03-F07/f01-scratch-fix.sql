-- migration-class: expand
-- SCRATCH (not committed): SEC03-F01 validation only.
ALTER POLICY patient_link_staff_select ON identity.patient_link USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = patient_link.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY proxy_grant_staff_select ON identity.proxy_grant USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = proxy_grant.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY delivery_receipt_staff_select ON notifications.delivery_receipt USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = delivery_receipt.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY notification_staff_cancel ON notifications.notification USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = notification.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text)))) AND (status = ANY (ARRAY['queued'::text, 'failed'::text])))) WITH CHECK (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (status = 'cancelled'::text)));
ALTER POLICY notification_staff_select ON notifications.notification USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = notification.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY relationship_staff_select ON patient.care_relationship USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = care_relationship.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY careteam_staff_insert ON patient.care_team_member WITH CHECK (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = care_team_member.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY careteam_staff_select ON patient.care_team_member USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = care_team_member.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY careteam_staff_update ON patient.care_team_member USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = care_team_member.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text)))))) WITH CHECK (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = care_team_member.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY preference_staff_select ON patient.communication_preference USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = communication_preference.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY consent_staff_insert ON patient.consent WITH CHECK (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = consent.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text)))) AND (status = 'pending'::text)));
ALTER POLICY consent_staff_select ON patient.consent USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = consent.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY consent_staff_update ON patient.consent USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = consent.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text)))) AND (status = ANY (ARRAY['pending'::text, 'signed'::text])))) WITH CHECK (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = consent.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text)))) AND ((status = ANY (ARRAY['superseded'::text, 'withdrawn'::text])) OR ((status = 'signed'::text) AND (signer_relationship = 'staff_witnessed'::text) AND (signer_principal_id = ( SELECT kernel.uuid1('app.principal_id'::text) AS uuid1))))));
ALTER POLICY flag_staff_select ON patient.duplicate_flag USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (((( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = duplicate_flag.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))) OR ((( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = duplicate_flag.candidate_patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (candidate_patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))))));
ALTER POLICY flag_staff_update ON patient.duplicate_flag USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = duplicate_flag.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text)))))) WITH CHECK (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = duplicate_flag.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY coverage_staff_select ON patient.insurance_coverage USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = insurance_coverage.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY coverage_staff_update ON patient.insurance_coverage USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = insurance_coverage.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text)))))) WITH CHECK (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = insurance_coverage.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY contact_staff_delete ON patient.patient_contact USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = patient_contact.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY contact_staff_insert ON patient.patient_contact WITH CHECK (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = patient_contact.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY contact_staff_select ON patient.patient_contact USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = patient_contact.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
ALTER POLICY contact_staff_update ON patient.patient_contact USING (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = patient_contact.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text)))))) WITH CHECK (((organisation_id = ( SELECT kernel.uuid1('app.org_id'::text) AS uuid1)) AND (( SELECT kernel.setting('app.audience'::text) AS setting) = 'staff'::text) AND (( SELECT kernel.setting('app.realm'::text) AS setting) = 'google'::text) AND ((EXISTS ( SELECT 1
   FROM patient.staff_scope s
  WHERE ((s.patient_id = patient_contact.patient_id) AND (s.location_id = ANY (kernel.uuids('app.location_ids'::text)))))) OR (patient_id = ANY (kernel.uuids('app.btg_patient_ids'::text))))));
