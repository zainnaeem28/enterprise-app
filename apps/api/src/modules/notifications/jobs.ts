// Job types this module owns (ARCHITECTURE 33.1). Handlers live in apps/worker/src/jobs/notifications; the API tier needs
// the names to enqueue `send_message` inside the business transaction (21.8). Keep the two lists in step (a test compares them).
import type { JobType } from '@ehr/kernel';

export const NOTIFICATIONS_JOBS: readonly JobType[] = [
  // Patient recipient: carries the patient ID (scope `patients`), resolves to the survivor after a merge.
  {
    name: 'notifications.send_message',
    maxAttempts: 8,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  // Principal recipient (staff notices): no patient ID.
  {
    name: 'notifications.send_staff_message',
    maxAttempts: 8,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'job',
  },
];

/** Events this module publishes (24). */
export const NOTIFICATIONS_EVENTS = ['notifications.delivery_failed'] as const;
