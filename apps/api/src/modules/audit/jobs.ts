// Job types this module owns (ARCHITECTURE 33.1). The handlers live in apps/worker/src/jobs/audit; the API tier only
// needs the names to enqueue `audit.export`. Keep the two lists in step (the worker test compares them).
import type { JobType } from '@ehr/kernel';

export const AUDIT_JOBS: readonly JobType[] = [
  {
    name: 'audit.anchor',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
  {
    name: 'audit.archive_anchors',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
  {
    name: 'audit.verify_anchors',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
  {
    name: 'audit.export',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'job',
  },
];
