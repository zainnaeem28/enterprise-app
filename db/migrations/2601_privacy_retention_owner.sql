-- migration-class: expand
-- Account deletion and retention purge: the retention role, its narrow rights and the gated definer functions (owner ruling 2026-11-11 C,
-- items 1 and 2; ticket HEAAA-789 C-BE-DEL). Companion of 2600 (tables, request state machine) and 2602 (contract: the old constraint).
--
-- Why a role and functions (as for the SEC03-F11 merge writes, 2503): app_worker holds no DELETE on the medical record and must not get
-- it, and every table below refuses deletion by trigger. Deleting is the job of the NOLOGIN role privacy_retention_owner, which owns
-- three definer functions that app_worker may call; each calls privacy.deletion_job_check / privacy_retention_check first. A call that
-- is not the patients-scope (or, for the HIPAA documentation purge, organisation-scope) system job of an approved deletion request or of
-- a due deletion record is refused with 42501. The refusing triggers get one extra condition, `WHEN (current_user <> 'privacy_retention_owner')`,
-- so nobody else is affected. Inside the functions no value is dynamic SQL; the lists of classes are static and reviewable.
--
--   privacy.delete_nonrecord_data(request)   (a) deactivates the patient's sign-in (principal disabled, sessions revoked) and (b) deletes
--        the data outside the medical record: notification preferences (incl. the marketing flag), device and push tokens, marketing and
--        cookie consents, drafts (questionnaire responses never submitted), uploads never accepted into the record. Anything under a legal
--        hold is left alone. Returns counts per class and the counts of what is kept. The medical record is not touched.
--   privacy.purge_medical_record(record)     the retention end of an executed deletion: deletes the medical record classes in foreign-key
--        order and marks accepted documents deleted (their objects are removed by documents.retention_sweep; the document rows go in a
--        later run). A legal hold on any document of the patient, or a document whose own retention has not ended, defers the whole purge.
--   privacy.purge_hipaa_documentation(cutoff) removes privacy documentation (finished requests, expired packages, closed incidents,
--        purged deletion records) whose HIPAA documentation period ended before the cut-off date.
--
-- The audit trail is NOT touched here: audit rows are append-only and leave the hot store only through the dual-controlled archive process
-- (ARCHITECTURE section 6, SAR-07); their retention is enforced in the archive (Object Lock), from the same settings.
--
-- Down-note (forward-only): to go back, drop the three functions and the two helpers, drop the policies and revoke the grants of the role,
-- and restore the 16 triggers without the WHEN condition and documents.guard_document from 1001. The role stays (db/roles).

GRANT USAGE ON SCHEMA patient, identity, clinical, documents, privacy TO privacy_retention_owner;
GRANT CREATE ON SCHEMA privacy TO privacy_retention_owner;

GRANT SELECT ON patient.patient_merge, patient.consent, patient.communication_preference, identity.patient_link, identity.principal,
  identity.session, identity.push_subscription, clinical.allergy, clinical.consent_exception, clinical.encounter, clinical.follow_up,
  clinical.medication_statement, clinical.note, clinical.note_addendum, clinical.note_cosign, clinical.problem, clinical.referral,
  clinical.referral_inbox, clinical.triage_assessment, clinical.vital_sign, clinical.questionnaire_response, documents.document,
  documents.document_version, documents.legal_hold, documents.deletion_request, privacy.request, privacy.export_package, privacy.incident,
  privacy.incident_patient, privacy.deletion_record TO privacy_retention_owner;
GRANT DELETE ON patient.consent, patient.communication_preference, identity.push_subscription, clinical.allergy, clinical.consent_exception,
  clinical.encounter, clinical.follow_up, clinical.medication_statement, clinical.note, clinical.note_addendum, clinical.note_cosign,
  clinical.problem, clinical.referral, clinical.referral_inbox, clinical.triage_assessment, clinical.vital_sign, clinical.questionnaire_response,
  documents.document, documents.document_version, documents.legal_hold, documents.deletion_request, privacy.request, privacy.export_package,
  privacy.incident, privacy.incident_patient, privacy.deletion_record TO privacy_retention_owner;
GRANT UPDATE (status, disabled_reason) ON identity.principal TO privacy_retention_owner;
GRANT UPDATE (revoked_at, revoke_reason) ON identity.session TO privacy_retention_owner;
GRANT UPDATE (status, deleted_at) ON documents.document TO privacy_retention_owner;
GRANT UPDATE (purge_state, purge_checked_at, purge_deferred_reason, purged_at) ON privacy.deletion_record TO privacy_retention_owner;

-- Policies of the role. Reads and deletes are limited to a system job's exact patients (patients scope) or, for the HIPAA documentation
-- purge and the retention job's own reads, to the organisation (org scope). Updates are pinned to what the functions write.
CREATE POLICY allergy_retention_select ON clinical.allergy FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY allergy_retention_delete ON clinical.allergy FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY consent_exception_retention_select ON clinical.consent_exception FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY consent_exception_retention_delete ON clinical.consent_exception FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY encounter_retention_select ON clinical.encounter FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY encounter_retention_delete ON clinical.encounter FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY follow_up_retention_select ON clinical.follow_up FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY follow_up_retention_delete ON clinical.follow_up FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY medication_statement_retention_select ON clinical.medication_statement FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY medication_statement_retention_delete ON clinical.medication_statement FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY note_retention_select ON clinical.note FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY note_retention_delete ON clinical.note FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY note_addendum_retention_select ON clinical.note_addendum FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY note_addendum_retention_delete ON clinical.note_addendum FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY note_cosign_retention_select ON clinical.note_cosign FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY note_cosign_retention_delete ON clinical.note_cosign FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY problem_retention_select ON clinical.problem FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY problem_retention_delete ON clinical.problem FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY referral_retention_select ON clinical.referral FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY referral_retention_delete ON clinical.referral FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY triage_assessment_retention_select ON clinical.triage_assessment FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY triage_assessment_retention_delete ON clinical.triage_assessment FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY vital_sign_retention_select ON clinical.vital_sign FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY vital_sign_retention_delete ON clinical.vital_sign FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY questionnaire_response_retention_select ON clinical.questionnaire_response FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY questionnaire_response_retention_delete ON clinical.questionnaire_response FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY deletion_request_retention_select ON documents.deletion_request FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY deletion_request_retention_delete ON documents.deletion_request FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY document_version_retention_select ON documents.document_version FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY document_version_retention_delete ON documents.document_version FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY legal_hold_retention_select ON documents.legal_hold FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY legal_hold_retention_delete ON documents.legal_hold FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY consent_retention_select ON patient.consent FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY consent_retention_delete ON patient.consent FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY preference_retention_select ON patient.communication_preference FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY preference_retention_delete ON patient.communication_preference FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY document_retention_select ON documents.document FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY document_retention_update ON documents.document FOR UPDATE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY document_retention_delete ON documents.document FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY referral_inbox_retention_select ON clinical.referral_inbox FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM clinical.referral r WHERE r.id = referral_inbox.referral_id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY referral_inbox_retention_delete ON clinical.referral_inbox FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM clinical.referral r WHERE r.id = referral_inbox.referral_id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY patient_link_retention_select ON identity.patient_link FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY principal_retention_select ON identity.principal FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM identity.patient_link l WHERE l.principal_id = principal.id AND l.patient_id = ANY (kernel.uuids('app.job_patient_ids')))
     AND realm = 'patient_pool');
CREATE POLICY principal_retention_update ON identity.principal FOR UPDATE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM identity.patient_link l WHERE l.principal_id = principal.id AND l.patient_id = ANY (kernel.uuids('app.job_patient_ids')))
     AND realm = 'patient_pool')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM identity.patient_link l WHERE l.principal_id = principal.id AND l.patient_id = ANY (kernel.uuids('app.job_patient_ids')))
     AND realm = 'patient_pool' AND status = 'disabled');
CREATE POLICY session_retention_select ON identity.session FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM identity.patient_link l WHERE l.principal_id = session.principal_id AND l.patient_id = ANY (kernel.uuids('app.job_patient_ids')))
     AND realm = 'patient_pool');
CREATE POLICY session_retention_update ON identity.session FOR UPDATE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM identity.patient_link l WHERE l.principal_id = session.principal_id AND l.patient_id = ANY (kernel.uuids('app.job_patient_ids')))
     AND realm = 'patient_pool')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM identity.patient_link l WHERE l.principal_id = session.principal_id AND l.patient_id = ANY (kernel.uuids('app.job_patient_ids')))
     AND realm = 'patient_pool');
CREATE POLICY push_subscription_retention_select ON identity.push_subscription FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM identity.patient_link l WHERE l.principal_id = push_subscription.principal_id AND l.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY push_subscription_retention_delete ON identity.push_subscription FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM identity.patient_link l WHERE l.principal_id = push_subscription.principal_id AND l.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY patient_merge_retention_select ON patient.patient_merge FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY request_retention_select ON privacy.request FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY request_retention_delete ON privacy.request FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY export_package_retention_select ON privacy.export_package FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY export_package_retention_delete ON privacy.export_package FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY incident_retention_select ON privacy.incident FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY incident_retention_delete ON privacy.incident FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY incident_patient_retention_select ON privacy.incident_patient FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY incident_patient_retention_delete ON privacy.incident_patient FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY deletion_record_retention_select ON privacy.deletion_record FOR SELECT TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients'
          AND EXISTS (SELECT 1 FROM privacy.request r WHERE r.id = deletion_record.request_id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids'))))));
CREATE POLICY deletion_record_retention_update ON privacy.deletion_record FOR UPDATE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients'
          AND EXISTS (SELECT 1 FROM privacy.request r WHERE r.id = deletion_record.request_id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids'))))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients'
          AND EXISTS (SELECT 1 FROM privacy.request r WHERE r.id = deletion_record.request_id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids'))))));
CREATE POLICY deletion_record_retention_delete ON privacy.deletion_record FOR DELETE TO privacy_retention_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');

-- The documents state machine: the retention role may mark a document deleted (a document that was never accepted, or an accepted one at
-- the end of its retention), but never one under a legal hold. Body of 1001 with one added branch (D2601).
CREATE OR REPLACE FUNCTION documents.guard_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_aud    text := kernel.setting('app.audience');
  v_realm  text := kernel.setting('app.realm');
  v_worker boolean := (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system');
  v_staff  boolean := (kernel.setting('app.audience') = 'staff' AND kernel.setting('app.realm') = 'google');
  v_ver    documents.document_version%ROWTYPE;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by OR NEW.upload_channel IS DISTINCT FROM OLD.upload_channel
     OR NEW.current_version IS DISTINCT FROM OLD.current_version OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a document keeps its identity, uploader and version' USING ERRCODE = 'PS001';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    -- No state change. The merge re-points patient_id in any state (R); everything else is fixed in a terminal state.
    IF OLD.status IN ('quarantined', 'deleted')
       AND (NEW.classification IS DISTINCT FROM OLD.classification OR NEW.suggested_classification IS DISTINCT FROM OLD.suggested_classification
            OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
            OR NEW.retention_until IS DISTINCT FROM OLD.retention_until OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
      RAISE EXCEPTION 'a finished document accepts no change' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.retention_until IS DISTINCT FROM OLD.retention_until OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      RAISE EXCEPTION 'confirmation, retention and deletion are written with their state change' USING ERRCODE = 'PS001';
    END IF;
    -- Classification is staff's, and only before the confirmation that makes it the record.
    IF NEW.classification IS DISTINCT FROM OLD.classification AND NOT (OLD.status = 'clean' AND v_staff) THEN
      RAISE EXCEPTION 'only staff classify, and only a clean document that is not yet confirmed' USING ERRCODE = 'PS001';
    END IF;
    -- The OCR suggestion is the worker's, and only while the document waits for staff.
    IF NEW.suggested_classification IS DISTINCT FROM OLD.suggested_classification AND NOT (OLD.status = 'clean' AND v_worker) THEN
      RAISE EXCEPTION 'the suggestion is written by the worker for a clean, unconfirmed document' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  -- A state change: the allowed steps (ST-06), who takes them, and what must already be true.
  IF NEW.classification IS DISTINCT FROM OLD.classification AND NOT (OLD.status = 'clean' AND NEW.status = 'confirmed' AND v_staff) THEN
    RAISE EXCEPTION 'classification changes on its own, not with another step' USING ERRCODE = 'PS001';
  END IF;
  SELECT * INTO v_ver FROM documents.document_version v WHERE v.document_id = OLD.id AND v.version = OLD.current_version;

  IF OLD.status = 'awaiting_upload' AND NEW.status = 'scanning' THEN
    IF v_aud NOT IN ('patient', 'staff') OR v_ver.document_id IS NULL OR v_ver.scan_status <> 'pending' OR v_ver.scan_requested_at IS NULL THEN
      RAISE EXCEPTION 'illegal document transition' USING ERRCODE = 'PS001';
    END IF;
  ELSIF OLD.status = 'scanning' AND NEW.status = 'clean' THEN
    IF NOT v_worker OR v_ver.document_id IS NULL OR v_ver.scan_status <> 'clean' OR v_ver.bucket <> 'clean' THEN
      RAISE EXCEPTION 'a document is clean only after a clean scan of its object' USING ERRCODE = 'PS001';
    END IF;
  ELSIF OLD.status = 'scanning' AND NEW.status = 'quarantined' THEN
    IF NOT v_worker OR v_ver.document_id IS NULL OR v_ver.scan_status <> 'infected' THEN
      RAISE EXCEPTION 'a document is quarantined only after an infected scan result' USING ERRCODE = 'PS001';
    END IF;
  ELSIF OLD.status = 'clean' AND NEW.status = 'confirmed' THEN
    IF NOT v_staff OR NEW.confirmed_by IS DISTINCT FROM kernel.uuid1('app.principal_id') OR NEW.confirmed_at IS NULL
       OR v_ver.document_id IS NULL OR v_ver.scan_status <> 'clean' OR v_ver.bucket <> 'clean' THEN
      RAISE EXCEPTION 'a document is confirmed by staff, after a clean scan' USING ERRCODE = 'PS001';
    END IF;
  ELSIF current_user = 'privacy_retention_owner' AND NEW.status = 'deleted'
        AND OLD.status IN ('awaiting_upload', 'scanning', 'quarantined', 'clean', 'confirmed') THEN
    -- D2601: account deletion (an upload never accepted) and the retention purge (an accepted document). Same lock as a hold insert.
    IF NEW.deleted_at IS NULL THEN
      RAISE EXCEPTION 'illegal document transition' USING ERRCODE = 'PS001';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('doc-hold:' || OLD.id::text, 0));
    IF (SELECT h.action FROM documents.legal_hold h WHERE h.document_id = OLD.id ORDER BY h.seq DESC LIMIT 1) = 'placed' THEN
      RAISE EXCEPTION 'legal_hold' USING ERRCODE = 'PS002';
    END IF;
  ELSIF OLD.status = 'confirmed' AND NEW.status = 'deleted' THEN
    IF NOT v_staff OR NEW.deleted_at IS NULL THEN
      RAISE EXCEPTION 'illegal document transition' USING ERRCODE = 'PS001';
    END IF;
    -- Serialised with legal_hold inserts and with the decision itself (same key); then the blockers are read afresh.
    PERFORM pg_advisory_xact_lock(hashtextextended('doc-hold:' || OLD.id::text, 0));
    IF documents.deletion_blockers(OLD.id) IS NOT NULL THEN
      RAISE EXCEPTION '%', documents.deletion_blockers(OLD.id) USING ERRCODE = 'PS002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM documents.deletion_request r WHERE r.document_id = OLD.id AND r.outcome = 'deleted') THEN
      RAISE EXCEPTION 'deletion follows a deletion request that was decided deleted' USING ERRCODE = 'PS001';
    END IF;
  ELSE
    RAISE EXCEPTION 'illegal document transition' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$function$;

-- Helpers and the three functions ------------------------------------------------------------------------------------------
-- The patient, the survivor it was merged into and everything merged into that survivor (the same closure the worker's adapter reads).
CREATE FUNCTION privacy.patient_closure(p_patient uuid) RETURNS uuid[]
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
  WITH final AS (
    SELECT coalesce((SELECT m.final_survivor_id FROM patient.patient_merge m WHERE m.merged_id = p_patient), p_patient) AS id)
  SELECT coalesce(array_agg(DISTINCT s.id), '{}'::uuid[])
    FROM (SELECT f.id FROM final f
          UNION SELECT m.merged_id FROM patient.patient_merge m, final f WHERE m.final_survivor_id = f.id) s
$$;

-- The gate of the deletion function: the patients-scope system job of an approved, identity-verified deletion request, for this
-- request's patient (and the patients merged with it) and nobody else. Returns the request's patient.
CREATE FUNCTION privacy.deletion_job_check(p_request uuid) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  v_ids uuid[] := kernel.uuids('app.job_patient_ids');
  v_row record;
BEGIN
  IF v_org IS NULL OR p_request IS NULL
     OR kernel.setting('app.audience') IS DISTINCT FROM 'system' OR kernel.setting('app.job_scope') IS DISTINCT FROM 'patients' THEN
    RAISE EXCEPTION 'account deletion: only the patients-scope system job of an approved deletion request may call this' USING ERRCODE = '42501';
  END IF;
  SELECT r.patient_id, r.kind, r.status, r.verified_at, r.decided_at INTO v_row
    FROM privacy.request r WHERE r.id = p_request AND r.organisation_id = v_org;
  IF NOT FOUND OR NOT (v_row.patient_id = ANY (v_ids)) THEN
    RAISE EXCEPTION 'account deletion: no such deletion request for this job' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) j(id) WHERE NOT j.id = ANY (privacy.patient_closure(v_row.patient_id))) THEN
    RAISE EXCEPTION 'account deletion: the job was started for patients outside this request' USING ERRCODE = '42501';
  END IF;
  IF v_row.kind <> 'deletion' OR v_row.status <> 'in_progress' OR v_row.verified_at IS NULL OR v_row.decided_at IS NULL THEN
    RAISE EXCEPTION 'account deletion: the request is not an approved, identity-verified deletion request' USING ERRCODE = 'PS001';
  END IF;
  RETURN v_row.patient_id;
END
$$;

CREATE FUNCTION privacy.delete_nonrecord_data(p_request uuid) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_ids        uuid[];
  v_principals uuid[];
  v_now        timestamptz := now();
  n_principals integer;
  n_sessions   integer;
  n_pref       integer;
  n_push       integer;
  n_consent    integer;
  n_draft      integer;
  n_upload     integer;
  n_upload_held integer;
  n_held       integer;
BEGIN
  PERFORM privacy.deletion_job_check(p_request);
  v_ids := kernel.uuids('app.job_patient_ids');
  SELECT coalesce(array_agg(DISTINCT l.principal_id), '{}'::uuid[]) INTO v_principals
    FROM identity.patient_link l WHERE l.patient_id = ANY (v_ids);

  -- (a) deactivation at once: sign-in disabled, every session revoked. Patient realm only.
  UPDATE identity.principal SET status = 'disabled', disabled_reason = 'account_deleted'
   WHERE id = ANY (v_principals) AND realm = 'patient_pool' AND status <> 'disabled';
  GET DIAGNOSTICS n_principals = ROW_COUNT;
  UPDATE identity.session SET revoked_at = v_now, revoke_reason = 'kill_switch'
   WHERE principal_id = ANY (v_principals) AND realm = 'patient_pool' AND revoked_at IS NULL;
  GET DIAGNOSTICS n_sessions = ROW_COUNT;

  -- (b) data outside the medical record.
  DELETE FROM patient.communication_preference WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS n_pref = ROW_COUNT;
  DELETE FROM identity.push_subscription WHERE principal_id = ANY (v_principals);
  GET DIAGNOSTICS n_push = ROW_COUNT;
  -- Marketing and cookie consents (the consent templates whose key is marketing or cookie[s], optionally with a suffix). A clinical
  -- consent is part of the record and stays.
  DELETE FROM patient.consent WHERE patient_id = ANY (v_ids) AND template_key ~ '^(marketing|cookies?)([._-].*)?$';
  GET DIAGNOSTICS n_consent = ROW_COUNT;
  DELETE FROM clinical.questionnaire_response WHERE patient_id = ANY (v_ids) AND status = 'in_progress';
  GET DIAGNOSTICS n_draft = ROW_COUNT;
  -- Uploads never accepted into the record (not confirmed by staff): marked deleted; documents.retention_sweep removes the objects.
  -- A document under a legal hold is never touched.
  UPDATE documents.document d SET status = 'deleted', deleted_at = v_now
   WHERE d.patient_id = ANY (v_ids) AND d.status IN ('awaiting_upload', 'scanning', 'quarantined', 'clean')
     AND coalesce((SELECT h.action FROM documents.legal_hold h WHERE h.document_id = d.id ORDER BY h.seq DESC LIMIT 1), 'released') <> 'placed';
  GET DIAGNOSTICS n_upload = ROW_COUNT;
  SELECT count(*)::integer INTO n_upload_held FROM documents.document d
   WHERE d.patient_id = ANY (v_ids) AND d.status IN ('awaiting_upload', 'scanning', 'quarantined', 'clean')
     AND (SELECT h.action FROM documents.legal_hold h WHERE h.document_id = d.id ORDER BY h.seq DESC LIMIT 1) = 'placed';
  SELECT count(*)::integer INTO n_held FROM documents.document d
   WHERE d.patient_id = ANY (v_ids) AND d.status <> 'deleted'
     AND (SELECT h.action FROM documents.legal_hold h WHERE h.document_id = d.id ORDER BY h.seq DESC LIMIT 1) = 'placed';

  RETURN jsonb_build_object(
    'principalsDisabled', n_principals,
    'sessionsRevoked', n_sessions,
    'heldDocuments', n_held,
    'deleted', jsonb_build_object(
      'notification_preferences', n_pref,
      'device_and_push_tokens', n_push,
      'marketing_and_cookie_consents', n_consent,
      'drafts', n_draft,
      'unaccepted_uploads', n_upload),
    'keptByHold', jsonb_build_object('unaccepted_uploads', n_upload_held),
    -- What is kept (the medical record and accepted documents), counted after the deletion.
    'kept', jsonb_build_object(
      'encounters', (SELECT count(*) FROM clinical.encounter WHERE patient_id = ANY (v_ids)),
      'notes', (SELECT count(*) FROM clinical.note WHERE patient_id = ANY (v_ids)),
      'note_addenda', (SELECT count(*) FROM clinical.note_addendum WHERE patient_id = ANY (v_ids)),
      'allergies', (SELECT count(*) FROM clinical.allergy WHERE patient_id = ANY (v_ids)),
      'problems', (SELECT count(*) FROM clinical.problem WHERE patient_id = ANY (v_ids)),
      'medication_statements', (SELECT count(*) FROM clinical.medication_statement WHERE patient_id = ANY (v_ids)),
      'vital_signs', (SELECT count(*) FROM clinical.vital_sign WHERE patient_id = ANY (v_ids)),
      'triage_assessments', (SELECT count(*) FROM clinical.triage_assessment WHERE patient_id = ANY (v_ids)),
      'questionnaire_responses', (SELECT count(*) FROM clinical.questionnaire_response WHERE patient_id = ANY (v_ids)),
      'referrals', (SELECT count(*) FROM clinical.referral WHERE patient_id = ANY (v_ids)),
      'follow_ups', (SELECT count(*) FROM clinical.follow_up WHERE patient_id = ANY (v_ids)),
      'consents', (SELECT count(*) FROM patient.consent WHERE patient_id = ANY (v_ids)),
      'accepted_documents', (SELECT count(*) FROM documents.document WHERE patient_id = ANY (v_ids) AND status = 'confirmed')));
END
$$;

CREATE FUNCTION privacy.purge_medical_record(p_record uuid) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org   uuid := kernel.uuid1('app.org_id');
  v_ids   uuid[] := kernel.uuids('app.job_patient_ids');
  v_rec   record;
  v_now   timestamptz := now();
  v_n     integer;
  v_left  integer;
  v_removed jsonb := '{}'::jsonb;
BEGIN
  IF v_org IS NULL OR p_record IS NULL
     OR kernel.setting('app.audience') IS DISTINCT FROM 'system' OR kernel.setting('app.job_scope') IS DISTINCT FROM 'patients' THEN
    RAISE EXCEPTION 'retention purge: only the patients-scope system job of a due deletion record may call this' USING ERRCODE = '42501';
  END IF;
  SELECT d.purge_state, d.retained_until, r.patient_id INTO v_rec
    FROM privacy.deletion_record d JOIN privacy.request r ON r.id = d.request_id
   WHERE d.id = p_record AND d.organisation_id = v_org;
  IF NOT FOUND OR NOT (v_rec.patient_id = ANY (v_ids)) THEN
    RAISE EXCEPTION 'retention purge: no such deletion record for this job' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) j(id) WHERE NOT j.id = ANY (privacy.patient_closure(v_rec.patient_id))) THEN
    RAISE EXCEPTION 'retention purge: the job was started for patients outside this record' USING ERRCODE = '42501';
  END IF;
  IF v_rec.purge_state = 'purged' THEN
    RETURN jsonb_build_object('state', 'purged', 'removed', '{}'::jsonb);
  END IF;
  IF v_rec.retained_until >= current_date THEN
    RAISE EXCEPTION 'retention purge: the retention period has not ended' USING ERRCODE = 'PS001';
  END IF;

  -- A legal hold on any document of the patient defers the whole purge; so does a document whose own retention has not ended.
  PERFORM pg_advisory_xact_lock(hashtextextended('doc-hold-patient:' || v_rec.patient_id::text, 0));
  IF EXISTS (SELECT 1 FROM documents.document d WHERE d.patient_id = ANY (v_ids)
              AND (SELECT h.action FROM documents.legal_hold h WHERE h.document_id = d.id ORDER BY h.seq DESC LIMIT 1) = 'placed') THEN
    UPDATE privacy.deletion_record SET purge_checked_at = v_now, purge_deferred_reason = 'legal_hold' WHERE id = p_record;
    RETURN jsonb_build_object('state', 'deferred', 'reason', 'legal_hold', 'removed', '{}'::jsonb);
  END IF;
  IF EXISTS (SELECT 1 FROM documents.document d WHERE d.patient_id = ANY (v_ids) AND d.status = 'confirmed' AND d.retention_until > current_date) THEN
    UPDATE privacy.deletion_record SET purge_checked_at = v_now, purge_deferred_reason = 'document_retention' WHERE id = p_record;
    RETURN jsonb_build_object('state', 'deferred', 'reason', 'document_retention', 'removed', '{}'::jsonb);
  END IF;

  -- The medical record, children first (the foreign keys decide the order).
  DELETE FROM clinical.note_addendum WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.note_addendum', v_n);
  DELETE FROM clinical.note_cosign WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.note_cosign', v_n);
  DELETE FROM clinical.note WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.note', v_n);
  DELETE FROM clinical.encounter WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.encounter', v_n);
  DELETE FROM clinical.referral_inbox i USING clinical.referral r WHERE i.referral_id = r.id AND r.patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.referral_inbox', v_n);
  DELETE FROM clinical.referral WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.referral', v_n);
  DELETE FROM clinical.follow_up WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.follow_up', v_n);
  DELETE FROM clinical.allergy WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.allergy', v_n);
  DELETE FROM clinical.problem WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.problem', v_n);
  DELETE FROM clinical.medication_statement WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.medication_statement', v_n);
  DELETE FROM clinical.vital_sign WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.vital_sign', v_n);
  DELETE FROM clinical.triage_assessment WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.triage_assessment', v_n);
  DELETE FROM clinical.consent_exception WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.consent_exception', v_n);
  DELETE FROM clinical.questionnaire_response WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('clinical.questionnaire_response', v_n);
  DELETE FROM patient.consent WHERE patient_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('patient.consent', v_n);

  -- Accepted documents: first marked deleted (documents.retention_sweep then removes the stored object and records it); the rows go
  -- once every version's object is gone.
  UPDATE documents.document SET status = 'deleted', deleted_at = v_now WHERE patient_id = ANY (v_ids) AND status <> 'deleted';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('documents.document_marked_deleted', v_n);
  DELETE FROM documents.legal_hold h USING documents.document d
   WHERE h.document_id = d.id AND d.patient_id = ANY (v_ids) AND d.status = 'deleted'
     AND NOT EXISTS (SELECT 1 FROM documents.document_version v WHERE v.document_id = d.id AND v.object_removed_at IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('documents.legal_hold', v_n);
  DELETE FROM documents.deletion_request q USING documents.document d
   WHERE q.document_id = d.id AND d.patient_id = ANY (v_ids) AND d.status = 'deleted'
     AND NOT EXISTS (SELECT 1 FROM documents.document_version v WHERE v.document_id = d.id AND v.object_removed_at IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('documents.deletion_request', v_n);
  DELETE FROM documents.document_version v USING documents.document d
   WHERE v.document_id = d.id AND d.patient_id = ANY (v_ids) AND d.status = 'deleted' AND v.object_removed_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM documents.document_version w WHERE w.document_id = d.id AND w.object_removed_at IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('documents.document_version', v_n);
  DELETE FROM documents.document d
   WHERE d.patient_id = ANY (v_ids) AND d.status = 'deleted'
     AND NOT EXISTS (SELECT 1 FROM documents.document_version v WHERE v.document_id = d.id);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_removed := v_removed || jsonb_build_object('documents.document', v_n);

  SELECT count(*)::integer INTO v_left FROM documents.document WHERE patient_id = ANY (v_ids);
  IF v_left = 0 THEN
    UPDATE privacy.deletion_record SET purge_state = 'purged', purged_at = v_now, purge_checked_at = v_now, purge_deferred_reason = NULL WHERE id = p_record;
    RETURN jsonb_build_object('state', 'purged', 'removed', v_removed);
  END IF;
  UPDATE privacy.deletion_record SET purge_state = 'objects_pending', purge_checked_at = v_now, purge_deferred_reason = NULL WHERE id = p_record;
  RETURN jsonb_build_object('state', 'objects_pending', 'removed', v_removed, 'documentsLeft', v_left);
END
$$;

CREATE FUNCTION privacy.purge_hipaa_documentation(p_cutoff date) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org   uuid := kernel.uuid1('app.org_id');
  v_req   uuid[];
  v_n     integer;
  v_out   jsonb := '{}'::jsonb;
BEGIN
  IF v_org IS NULL OR kernel.setting('app.audience') IS DISTINCT FROM 'system' OR kernel.setting('app.job_scope') IS DISTINCT FROM 'org' THEN
    RAISE EXCEPTION 'retention purge: only the organisation-scope system job may call this' USING ERRCODE = '42501';
  END IF;
  -- A cut-off less than a year old is a mistake, not a retention period.
  IF p_cutoff IS NULL OR p_cutoff > current_date - 365 THEN
    RAISE EXCEPTION 'retention purge: the cut-off date must be at least a year in the past' USING ERRCODE = 'PS001';
  END IF;

  -- Purged deletion records first: they are the evidence that the medical record was purged, and the purge job needs them until then.
  WITH gone AS (
    DELETE FROM privacy.deletion_record d WHERE d.organisation_id = v_org AND d.purge_state = 'purged' AND d.purged_at::date <= p_cutoff
    RETURNING d.request_id)
  SELECT count(*)::integer, coalesce(array_agg(request_id), '{}'::uuid[]) INTO v_n, v_req FROM gone;
  v_out := v_out || jsonb_build_object('privacy.deletion_record', v_n);

  -- Finished requests: any kind but deletion by their decision date; a deletion request once its record is gone (or when it was refused).
  v_req := v_req || coalesce((
    SELECT array_agg(r.id) FROM privacy.request r
     WHERE r.organisation_id = v_org AND r.status IN ('fulfilled', 'refused') AND r.decided_at::date <= p_cutoff
       AND (r.kind <> 'deletion' OR (r.status = 'refused' AND NOT EXISTS (SELECT 1 FROM privacy.deletion_record d WHERE d.request_id = r.id)))), '{}'::uuid[]);
  -- A request with a package that is still downloadable keeps it (and itself) until the package has expired.
  v_req := coalesce((
    SELECT array_agg(r.id) FROM privacy.request r
     WHERE r.id = ANY (v_req) AND NOT EXISTS (SELECT 1 FROM privacy.export_package p WHERE p.request_id = r.id AND p.status IN ('assembling', 'ready', 'released'))), '{}'::uuid[]);
  DELETE FROM privacy.export_package WHERE request_id = ANY (v_req);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_out := v_out || jsonb_build_object('privacy.export_package', v_n);
  DELETE FROM privacy.request WHERE id = ANY (v_req) AND status IN ('fulfilled', 'refused');
  GET DIAGNOSTICS v_n = ROW_COUNT; v_out := v_out || jsonb_build_object('privacy.request', v_n);

  DELETE FROM privacy.incident_patient ip USING privacy.incident i
   WHERE ip.incident_id = i.id AND i.organisation_id = v_org AND i.status = 'closed' AND i.closed_at::date <= p_cutoff;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_out := v_out || jsonb_build_object('privacy.incident_patient', v_n);
  DELETE FROM privacy.incident i
   WHERE i.organisation_id = v_org AND i.status = 'closed' AND i.closed_at::date <= p_cutoff;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_out := v_out || jsonb_build_object('privacy.incident', v_n);
  RETURN v_out;
END
$$;

-- Ownership, execution rights ---------------------------------------------------------------------------------------------
-- (revoke and grant first: the owner change moves the ACL, as in 2503)
REVOKE ALL ON FUNCTION privacy.patient_closure(uuid), privacy.deletion_job_check(uuid), privacy.delete_nonrecord_data(uuid),
  privacy.purge_medical_record(uuid), privacy.purge_hipaa_documentation(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy.delete_nonrecord_data(uuid), privacy.purge_medical_record(uuid), privacy.purge_hipaa_documentation(date) TO app_worker;
ALTER FUNCTION privacy.patient_closure(uuid) OWNER TO privacy_retention_owner;
ALTER FUNCTION privacy.deletion_job_check(uuid) OWNER TO privacy_retention_owner;
ALTER FUNCTION privacy.delete_nonrecord_data(uuid) OWNER TO privacy_retention_owner;
ALTER FUNCTION privacy.purge_medical_record(uuid) OWNER TO privacy_retention_owner;
ALTER FUNCTION privacy.purge_hipaa_documentation(date) OWNER TO privacy_retention_owner;
REVOKE CREATE ON SCHEMA privacy FROM privacy_retention_owner;

-- The refusing triggers: one extra condition, so only the retention role passes (the definer functions above).
CREATE OR REPLACE TRIGGER consent_exception_append_only BEFORE DELETE OR UPDATE ON clinical.consent_exception FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION clinical.frontdoor_refuse_change();
CREATE OR REPLACE TRIGGER encounter_no_delete BEFORE DELETE ON clinical.encounter FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION clinical.notes_refuse_delete();
CREATE OR REPLACE TRIGGER follow_up_no_delete BEFORE DELETE ON clinical.follow_up FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION clinical.frontdoor_refuse_delete();
CREATE OR REPLACE TRIGGER note_no_delete BEFORE DELETE ON clinical.note FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION clinical.notes_refuse_delete();
CREATE OR REPLACE TRIGGER note_addendum_append_only BEFORE DELETE OR UPDATE ON clinical.note_addendum FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION clinical.notes_refuse_change();
CREATE OR REPLACE TRIGGER note_cosign_append_only BEFORE DELETE OR UPDATE ON clinical.note_cosign FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION clinical.notes_refuse_change();
CREATE OR REPLACE TRIGGER questionnaire_response_no_delete BEFORE DELETE ON clinical.questionnaire_response FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION clinical.frontdoor_refuse_delete();
CREATE OR REPLACE TRIGGER referral_no_delete BEFORE DELETE ON clinical.referral FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION clinical.frontdoor_refuse_delete();
CREATE OR REPLACE TRIGGER referral_inbox_no_delete BEFORE DELETE ON clinical.referral_inbox FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION clinical.frontdoor_refuse_delete();
CREATE OR REPLACE TRIGGER triage_assessment_append_only BEFORE DELETE OR UPDATE ON clinical.triage_assessment FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION clinical.frontdoor_refuse_change();
CREATE OR REPLACE TRIGGER vital_sign_append_only BEFORE DELETE OR UPDATE ON clinical.vital_sign FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION clinical.refuse_change();
CREATE OR REPLACE TRIGGER legal_hold_append_only BEFORE DELETE OR UPDATE ON documents.legal_hold FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION documents.refuse_change();
CREATE OR REPLACE TRIGGER export_package_no_delete BEFORE DELETE ON privacy.export_package FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION privacy.refuse_delete();
CREATE OR REPLACE TRIGGER incident_no_delete BEFORE DELETE ON privacy.incident FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION privacy.refuse_delete();
CREATE OR REPLACE TRIGGER incident_patient_no_delete BEFORE DELETE ON privacy.incident_patient FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION privacy.refuse_delete();
CREATE OR REPLACE TRIGGER request_no_delete BEFORE DELETE ON privacy.request FOR EACH ROW WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION privacy.refuse_delete();
