// `privacy.retention_purge` (owner ruling 2026-11-11 C, item 2; PRD C-20 †): the daily retention job, organisation scope. It removes what
// the retention settings (apps/api/src/modules/privacy/retention.ts) say has reached its end and reports what it removed: counts per
// class, no PHI, written to `privacy.retention_run` and to the audit trail. It never deletes anything under a legal hold.
//
//   1. privacy export packages: expired and their objects removed `EHR_RETENTION_EXPORT_PACKAGE_DAYS` after creation (7 days);
//   2. medical record of an executed account deletion (privacy.deletion_record) whose retention end has passed, through the gated
//      definer function `privacy.purge_medical_record`. The end is recomputed from today's data (a later encounter moves it) before
//      anything is deleted. A legal hold on any document of the patient defers the purge of that patient, as does a document whose own
//      retention has not ended. Accepted documents are marked deleted and their objects are removed by documents.retention_sweep; their
//      rows go in a later run (`objects_pending`);
//   3. HIPAA documentation (finished privacy requests, expired packages, closed incidents, purged deletion records) after
//      `EHR_RETENTION_HIPAA_DOCUMENTATION_YEARS`, through `privacy.purge_hipaa_documentation`;
//   4. the audit trail and the audit anchors: NOT removed here. Audit rows are append-only and leave the hot store only through the
//      dual-controlled archive process (ARCHITECTURE section 6); their retention is enforced in the archive from the same settings. The
//      report states the cut-off date and that this job removed none.
// A failure in one class does not stop the others: the run is then `partial` and the failure is counted (class name only in the log).
import { isUuid, uuidv7 } from './ids.js';
import { runExpirePackages } from './expire-packages.js';
import type { RetentionJobDeps } from './ports.js';
import { readRetentionBasis } from './retention-basis.js';
import { patientsScope, systemScope } from './scope.js';

type Row = Record<string, unknown>;

export interface RetentionReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: 'completed' | 'partial';
  cutoffs: {
    today: string;
    exportPackagesCreatedBefore: string;
    hipaaDocumentationOnOrBefore: string;
    auditTrailOnOrBefore: string;
  };
  classes: {
    export_packages: { expired: number; failed: number };
    medical_record: {
      purged: number;
      objectsPending: number;
      deferredLegalHold: number;
      deferredDocumentRetention: number;
      extendedByNewerEncounter: number;
      failed: number;
      removed: Record<string, number>;
    };
    hipaa_documentation: { removed: Record<string, number>; failed: number };
    audit_trail: { removedByThisJob: 0; reason: 'archive_governed'; years: number };
    audit_anchors: { removedByThisJob: 0; reason: 'archive_governed'; years: number };
  };
}

const addInto = (acc: Record<string, number>, add: unknown): void => {
  if (typeof add !== 'object' || add === null) return;
  for (const [k, v] of Object.entries(add as Record<string, unknown>))
    if (Number.isInteger(v)) acc[k] = (acc[k] ?? 0) + (v as number);
};

export async function runRetentionPurge(
  deps: RetentionJobDeps,
  opts: { jobRef?: string; batch?: number } = {},
): Promise<RetentionReport> {
  const started = (deps.now ?? ((): Date => new Date()))();
  const today = started.toISOString().slice(0, 10);
  const jobRef = opts.jobRef ?? 'privacy.retention_purge';
  const batch = opts.batch ?? 500;
  const exportCutoff = deps.retention.exportPackageCutoff(started);
  const hipaaCutoff = deps.retention.hipaaDocumentationCutoff(today);
  const report: RetentionReport = {
    runId: uuidv7(),
    startedAt: started.toISOString(),
    finishedAt: started.toISOString(),
    status: 'completed',
    cutoffs: {
      today,
      exportPackagesCreatedBefore: exportCutoff.toISOString(),
      hipaaDocumentationOnOrBefore: hipaaCutoff,
      auditTrailOnOrBefore: deps.retention.auditCutoff(today),
    },
    classes: {
      export_packages: { expired: 0, failed: 0 },
      medical_record: {
        purged: 0,
        objectsPending: 0,
        deferredLegalHold: 0,
        deferredDocumentRetention: 0,
        extendedByNewerEncounter: 0,
        failed: 0,
        removed: {},
      },
      hipaa_documentation: { removed: {}, failed: 0 },
      audit_trail: {
        removedByThisJob: 0,
        reason: 'archive_governed',
        years: deps.retention.years.auditTrail,
      },
      audit_anchors: {
        removedByThisJob: 0,
        reason: 'archive_governed',
        years: deps.retention.years.auditAnchor,
      },
    },
  };

  // 1. Export packages.
  try {
    const r = await runExpirePackages(deps, {
      jobRef: `${jobRef}:packages`,
      createdBefore: exportCutoff,
    });
    report.classes.export_packages = { expired: r.expired, failed: r.failed };
    if (r.failed > 0) report.status = 'partial';
  } catch {
    report.classes.export_packages.failed += 1;
    report.status = 'partial';
    deps.log.warn('retention: export package expiry failed', { class: 'export_packages' });
  }

  // 2. The medical record of executed deletions whose retention has ended.
  const due = (
    await deps.db.withScope(systemScope(deps.orgId), (tx) =>
      tx.query(
        `SELECT d.id, d.request_id, d.purge_state, q.patient_id
           FROM privacy.deletion_record d JOIN privacy.request q ON q.id = d.request_id
          WHERE d.purge_state <> 'purged' AND d.retained_until < $1::date
          ORDER BY d.retained_until, d.id LIMIT $2::int`,
        [today, batch],
      ),
    )
  ).rows as Row[];
  for (const rec of due) {
    try {
      const patientId = String(rec['patient_id']);
      const recordId = String(rec['id']);
      if (!isUuid(patientId) || !isUuid(recordId)) continue;
      const ids = await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
        const c = await deps.closureOf(tx, patientId);
        return [...new Set([patientId, ...c])].sort();
      });
      await deps.db.withScope(patientsScope(deps.orgId, ids), async (tx) => {
        await tx.lockPatients([patientId], 'key_share');
        if (rec['purge_state'] === 'pending') {
          // Recompute from today's data: a newer encounter moves the end (the stored date is only the first answer).
          const end = deps.retention.medicalRecordRetainedUntil(
            await readRetentionBasis(tx, patientId, ids),
          );
          if (end >= today) {
            report.classes.medical_record.extendedByNewerEncounter += 1;
            return;
          }
        }
        const res = (
          await tx.query(`SELECT privacy.purge_medical_record($1::uuid) AS r`, [recordId])
        ).rows[0] as Row;
        const r = (res['r'] ?? {}) as Record<string, unknown>;
        const m = report.classes.medical_record;
        addInto(m.removed, r['removed']);
        if (r['state'] === 'purged') m.purged += 1;
        else if (r['state'] === 'objects_pending') m.objectsPending += 1;
        else if (r['state'] === 'deferred' && r['reason'] === 'legal_hold')
          m.deferredLegalHold += 1;
        else if (r['state'] === 'deferred') m.deferredDocumentRetention += 1;
        await tx.query(
          `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, resource_id, patient_id, change, outcome)
           VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, 'worker', 'system', 'update', 'privacy.deletion_record', $2::uuid, $3::uuid, $4::jsonb, 'allowed')`,
          [
            `${jobRef}:${recordId}`.slice(0, 200),
            recordId,
            patientId,
            JSON.stringify({
              operation: 'medical_record_purge',
              medicalRecordPurge: r['state'],
              reason: r['reason'] ?? null,
              removed: r['removed'] ?? {},
            }),
          ],
        );
      });
    } catch {
      report.classes.medical_record.failed += 1;
      report.status = 'partial';
      deps.log.warn('retention: a medical record purge failed and is retried tomorrow', {
        class: 'medical_record',
      });
    }
  }

  // 3. HIPAA documentation.
  try {
    const res = await deps.db.withScope(systemScope(deps.orgId), (tx) =>
      tx.query(`SELECT privacy.purge_hipaa_documentation($1::date) AS r`, [hipaaCutoff]),
    );
    addInto(report.classes.hipaa_documentation.removed, (res.rows[0] as Row)['r']);
  } catch {
    report.classes.hipaa_documentation.failed += 1;
    report.status = 'partial';
    deps.log.warn('retention: HIPAA documentation purge failed', { class: 'hipaa_documentation' });
  }

  // The report: one row and one audit event (counts per class, no PHI).
  report.finishedAt = (deps.now ?? ((): Date => new Date()))().toISOString();
  await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    await tx.query(
      `INSERT INTO privacy.retention_run (id, organisation_id, started_at, finished_at, status, report)
       VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::timestamptz, $3::timestamptz, $4, $5::jsonb)`,
      [report.runId, report.startedAt, report.finishedAt, report.status, JSON.stringify(report)],
    );
    await tx.query(
      `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, resource_id, patient_id, change, outcome)
       VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, 'worker', 'system', 'create', 'privacy.retention_run', $2::uuid, NULL, $3::jsonb, 'allowed')`,
      [
        jobRef.slice(0, 200),
        report.runId,
        JSON.stringify({ status: report.status, classes: report.classes }),
      ],
    );
  });
  return report;
}
