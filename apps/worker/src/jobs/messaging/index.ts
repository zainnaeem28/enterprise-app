// Task handler of the messaging module (ARCHITECTURE 33.1). The work is the API package's `runOnCorrectionRequested` (it opens its own
// patients-scope transaction), reached through the port below; `apps/api/src/worker-ports.ts` implements it.
import { createHash } from 'node:crypto';
import type { Task } from 'graphile-worker';
import type { JobRegistry } from '@ehr/kernel';
import { MESSAGING_JOBS } from './jobs.js';

export { MESSAGING_JOBS } from './jobs.js';

export interface MessagingWorkerPort {
  /** `jobId` is a UUID naming the queue job; a redelivery of the same job passes the same one. */
  onCorrectionRequested(
    payload: Record<string, unknown>,
    jobId: string,
  ): Promise<'created' | 'already_exists'>;
}

export function defineMessagingJobs(registry: JobRegistry): void {
  for (const j of MESSAGING_JOBS) registry.defineJob(j);
}

/** A stable UUID (version 5 layout) for a library job: the task records it as `created_by_job`, and a retry must present the same one. */
export function jobUuid(type: string, libraryJobId: string): string {
  const h = createHash('sha256').update(`${type}:${libraryJobId}`).digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x50;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export function createMessagingTasks(deps: {
  messaging: MessagingWorkerPort;
}): Record<string, Task> {
  return {
    'messaging.on_correction_requested': async (payload, helpers) => {
      await deps.messaging.onCorrectionRequested(
        payload as Record<string, unknown>,
        jobUuid('messaging.on_correction_requested', String(helpers.job.id)),
      );
    },
  };
}
