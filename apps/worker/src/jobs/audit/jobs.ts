// Job types of the audit module (ARCHITECTURE 33.1). Registered with the worker's JobRegistry so the queue library
// accepts them and `queue_api.task_type` can be synced. The API tier enqueues only `audit.export`.
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

/** graphile-worker crontab lines for the schedules of 33.1: anchor and its archive copy every minute, verification daily at 03:10 UTC. */
export const AUDIT_CRONTAB = [
  '* * * * * audit.anchor',
  '* * * * * audit.archive_anchors',
  '10 3 * * * audit.verify_anchors',
].join('\n');
