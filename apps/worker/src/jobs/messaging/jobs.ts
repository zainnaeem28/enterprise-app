// Job types of the messaging module (ARCHITECTURE 33.1). Keep apps/api/src/modules/messaging/jobs.ts in step (the cross-check test pins
// the same list).
import type { JobType } from '@ehr/kernel';

export const MESSAGING_JOBS: readonly JobType[] = [
  // Handler of `privacy.correction_requested`: one staff task per approved correction request.
  {
    name: 'messaging.on_correction_requested',
    maxAttempts: 8,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
];
