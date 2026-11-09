// Task handler of the reporting module (ARCHITECTURE 33.1). The work is the API package's `runRefreshOps` (it opens its own
// organisation-scope system transaction), reached through the port below; `apps/api/src/worker-ports.ts` implements it.
import type { Task } from 'graphile-worker';
import type { JobRegistry } from '@ehr/kernel';
import { REPORTING_JOBS } from './jobs.js';

export { REPORTING_CRONTAB, REPORTING_JOBS } from './jobs.js';

export interface ReportingWorkerPort {
  refreshOps(): Promise<unknown>;
}

export function defineReportingJobs(registry: JobRegistry): void {
  for (const j of REPORTING_JOBS) registry.defineJob(j);
}

export function createReportingTasks(deps: {
  reporting: ReportingWorkerPort;
}): Record<string, Task> {
  return {
    'reporting.refresh_ops': async () => {
      await deps.reporting.refreshOps();
    },
  };
}
