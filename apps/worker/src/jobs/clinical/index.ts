// Task handlers of the clinical chart part (ARCHITECTURE 33.1). `createClinicalTasks` returns a task table for the worker's
// `startWorker({ tasks })`; `defineClinicalChartJobs` registers the types with the JobRegistry.
import type { Task } from 'graphile-worker';
import type { JobRegistry } from '@ehr/kernel';
import { CLINICAL_CHART_JOBS } from './jobs.js';
import { runTerminologyLoad } from './terminology-load.js';
import type { TerminologyLoadDeps } from './terminology-load.js';

export { CLINICAL_CHART_JOBS } from './jobs.js';
export {
  CHUNK_SIZE,
  DEACTIVATE_BATCH,
  SYSTEMS,
  TerminologyLoadError,
  runTerminologyLoad,
} from './terminology-load.js';
export type {
  SourceChunk,
  SourceConcept,
  TerminologyLoadDeps,
  TerminologyLoadResult,
  TerminologySource,
} from './terminology-load.js';
export { InMemoryTerminologySource } from './stubs.js';

export function defineClinicalChartJobs(registry: JobRegistry): void {
  for (const j of CLINICAL_CHART_JOBS) registry.defineJob(j);
}

export function createClinicalTasks(
  deps: Omit<TerminologyLoadDeps, 'jobId'>,
): Record<string, Task> {
  return {
    'clinical.terminology_load': async (payload, helpers) => {
      await runTerminologyLoad(
        { ...deps, jobId: `clinical.terminology_load:${helpers.job.id}` },
        payload,
      );
    },
  };
}
