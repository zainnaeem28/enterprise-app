// Task handlers of the privacy module (ARCHITECTURE 33.1). `createPrivacyTasks` returns a task table for the worker's `startWorker({ tasks })`;
// `definePrivacyJobs` registers the types with the JobRegistry. PRIVACY_CRONTAB is wired at integration (the runner does not pass a
// crontab yet, as for the other modules).
//
// `privacy.assemble_export` is the API package's `assembleExport` (it consumes the participant registry the composition root filled and
// calls every module's contributor, which lives in the API tier's code): the composition root passes it as `assemble`. The worker's
// package writer is the one outside dependency of that job (the store's real adapter is delivered at staging, C-01).
import type { Task } from 'graphile-worker';
import type { JobRegistry } from '@ehr/kernel';
import { runCheckLegalHolds } from './check-legal-holds.js';
import { runExecuteDeletion } from './execute-deletion.js';
import { runExpirePackages } from './expire-packages.js';
import { runRetentionPurge } from './retention-purge.js';
import { runSendDeletionStatement } from './send-deletion-statement.js';
import { PRIVACY_JOBS } from './jobs.js';
import type { RetentionJobDeps } from './ports.js';

export { PRIVACY_CRONTAB, PRIVACY_JOBS } from './jobs.js';
export { runCheckLegalHolds } from './check-legal-holds.js';
export type { HoldCheckOutcome } from './check-legal-holds.js';
export { runExpirePackages } from './expire-packages.js';
export type { ExpireResult } from './expire-packages.js';
export { runExecuteDeletion, SEND_STATEMENT_JOB } from './execute-deletion.js';
export type { ExecuteDeletionOutcome } from './execute-deletion.js';
export { runSendDeletionStatement } from './send-deletion-statement.js';
export type { SendStatementOutcome } from './send-deletion-statement.js';
export { runRetentionPurge } from './retention-purge.js';
export type { RetentionReport } from './retention-purge.js';
export { readRetentionBasis } from './retention-basis.js';
export type { RetentionBasis } from './retention-basis.js';
export {
  buildDeletionStatement,
  renderStatementText,
  DELETED_CLASS_LABELS,
  KEPT_CLASS_LABELS,
} from './statement.js';
export type { DeletionStatement, StatementInput } from './statement.js';
export { closureOf, documentsLegalHolds } from './adapters.js';
export { CiPackageStore } from './ci-package-store.js';
export type {
  DeletionStatementSender,
  LegalHoldReader,
  PackageWriter,
  PrivacyJobDeps,
  RetentionJobDeps,
  RetentionPolicyPort,
  WorkerPackageStore,
} from './ports.js';

export function definePrivacyJobs(registry: JobRegistry): void {
  for (const j of PRIVACY_JOBS) registry.defineJob(j);
}

export interface PrivacyTaskDeps extends RetentionJobDeps {
  assemble: (
    payload: Record<string, unknown>,
    ctx: { jobId: string; attempt: number; maxAttempts: number },
  ) => Promise<unknown>;
}

export function createPrivacyTasks(deps: PrivacyTaskDeps): Record<string, Task> {
  return {
    'privacy.assemble_export': async (payload, helpers) => {
      await deps.assemble(payload as Record<string, unknown>, {
        jobId: `privacy.assemble_export:${helpers.job.id}`,
        attempt: helpers.job.attempts,
        maxAttempts: helpers.job.max_attempts,
      });
    },
    'privacy.check_legal_holds': async (payload, helpers) => {
      await runCheckLegalHolds(
        deps,
        payload as Record<string, unknown>,
        `privacy.check_legal_holds:${helpers.job.id}`,
      );
    },
    'privacy.execute_deletion': async (payload, helpers) => {
      await runExecuteDeletion(
        deps,
        payload as Record<string, unknown>,
        `privacy.execute_deletion:${helpers.job.id}`,
      );
    },
    'privacy.send_deletion_statement': async (payload, helpers) => {
      await runSendDeletionStatement(
        deps,
        payload as Record<string, unknown>,
        `privacy.send_deletion_statement:${helpers.job.id}`,
      );
    },
    'privacy.retention_purge': async (_payload, helpers) => {
      await runRetentionPurge(deps, { jobRef: `privacy.retention_purge:${helpers.job.id}` });
    },
    'privacy.expire_packages': async (_payload, helpers) => {
      await runExpirePackages(deps, { jobRef: `privacy.expire_packages:${helpers.job.id}` });
    },
  };
}
