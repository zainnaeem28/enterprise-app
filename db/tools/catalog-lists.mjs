// The allow-lists the catalog checks compare against. Each later ticket that adds an object of one of
// these kinds adds it here in the same change; a review of this file is the review of the exception.

export const appRoles = [
  'app_api',
  'app_worker',
  'reporting_ro',
  'audit_archiver',
  'app_bootstrap',
];
export const loginRoles = ['app_owner', ...appRoles];
export const noLoginRoles = [
  'scheduling_booking_owner',
  'patient_scope_owner',
  'patient_match_owner',
  'integration_receiver_owner',
  'queue_owner',
  'identity_signin_ro',
  'directory_ro',
  // INT04-F02b (HEAAA-466): owns identity.bootstrap_admins only.
  'identity_bootstrap_owner',
  // HEAAA-789 (C-BE-DEL, migration 2601): owns the account-deletion and retention-purge definer functions of the privacy module.
  'privacy_retention_owner',
];
export const functionOwnerRoles = [
  'scheduling_booking_owner',
  'patient_scope_owner',
  'patient_match_owner',
  'integration_receiver_owner',
  'identity_bootstrap_owner',
  'privacy_retention_owner',
];
/** Roles that may be the target of a policy (M-2, M-3). */
export const policyRoles = [
  'app_api',
  'app_worker',
  'identity_signin_ro',
  'directory_ro',
  'queue_owner',
  // BE-21 / INT03-F05 ruling (HEAAA-311): the reporting read models carry one SELECT policy TO reporting_ro each
  // (organisation only; C0/C1 operations tables of ARCHITECTURE 22.15). M-4-reporting bounds what it can read.
  'reporting_ro',
  ...functionOwnerRoles,
];
/** audit-writing roles: role-level transaction_timeout must be 1..60 s (SAR-10). */
export const auditWritingRoles = ['app_api', 'app_worker', 'audit_archiver', 'app_bootstrap'];

/** Schemas the table checks skip: system schemas, `public` (empty) and the runner's tracker. */
export const skippedSchemas = ['public', 'migration'];

/** Role grants that must exist, and no others among these roles. member -> [roles it may SET to]. */
export const expectedMemberships = {
  app_owner: [
    'scheduling_booking_owner',
    'patient_scope_owner',
    'patient_match_owner',
    'integration_receiver_owner',
    'directory_ro',
    'queue_owner',
    'identity_bootstrap_owner',
    'privacy_retention_owner',
  ],
  app_api: ['identity_signin_ro'],
};

/** Views that may lack security_invoker (C0/C1 lists). Empty until the directory and reporting tickets. */
export const ownerRightsViews = [
  'organisation.public_location',
  'organisation.public_service',
  'organisation.public_service_location',
  'organisation.public_service_clinician',
  'organisation.public_opening_hours',
  'organisation.public_holiday',
  'organisation.public_banner',
  'identity.public_clinician',
  // ARCHITECTURE 22.5.1 (TDR-14), the ninth C0 directory view; migration 1103, owner directory_ro (HEAAA-186 triage item 1).
  'scheduling.public_clinician_location',
];
/** Relations (views and read-model tables) reporting_ro may hold any privilege on: C0/C1 only (M-4). */
export const reportingViews = [
  // BE-21 / INT03-F05 ruling (HEAAA-311): the C1 operations read models of ARCHITECTURE 22.15 (ops_alert_backlog by
  // amendment F05-1). compliance_btg_summary is NOT listed: reporting_ro has no right on it.
  'reporting.ops_integration_health',
  'reporting.ops_queue',
  'reporting.ops_calendar_staleness',
  'reporting.ops_alert_backlog',
];
/** INT01-F6 interim exemptions: emptied by BE-08 (all five tables now carry the guard). */
export const interimGuardExempt = [];
/** Tables with a patient_id column that are exempt from the merge write guard (SHARED-BOUNDARIES 9.2). */
export const patientGuardExempt = [
  'audit.event',
  'audit.btg_grant',
  // BE-08: derived, definer-written; the derivation must work for merged IDs too (SHARED-BOUNDARIES 6.6).
  'patient.staff_scope',
  // ARCHITECTURE 22.14 table row and 22.16 note (G2, bd6de63): records history; HEAAA-310 ruling.
  'privacy.incident_patient',
];
/** SECURITY DEFINER functions of SHARED-BOUNDARIES 6.2 and ARCHITECTURE 21.6 (schema.name): 28 entries after the two A-4 amendments (messaging predicates; referral definers), INT-03 r3 merge, and identity.bootstrap_admins (A-6, INT04-F02b). */
export const definerInventory = [
  // INT04-F02b (HEAAA-466, A-6): the first-admin bootstrap; owner identity_bootstrap_owner, EXECUTE to app_bootstrap only.
  'identity.bootstrap_admins',
  'integration_core.receive_inbound',
  // BE-08 (patient): owners patient_scope_owner (writes) and patient_match_owner (reads); all fix search_path.
  'patient.guard_open_patient',
  'patient.lock_patients',
  'patient.ensure_care_relationship',
  'patient.end_care_relationship',
  'patient.verify_staff_scope',
  'patient.register',
  'patient.attach',
  'patient.match_candidates',
  'patient.identity_label',
  // HEAAA-181 F09 (0951): the twin check reads the hidden occupancy columns, so it runs as the twin's owner.
  'scheduling.check_twin',
  // HEAAA-179 ruling (d18f0aa3, ARCHITECTURE amendment A-2 / SHARED-BOUNDARIES SB-A1, 6.2 and ARCHITECTURE 21.6): the merge and
  // scheduling functions accepted as definers (conditions DF-1..DF-13), and the queue enqueue function of the queue install.
  'queue_api.enqueue',
  'patient.request_merge',
  'patient.get_merge_request',
  'patient.decide_merge',
  'patient.load_merge_job',
  'patient.begin_merge',
  'patient.complete_merge',
  'patient.fail_merge',
  // SEC03-F11 (HEAAA-687, migration 2503; spec docs/security/SEC03-F11-worker-merge-grants-hardening-spec.md section 3): the merge re-pointing
  // writes moved from app_worker grants into definer functions. Inventory entry needs the Solution Architect's sign-off (HEAAA-687 decision log).
  'patient.merge_job_check',
  'patient.merge_repoint_patient_contact',
  'patient.merge_repoint_insurance_coverage',
  'patient.merge_repoint_consent',
  'patient.merge_repoint_communication_preference',
  'patient.merge_repoint_care_team_member',
  'patient.merge_repoint_duplicate_flag',
  'scheduling.merge_repoint_slot_reservation',
  'scheduling.occupy',
  'scheduling.set_status',
  'scheduling.expire_holds',
  // ARCHITECTURE amendment A-3 / SHARED-BOUNDARIES SB-A2 (HEAAA-190): BE-14 (migration 1403) is accepted. check_twin is above.
  // The refused module copies of the merge guard (documents/telehealth.guard_open_patient, scheduling.flow_guard_open_patient,
  // scheduling.guard_open_patient and ..._at_commit) are dropped by migrations 1604/1605 (renumbered by INT-03), and the M4 copies by 2201; none may be listed.
  'scheduling.replace_busy_blocks',
  // ARCHITECTURE amendment A-4 / SHARED-BOUNDARIES SB-A3 (HEAAA-332 decision-log rev bf854c3a, HEAAA-310 ruling rev d9504db5): the two messaging
  // predicates, owner patient_scope_owner, migration 2002. messaging.is_creator is refused and dropped by 2204; it must not be listed.
  'messaging.is_participant',
  'messaging.is_owner',
  // ARCHITECTURE amendment A-4 (HEAAA-325 ruling rev e3fa32f4, G2 delta decision HEAAA-330; migration 2300): the receiving location's
  // referral accept/decline, bound to a sent internal referral with a pending inbox row (R-REF-2). Owner patient_scope_owner.
  'patient.lock_referral_patient',
  'patient.ensure_referral_care_relationship',
  // HEAAA-789 (C-BE-DEL, migration 2601): account deletion and retention purge, owner privacy_retention_owner. Inventory entries need the
  // Solution Architect's sign-off (HEAAA-789 decision log D2). EXECUTE to app_worker for the three entry points; the two helpers are owner-only.
  'privacy.patient_closure',
  'privacy.deletion_job_check',
  'privacy.delete_nonrecord_data',
  'privacy.purge_medical_record',
  'privacy.purge_hipaa_documentation',
];

/**
 * Exact attributes of the A-4 definers (Cybersecurity C-3, HEAAA-333 comment 5f4974c6): not only the names. `acl` is the proacl text
 * (no PUBLIC entry; owner, app_api and app_worker only), `config` the proconfig.
 */
export const messagingDefinerAttributes = {
  'messaging.is_participant(uuid)': {
    owner: 'patient_scope_owner',
    secdef: true,
    volatile: 's',
    config: ['search_path=pg_catalog'],
    acl: [
      'app_api=X/patient_scope_owner',
      'app_worker=X/patient_scope_owner',
      'patient_scope_owner=X/patient_scope_owner',
    ],
  },
  'messaging.is_owner(uuid)': {
    owner: 'patient_scope_owner',
    secdef: true,
    volatile: 's',
    config: ['search_path=pg_catalog'],
    acl: [
      'app_api=X/patient_scope_owner',
      'app_worker=X/patient_scope_owner',
      'patient_scope_owner=X/patient_scope_owner',
    ],
  },
};

/** Policies that can match audience `anonymous` (ARCHITECTURE 21.3 list, kernel rows only so far). */
export const anonymousPolicies = [
  'kernel.setting.setting_read_pre_auth',
  'kernel.rate_counter.rate_counter_org',
  // BE-02 (INT-N1): a verified webhook has no session; the policy is TO integration_receiver_owner only.
  'integration_core.inbound_message.inbound_message_receive',
  // BE-04 (INT01-F6): ARCHITECTURE 21.3 items (1) and (2). Each is an app_api policy gated on audience = 'anonymous'
  // and matches nothing until the API sets app.session_token_hash / app.auth_subject (after its own verification, 26.1).
  // (1) the one session lookup per request, by token hash
  'identity.session.session_lookup',
  // (2) T-SIGNIN on session: insert of the new token hash for the verified principal, realms patient_pool/google only
  'identity.session.session_signin_insert',
  // (2) T-SIGNIN on person: INSERT only, and only once app.auth_subject is set
  'identity.person.person_signin_insert',
  // (2) T-SIGNIN on principal: own row by auth_realm + subject (or unbound google email); insert limited to
  //     patient_pool/google (SEC01-F-07); update limited to binding the subject and last_sign_in_at (column grant)
  'identity.principal.principal_signin_select',
  'identity.principal.principal_signin_insert',
  'identity.principal.principal_signin_update',
  // BE-05 (ARCHITECTURE 21.3 items (2) to (5), B2 admin realm). Each is gated on audience = 'anonymous' and on a setting the
  // API sets only for its own check: app.auth_claim_handle (TO identity_signin_ro only), app.auth_enrolment_token_hash,
  // app.webauthn_challenge_id, or app.auth_realm + app.auth_subject after the assertion or attestation verified.
  // (2) T-SIGNIN: the admin-realm session insert; admin_credential insert, select and update; enrolment_token update to used
  'identity.session.session_signin_insert_admin',
  'identity.admin_credential.admin_credential_signin_insert',
  'identity.admin_credential.admin_credential_signin_select',
  'identity.admin_credential.admin_credential_signin_update',
  'identity.enrolment_token.enrolment_token_signin_update',
  // (3) T-SIGNIN-CLAIM: the pre-verification read, TO identity_signin_ro, column grants only
  'identity.principal.principal_signin_claim',
  'identity.admin_credential.admin_credential_signin_claim',
  // (4) the enrolment token by the hash of the presented token
  'identity.enrolment_token.enrolment_token_lookup',
  // (5) webauthn_challenge by id; INSERT for purposes sign_in and enrol only, never bound to a session
  'identity.webauthn_challenge.webauthn_challenge_anon_select',
  'identity.webauthn_challenge.webauthn_challenge_anon_update',
  'identity.webauthn_challenge.webauthn_challenge_anon_insert',
];
/**
 * Policies that can match audience `public`: must be exactly the T-DIRECTORY policies. Accepted exception,
 * recorded as open note F03-N1: rate_counter_org is "organisation only, every audience" (ARCHITECTURE 22.1), so
 * it can match `public` at the database level while 21.3 says public cannot reach it. No /public/v1 code path
 * touches it; the Architect decides whether to add `audience <> 'public'`.
 */
export const publicPolicies = [
  'kernel.rate_counter.rate_counter_org',
  'organisation.location.location_directory',
  'organisation.service.service_directory',
  'organisation.service_location.service_location_directory',
  'organisation.service_clinician.service_clinician_directory',
  'organisation.opening_hours.opening_hours_directory',
  'organisation.holiday.holiday_directory',
  'organisation.banner.banner_directory',
  'identity.principal.principal_directory',
  'identity.staff_profile.staff_profile_directory',
  // ARCHITECTURE 22.5.1: the T-DIRECTORY policy of the ninth C0 view (migration 1103; TO directory_ro, audience public/patient).
  'scheduling.availability_template.availability_template_directory',
];

/**
 * SEC03-F13 item 1: the functions that may serve as the merge write guard. Only patient.guard_open_patient (A-2/A-3: one
 * function for every module; the scheduling copy is removed by migrations 1604/1605 (renumbered by INT-03), and the M4 copies by 2201).
 */
export const patientGuardFunctions = ['patient.guard_open_patient'];

/**
 * SEC03-F13 item 3 (ARCHITECTURE 21.2, N-3): the exact column lists the application roles hold on kernel.setting.
 * app_api carries `id` beyond the six columns of 21.2 (NOT NULL, no default); see migration 0953.
 */
export const settingColumnGrants = {
  app_api: {
    INSERT: ['id', 'organisation_id', 'key', 'value', 'value_schema', 'location_id', 'created_by'],
    UPDATE: ['value'],
  },
  app_worker: {
    INSERT: [
      'id',
      'organisation_id',
      'key',
      'value',
      'value_schema',
      'location_id',
      'pre_auth',
      'created_by_job',
    ],
    UPDATE: ['value'],
  },
};

/** SEC03-F09: columns of the PHI-free occupancy twin that no application role may read (the twin names no principal). */
export const hiddenColumns = {
  'scheduling.slot_occupancy': ['created_by', 'created_by_job', 'session_key'],
};

/**
 * INT04-F02b (decision log 2.1, G-1..G-14): the COMPLETE privilege set of identity_bootstrap_owner. The check M-5-bootstrap-owner
 * compares the catalog with these lists in both directions, so a privilege added later without a review of this file fails the check.
 */
export const bootstrapOwner = {
  role: 'identity_bootstrap_owner',
  schemaUsage: ['audit', 'identity', 'kernel', 'organisation', 'queue_api'],
  tablePrivileges: [
    ['identity.bootstrap_run', 'INSERT'],
    ['identity.bootstrap_run', 'SELECT'],
    ['audit.event', 'INSERT'],
  ],
  columnPrivileges: {
    'identity.person': {
      INSERT: ['id', 'organisation_id', 'display_name', 'status', 'created_by_job'],
    },
    'identity.principal': {
      INSERT: [
        'id',
        'organisation_id',
        'person_id',
        'realm',
        'subject',
        'status',
        'disabled_reason',
        'created_by_job',
      ],
      SELECT: ['id', 'organisation_id', 'person_id', 'realm', 'subject', 'status'],
    },
    'identity.role': {
      SELECT: ['id', 'organisation_id', 'key', 'realm', 'privileged', 'location_bound'],
    },
    'identity.role_change_request': {
      INSERT: [
        'id',
        'organisation_id',
        'requester_person_id',
        'subject_principal_id',
        'change',
        'before',
        'request_hash',
        'status',
        'expires_at',
        'created_by_job',
      ],
      UPDATE: ['status', 'approver_person_id', 'decided_at'],
      SELECT: ['id', 'organisation_id', 'subject_principal_id', 'status'],
    },
    'identity.role_assignment': {
      INSERT: [
        'id',
        'organisation_id',
        'role_id',
        'principal_id',
        'granted_via_request_id',
        'created_by_job',
      ],
      SELECT: [
        'id',
        'organisation_id',
        'principal_id',
        'role_id',
        'granted_via_request_id',
        'revoked_at',
      ],
    },
    'identity.enrolment_token': {
      INSERT: [
        'id',
        'organisation_id',
        'principal_id',
        'requested_by_person_id',
        'expires_at',
        'status',
        'created_by_job',
      ],
      UPDATE: ['token_hash', 'approved_by_person_id', 'expires_at', 'status'],
      SELECT: ['id', 'organisation_id', 'principal_id', 'status'],
    },
    'identity.admin_credential': { SELECT: ['organisation_id', 'principal_id'] },
    'organisation.organisation': { SELECT: ['organisation_id'] },
  },
  functions: [
    'kernel.setting(text)',
    'kernel.uuid1(text)',
    'kernel.uuids(text)',
    'queue_api.enqueue(text,jsonb,timestamp with time zone,text,smallint)',
    // its own function (the owner's entry in the ACL)
    'identity.bootstrap_admins(text,text,jsonb,jsonb,bytea[])',
  ],
  ownedFunction: 'identity.bootstrap_admins(text,text,jsonb,jsonb,bytea[])',
  policies: [
    'identity.bootstrap_run.bootstrap_run_bootstrap_insert',
    'identity.bootstrap_run.bootstrap_run_bootstrap_select',
    'organisation.organisation.organisation_bootstrap_select',
    'identity.person.person_bootstrap_insert',
    'identity.principal.principal_bootstrap_insert',
    'identity.principal.principal_bootstrap_select',
    'identity.role.role_bootstrap_select',
    'identity.role_change_request.role_change_request_bootstrap_insert',
    'identity.role_change_request.role_change_request_bootstrap_update',
    'identity.role_change_request.role_change_request_bootstrap_select',
    'identity.role_assignment.role_assignment_bootstrap_insert',
    'identity.role_assignment.role_assignment_bootstrap_select',
    'identity.enrolment_token.enrolment_token_bootstrap_insert',
    'identity.enrolment_token.enrolment_token_bootstrap_update',
    'identity.enrolment_token.enrolment_token_bootstrap_select',
    'identity.admin_credential.admin_credential_bootstrap_select',
    'audit.event.event_insert_bootstrap',
  ],
};

/**
 * HEAAA-881 (decision HEAAA-880 D-880-5): every table that carries a patient id is either purged by privacy.purge_medical_record when the
 * medical-record retention ends (patientPurgeTables) or listed here with the reason it is not (patientPurgeExempt). A new patient-linked
 * table fails check M-6-patient-purge until its owner decides which. Whole schemas are exempt through patientPurgeExemptSchemas.
 */
export const patientPurgeTables = [
  'clinical.allergy',
  'clinical.consent_exception',
  'clinical.encounter',
  'clinical.follow_up',
  'clinical.medication_statement',
  'clinical.note',
  'clinical.note_addendum',
  'clinical.note_cosign',
  'clinical.problem',
  'clinical.questionnaire_response',
  'clinical.referral',
  'clinical.referral_inbox',
  'clinical.triage_assessment',
  'clinical.vital_sign',
  'documents.deletion_request',
  'documents.document',
  'documents.document_version',
  'documents.legal_hold',
  'identity.patient_link',
  'identity.proxy_grant',
  'messaging.message',
  'messaging.task',
  'messaging.thread',
  'messaging.thread_participant',
  'notifications.delivery_receipt',
  'notifications.in_app_read',
  'notifications.notification',
  'notifications.staff_alert',
  'notifications.staff_alert_event',
  'patient.care_relationship',
  'patient.care_team_member',
  'patient.communication_preference',
  'patient.consent',
  'patient.duplicate_flag',
  'patient.insurance_coverage',
  'patient.match_check',
  'patient.merge_request',
  'patient.merge_residue',
  'patient.patient_contact',
  'patient.patient_merge',
  'patient.staff_scope',
  'scheduling.check_in',
  'scheduling.no_show_flag',
  'scheduling.queue_entry',
  'scheduling.slot_occupancy',
  'scheduling.slot_reservation',
  'scheduling.waitlist_entry',
  'scheduling.waitlist_offer',
  'telehealth.join_token',
  'telehealth.location_confirmation',
  'telehealth.participant',
  'telehealth.video_session',
];
export const patientPurgeExempt = {
  // The tombstone: de-identified by the purge, deleted by purge_hipaa_documentation once no privacy.* row refers to it (D-880-3).
  'patient.patient': 'tombstone',
};
/** Schemas whose patient-linked rows follow their own period: audit (archive, 7 years) and privacy documentation (6 years). */
export const patientPurgeExemptSchemas = ['audit', 'privacy'];
