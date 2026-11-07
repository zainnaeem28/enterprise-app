// Job types the admin realm enqueues (ARCHITECTURE 33.1, 26.3 B2-9). The handlers live in the worker (the compliance alert and
// the PHI-free notice to the security contact mailbox; audit events for the paths where audience `anonymous` cannot write to
// `audit.event`). Payloads carry IDs and a snake_case `kind` only (BD-09).
import type { JobType } from '@ehr/kernel';

export const ADMIN_EVENT_KINDS = [
  'credential_enrolled',
  'credential_revoked',
  'counter_regression',
  'enrolment_token_requested',
  'enrolment_token_approved',
  'role_change_requested',
  'role_change_decided',
  'handle_failures',
] as const;
export type AdminEventKind = (typeof ADMIN_EVENT_KINDS)[number];

export const IDENTITY_ADMIN_JOBS: readonly JobType[] = [
  {
    name: 'identity.admin_event',
    maxAttempts: 8,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'job',
  },
];

/** Events this part of the module publishes (24). Handlers register in notifications and audit. */
export const IDENTITY_ADMIN_EVENTS = ['identity.kill_switch_used'] as const;
