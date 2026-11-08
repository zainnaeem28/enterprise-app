// Job types and events of the messaging module (ARCHITECTURE 33.1, 24). The worker mirrors this list in its own job registry.
//
//   messaging.on_correction_requested   handler of `privacy.correction_requested` (published when compliance approves a correction
//                                       request, 22.14). Payload {requestId, patientId}. Creates ONE task (source `privacy_correction`,
//                                       source_ref = the request) for the staff who care for the patient. on_merged = resolve: the
//                                       task is a new row on whatever patient the job resolves to.
import type { JobRegistry, JobType } from '@ehr/kernel';

export const CORRECTION_EVENT = 'privacy.correction_requested';
export const ON_CORRECTION_JOB = 'messaging.on_correction_requested';

export const MESSAGING_JOBS: readonly JobType[] = [
  {
    name: ON_CORRECTION_JOB,
    maxAttempts: 8,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
];

/** Registers the one event this module handles, in the process-wide job registry, at start-up. */
export function registerMessagingHandlers(registry: Pick<JobRegistry, 'registerHandler'>): void {
  registry.registerHandler(CORRECTION_EVENT, 'messaging');
}

/** Events this module publishes (24). */
export const MESSAGING_EVENTS = ['messaging.task_created'] as const;
