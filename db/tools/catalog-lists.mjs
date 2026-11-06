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
];
