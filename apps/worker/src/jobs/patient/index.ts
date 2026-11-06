// Task handlers of the patient module (ARCHITECTURE 33.1). `createPatientTasks` returns a task table for the worker's
// `startWorker({ tasks })`; `definePatientJobs` registers the types with the JobRegistry. PATIENT_CRONTAB is wired at integration
// (the runner does not pass a crontab yet, as for identity). `patient.execute_merge` is BE-09's.
import type { Task } from 'graphile-worker';
import type { JobRegistry, KernelDb } from '@ehr/kernel';
import { PATIENT_JOBS } from './jobs.js';
import { runPurgeMatchChecks } from './purge-match-checks.js';
import { runVerifyStaffScope } from './verify-staff-scope.js';
import type { VerifyDeps } from './verify-staff-scope.js';

export { PATIENT_CRONTAB, PATIENT_JOBS } from './jobs.js';
export { runVerifyStaffScope } from './verify-staff-scope.js';
export type { DriftReport, VerifyDeps } from './verify-staff-scope.js';
export { runPurgeMatchChecks } from './purge-match-checks.js';
export { createSurvivorOf, patientRecipientContributor } from './recipient.js';

export function definePatientJobs(registry: JobRegistry): void {
  for (const j of PATIENT_JOBS) registry.defineJob(j);
}

export interface PatientTaskDeps {
  db: KernelDb;
  orgId: string;
  onDrift?: VerifyDeps['onDrift'];
}

export function createPatientTasks(deps: PatientTaskDeps): Record<string, Task> {
  return {
    'patient.verify_staff_scope': async (_payload, helpers) => {
      await runVerifyStaffScope({
        db: deps.db,
        orgId: deps.orgId,
        jobId: `patient.verify_staff_scope:${helpers.job.id}`,
        ...(deps.onDrift === undefined ? {} : { onDrift: deps.onDrift }),
      });
    },
    'patient.purge_match_checks': async () => {
      await runPurgeMatchChecks({ db: deps.db, orgId: deps.orgId });
    },
  };
}
