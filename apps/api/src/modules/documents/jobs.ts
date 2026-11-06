// Job types and events of the documents module (ARCHITECTURE 25.10, 33.1, 24). The handlers live in apps/worker/src/jobs/documents;
// the API tier needs the names to enqueue `documents.await_scan` inside the business transaction (21.8). Keep the two lists in step
// (the worker's test pins the same list).
import type { JobType } from '@ehr/kernel';

export const DOCUMENTS_JOBS: readonly JobType[] = [
  // Upload complete: poll the scan result, move the clean file, set the status. Carries the patient (a merge may re-point the rows
  // while it waits): on_merged = resolve, so its retry finishes on the survivor (22.16 "jobs in flight").
  {
    name: 'documents.await_scan',
    maxAttempts: 25,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  // Clean file: the OCR classification suggestion. Never decides anything; staff confirm.
  {
    name: 'documents.ocr_suggest',
    maxAttempts: 8,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'job',
  },
  // Daily: removes the stored objects of deleted and quarantined documents once the rules allow; deletes nothing else.
  {
    name: 'documents.retention_sweep',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];

/** graphile-worker crontab entry (33.1). */
export const DOCUMENTS_CRONTAB = '40 3 * * * documents.retention_sweep';

/** Events this module publishes (24). IDs only (BD-09). */
export const DOCUMENTS_EVENTS = ['documents.scan_completed', 'documents.quarantined'] as const;
