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
export const ownerRightsViews = [];
/** Views reporting_ro may read (C0/C1 only, M-4). */
export const reportingViews = [];
/** Tables with a patient_id column that are exempt from the merge write guard (SHARED-BOUNDARIES 9.2). */
export const patientGuardExempt = ['audit.event', 'audit.btg_grant'];
/** SECURITY DEFINER functions of SHARED-BOUNDARIES 6.2 and ARCHITECTURE 21.6 (schema.name). Empty: none exist yet. */
export const definerInventory = [];

/** Policies that can match audience `anonymous` (ARCHITECTURE 21.3 list, kernel rows only so far). */
export const anonymousPolicies = [
  'kernel.setting.setting_read_pre_auth',
  'kernel.rate_counter.rate_counter_org',
];
/**
 * Policies that can match audience `public`: must be exactly the T-DIRECTORY policies. Accepted exception,
 * recorded as open note F03-N1: rate_counter_org is "organisation only, every audience" (ARCHITECTURE 22.1), so
 * it can match `public` at the database level while 21.3 says public cannot reach it. No /public/v1 code path
 * touches it; the Architect decides whether to add `audience <> 'public'`.
 */
export const publicPolicies = ['kernel.rate_counter.rate_counter_org'];
