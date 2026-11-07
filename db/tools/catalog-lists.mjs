// The allow-lists the catalog checks compare against. Each later ticket that adds an object of one of
// these kinds adds it here in the same change; a review of this file is the review of the exception.

export const appRoles = ['app_api', 'app_worker', 'reporting_ro', 'audit_archiver'];
export const loginRoles = ['app_owner', ...appRoles];
export const noLoginRoles = [
  'scheduling_booking_owner',
  'patient_scope_owner',
  'patient_match_owner',
  'integration_receiver_owner',
  'queue_owner',
  'identity_signin_ro',
  'directory_ro',
];
export const functionOwnerRoles = [
  'scheduling_booking_owner',
  'patient_scope_owner',
  'patient_match_owner',
  'integration_receiver_owner',
];
/** Roles that may be the target of a policy (M-2, M-3). */
export const policyRoles = [
  'app_api',
  'app_worker',
  'identity_signin_ro',
  'directory_ro',
  'queue_owner',
  ...functionOwnerRoles,
];
/** audit-writing roles: role-level transaction_timeout must be 1..60 s (SAR-10). */
export const auditWritingRoles = ['app_api', 'app_worker', 'audit_archiver'];

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
/** Views reporting_ro may read (C0/C1 only, M-4). */
export const reportingViews = [];
/** INT01-F6 interim exemptions: emptied by BE-08 (all five tables now carry the guard). */
export const interimGuardExempt = [];
/** Tables with a patient_id column that are exempt from the merge write guard (SHARED-BOUNDARIES 9.2). */
export const patientGuardExempt = [
  'audit.event',
  'audit.btg_grant',
  // BE-08: derived, definer-written; the derivation must work for merged IDs too (SHARED-BOUNDARIES 6.6).
  'patient.staff_scope',
];
/** SECURITY DEFINER functions of SHARED-BOUNDARIES 6.2 and ARCHITECTURE 21.6 (schema.name). Empty: none exist yet. */
export const definerInventory = [
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
  'scheduling.occupy',
  'scheduling.set_status',
  'scheduling.expire_holds',
  // ARCHITECTURE amendment A-3 / SHARED-BOUNDARIES SB-A2 (HEAAA-190): BE-14 (migration 1403) is accepted. check_twin is above.
  // The refused module copies of the merge guard (documents/telehealth.guard_open_patient, scheduling.flow_guard_open_patient,
  // scheduling.guard_open_patient and ..._at_commit) are dropped by migrations 1600/1601 and must not be listed.
  'scheduling.replace_busy_blocks',
];

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
 * function for every module; the scheduling copy is removed by migration 1600/1601).
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
