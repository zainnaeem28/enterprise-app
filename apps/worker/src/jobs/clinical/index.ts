// Task handlers of the clinical chart part (ARCHITECTURE 33.1). `createClinicalTasks` returns a task table for the worker's
// `startWorker({ tasks })`; `defineClinicalChartJobs` registers the types with the JobRegistry.
import type { Task } from 'graphile-worker';
import type { JobRegistry, KernelDb } from '@ehr/kernel';
import type { ClinicalWorkerPort } from './ports.js';
import { patientsScope } from './scope.js';
import { CLINICAL_JOBS } from './jobs.js';
import { runTerminologyLoad } from './terminology-load.js';
import type { TerminologyLoadDeps } from './terminology-load.js';

export {
  CLINICAL_CHART_JOBS,
  CLINICAL_FRONTDOOR_JOBS,
  CLINICAL_JOBS,
  CLINICAL_NOTES_JOBS,
} from './jobs.js';
export { patientsScope, systemScope } from './scope.js';
export type { ClinicalWorkerPort } from './ports.js';
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
  for (const j of CLINICAL_JOBS) registry.defineJob(j);
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

export interface ClinicalWorkerTaskDeps {
  db: KernelDb;
  orgId: string;
  /** The API's front door and notes behind the two handlers (apps/api/src/worker-ports.ts). */
  clinical: ClinicalWorkerPort;
}

const idOf = (v: unknown, name: string): string => {
  if (
    typeof v !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  )
    throw new Error(`${name} is required`);
  return v.toLowerCase();
};

/** The handlers of the front door's and the notes' job types; each opens a patients-scope system transaction for the one patient. */
export function createClinicalWorkflowTasks(deps: ClinicalWorkerTaskDeps): Record<string, Task> {
  return {
    'clinical.on_alert_unacknowledged': async (payload) => {
      const p = payload as Record<string, unknown>;
      // An alert without a patient is not a red flag (ADR-022): nothing to re-target.
      if (p['patientId'] === undefined || p['patientId'] === null) return;
      const patientId = idOf(p['patientId'], 'patientId');
      const alertId = idOf(p['alertId'], 'alertId');
      await deps.db.withScope(patientsScope(deps.orgId, [patientId]), (tx) =>
        deps.clinical.retargetUnacknowledged(tx, alertId),
      );
    },
    'clinical.note_sign_reminder': async (payload) => {
      const p = payload as Record<string, unknown>;
      const patientId = idOf(p['patientId'], 'patientId');
      const encounterId = idOf(p['encounterId'], 'encounterId');
      await deps.db.withScope(patientsScope(deps.orgId, [patientId]), (tx) =>
        deps.clinical.noteSignReminder(tx, { encounterId, patientId }),
      );
    },
  };
}
