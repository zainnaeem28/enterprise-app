// Task handlers of the audit module (ARCHITECTURE 33.1). `createAuditTasks` returns a task table for the worker's
// `startWorker({ tasks })`; `defineAuditJobs` registers the types with the JobRegistry; AUDIT_CRONTAB holds the schedules.
// `WORKER_CRONTAB` (job-registry.ts) carries AUDIT_CRONTAB (SEC05-F01).
import type { Task } from 'graphile-worker';
import type { JobRegistry, KernelDb, Logger, Queue } from '@ehr/kernel';
import { runAnchor, type AnchorOptions } from './anchor.js';
import { runArchiveAnchors, type AnchorArchiveStore } from './archive.js';
import { runExportChunk, type ExportSink } from './export.js';
import { AUDIT_JOBS } from './jobs.js';
import { auditAnchorLateSeconds, type MetricSink } from './metrics.js';
import { runVerify } from './verify.js';

export { AUDIT_CRONTAB, AUDIT_JOBS } from './jobs.js';
export { runAnchor } from './anchor.js';
export { runExportChunk } from './export.js';
export type { ExportSink } from './export.js';
export { runVerify } from './verify.js';
export { runArchiveAnchors, canonicalAnchorBody, anchorArchiveKey } from './archive.js';
export type { AnchorArchiveStore, ArchiveVersion, PutResult } from './archive.js';
export { anchorHash, merkleRoot } from './merkle.js';
export { emfMetricSink } from './metrics.js';
export type { MetricSink } from './metrics.js';

export function defineAuditJobs(registry: JobRegistry): void {
  for (const j of AUDIT_JOBS) registry.defineJob(j);
}

export interface AuditTaskDeps {
  db: KernelDb;
  /** Worker-path queue (`new Queue(registry, 'worker')`). */
  queue: Queue;
  sink: ExportSink;
  orgId: string;
  log: Logger;
  anchor?: AnchorOptions;
  /** The Object Lock archive of anchors (SEC05-F02). Composition supplies a refusing port until the bucket exists. */
  archive: AnchorArchiveStore;
  /** Gauges: `AuditAnchorLateSeconds` after every anchor run, `AuditAnchorVerificationMismatch` after every verification. */
  metrics?: MetricSink;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAuditTasks(deps: AuditTaskDeps): Record<string, Task> {
  return {
    'audit.anchor': async () => {
      const r = await runAnchor(deps.db, deps.orgId, deps.anchor);
      // Once per run, also when it skipped (locked, up to date, no events): a silent chain must show as a growing number.
      if (deps.metrics !== undefined)
        deps.metrics.gauge(
          'AuditAnchorLateSeconds',
          await auditAnchorLateSeconds(deps.db, deps.orgId),
        );
      if (r.status === 'anchored' && r.lateRows > 0)
        deps.log.warn('audit anchor includes late rows', { lateRows: r.lateRows });
    },
    'audit.archive_anchors': async () => {
      const r = await runArchiveAnchors(deps.db, deps.orgId, {
        store: deps.archive,
        queue: deps.queue,
      });
      // Every run, also when nothing was archived: 0 when no anchor waits, the age of the oldest one otherwise.
      deps.metrics?.gauge('AuditAnchorArchiveLagSeconds', r.lagSeconds);
      if (r.failed > 0)
        deps.log.warn('audit anchor archive: object store errors', { failed: r.failed });
      if (r.differing > 0)
        deps.log.error('audit anchor archive: existing object differs', { anchors: r.differing });
    },
    'audit.verify_anchors': async () => {
      const r = await runVerify(deps.db, deps.orgId, { queue: deps.queue, archive: deps.archive });
      deps.metrics?.gauge('AuditAnchorVerificationMismatch', r.mismatches.length);
      // The database checks and the mismatch events are done; an unreadable archive fails the run so it retries and shows as failed.
      if (r.archive === 'unavailable') throw new Error('audit.verify_anchors: archive unavailable');
      if (r.mismatches.length > 0)
        deps.log.error('audit anchor mismatch', { mismatches: r.mismatches.length });
      if (r.partitionHorizonDays !== null && r.partitionHorizonDays < 60)
        deps.log.warn('audit partitions: fewer than 60 days left', {
          days: r.partitionHorizonDays,
        });
    },
    'audit.export': async (payload, helpers) => {
      const p = payload as { exportId?: unknown; organisationId?: unknown; chunk?: unknown };
      if (
        typeof p.exportId !== 'string' ||
        !UUID.test(p.exportId) ||
        p.organisationId !== deps.orgId ||
        typeof p.chunk !== 'number' ||
        !Number.isInteger(p.chunk) ||
        p.chunk < 0
      )
        throw new Error('audit.export: bad payload');
      await runExportChunk(deps.db, deps.orgId, p.exportId, p.chunk, {
        sink: deps.sink,
        queue: deps.queue,
      }).catch(async (err: unknown) => {
        // The last attempt marks the job failed so the requester sees an answer; earlier attempts retry.
        if (helpers.job.attempts >= helpers.job.max_attempts) {
          await deps.db.withScope(
            { audience: 'system', realm: 'worker', orgId: deps.orgId, jobScope: 'org' },
            (tx) =>
              tx
                .query(
                  `UPDATE audit.export_job SET status = 'failed' WHERE id = $1::uuid AND status IN ('queued', 'running')`,
                  [p.exportId],
                )
                .then(() => undefined),
          );
        }
        throw err;
      });
    },
  };
}
