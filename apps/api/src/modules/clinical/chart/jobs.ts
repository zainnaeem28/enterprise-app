// Job types and events of the clinical chart (ARCHITECTURE 33.1, 24). The handler lives in apps/worker/src/jobs/clinical; the API
// tier needs the name to enqueue `clinical.terminology_load` for an admin trigger. Keep the two lists in step (the worker's test pins
// the same list).
import type { JobType } from '@ehr/kernel';

export const CLINICAL_CHART_JOBS: readonly JobType[] = [
  // Reference data (C0): no patient, organisation scope. Chunked: each chunk is its own transaction inside the 60 s bound, and the
  // job resumes from the last committed chunk when it is retried. Class `job`, not `data_repair` (33.1).
  {
    name: 'clinical.terminology_load',
    maxAttempts: 5,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'system',
  },
];

/** Events this module's chart part publishes (24). None in this ticket: the chart tables publish nothing. */
export const CLINICAL_CHART_EVENTS = [] as const;
