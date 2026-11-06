// Job types of the documents module (ARCHITECTURE 25.10, 33.1). Keep apps/api/src/modules/documents/jobs.ts in step (each side's test
// pins the same list).
import type { JobType } from '@ehr/kernel';

export const DOCUMENTS_JOBS: readonly JobType[] = [
  {
    name: 'documents.await_scan',
    maxAttempts: 25,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  {
    name: 'documents.ocr_suggest',
    maxAttempts: 8,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  {
    name: 'documents.retention_sweep',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];

/** graphile-worker crontab: the sweep daily at 03:40 (33.1). */
export const DOCUMENTS_CRONTAB = '40 3 * * * documents.retention_sweep';
