// `privacy.execute_deletion` (owner ruling 2026-11-11 C, item 1; PRD D-8, C-05 †): started when compliance approves a deletion request
// (identity already verified). In ONE transaction, under a patients-scope system scope for the patient and every merged ID:
//   1. the legal-hold and retention check: documents under a hold are counted (they are never deleted), the day the medical record may
//      be purged is computed from the retention settings, and the result is written on the request, where compliance sees it;
//   2. (a) the account is deactivated at once and (b) the data outside the medical record is deleted, by the gated definer function
//      `privacy.delete_nonrecord_data` (the medical record, the accepted documents and the audit trail are not touched);
//   3. the statement to the patient is built and stored with the counts on `privacy.deletion_record`, the request becomes `fulfilled`,
//      two audit events are written (counts per class, no PHI) and the statement job is queued, all in the same transaction.
// Either everything above happens or nothing does, so there is no half-deleted account. The job is idempotent: a request that is already
// fulfilled (or refused) is left alone. The medical record is purged later by `privacy.retention_purge`, when its retention ends.
import type { Tx } from '@ehr/kernel';
import { isUuid, uuidv7 } from './ids.js';
import type { RetentionJobDeps } from './ports.js';
import { readRetentionBasis } from './retention-basis.js';
import { patientsScope, systemScope } from './scope.js';
import { buildDeletionStatement } from './statement.js';

type Row = Record<string, unknown>;

export const SEND_STATEMENT_JOB = 'privacy.send_deletion_statement';

export type ExecuteDeletionOutcome = 'executed' | 'gone' | 'final';

const asCounts = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (typeof v === 'object' && v !== null)
    for (const [k, n] of Object.entries(v as Record<string, unknown>))
      if (Number.isInteger(n)) out[k] = n as number;
  return out;
};

export async function runExecuteDeletion(
  deps: RetentionJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'privacy.execute_deletion',
): Promise<ExecuteDeletionOutcome> {
  const requestId = payload['requestId'];
  if (!isUuid(requestId)) throw new Error('privacy.execute_deletion: bad payload');
  const now = (deps.now ?? ((): Date => new Date()))();

  // The request's patient today (a merge may have moved the request to the survivor, so the payload's ID can be stale).
  const found = await deps.db.withScope(systemScope(deps.orgId), async (tx: Tx) => {
    const r = (
      await tx.query(`SELECT patient_id, kind, status FROM privacy.request WHERE id = $1::uuid`, [
        requestId,
      ])
    ).rows[0] as Row | undefined;
    if (r === undefined) return undefined;
    return {
      patientId: String(r['patient_id']),
      kind: String(r['kind']),
      status: String(r['status']),
      ids: await deps.closureOf(tx, String(r['patient_id'])),
    };
  });
  if (found === undefined) return 'gone';
  if (found.kind !== 'deletion')
    throw new Error('privacy.execute_deletion: not a deletion request');
  if (found.status === 'fulfilled' || found.status === 'refused') return 'final';
  if (found.status !== 'in_progress')
    throw new Error('privacy.execute_deletion: the request is not approved'); // retried; the database refuses it too
  const ids = [...new Set([found.patientId, ...found.ids])].sort();

  return deps.db.withScope(patientsScope(deps.orgId, ids), async (tx) => {
    await tx.lockPatients([found.patientId], 'key_share');
    // 1. The legal-hold and retention check.
    const holds = await deps.holds.documentsUnderHold(tx, ids);
    const basis = await readRetentionBasis(tx, found.patientId, ids);
    const retainedUntil = deps.retention.medicalRecordRetainedUntil(basis);
    const checked = await tx.query(
      `UPDATE privacy.request SET legal_hold_documents = $2, legal_hold_checked_at = $3::timestamptz
        WHERE id = $1::uuid AND status = 'in_progress'`,
      [requestId, holds, now.toISOString()],
    );
    if ((checked.rowCount ?? 0) === 0) return 'final' as const;

    // 2. Deactivate the account and delete what is outside the medical record (the definer function re-checks the gate).
    const res = (await tx.query(`SELECT privacy.delete_nonrecord_data($1::uuid) AS r`, [requestId]))
      .rows[0] as Row;
    const r = (res['r'] ?? {}) as Record<string, unknown>;
    const deleted = asCounts(r['deleted']);
    const kept = asCounts(r['kept']);
    const keptByHold = asCounts(r['keptByHold']);
    const heldDocuments = Number(r['heldDocuments'] ?? 0);

    // 3. The statement, the record, the completion, the audit and the statement job.
    const statement = buildDeletionStatement({
      executedAt: now,
      deleted,
      kept,
      keptByHold,
      heldDocuments,
      keptUntil: retainedUntil,
      auditTrailYears: deps.retention.years.auditTrail,
    });
    const recordId = uuidv7();
    await tx.query(
      `INSERT INTO privacy.deletion_record (id, organisation_id, request_id, executed_at, principals_disabled, sessions_revoked,
                                            deleted_counts, kept_counts, held_documents, retained_until, statement, created_by_job)
       VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::timestamptz, $4::int, $5::int, $6::jsonb, $7::jsonb, $8::int, $9::date, $10::jsonb, NULL)`,
      [
        recordId,
        requestId,
        now.toISOString(),
        Number(r['principalsDisabled'] ?? 0),
        Number(r['sessionsRevoked'] ?? 0),
        JSON.stringify(deleted),
        JSON.stringify(kept),
        heldDocuments,
        retainedUntil,
        JSON.stringify(statement),
      ],
    );
    await tx.query(
      `UPDATE privacy.request SET status = 'fulfilled' WHERE id = $1::uuid AND status = 'in_progress'`,
      [requestId],
    );
    const audit = (resourceType: string, resourceId: string, action: string, change: unknown) =>
      tx.query(
        `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, resource_id, patient_id, change, outcome)
         VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, 'worker', 'system', $2, $3, $4::uuid, $5::uuid, $6::jsonb, 'allowed')`,
        [
          `${jobRef}:${requestId}`.slice(0, 200),
          action,
          resourceType,
          resourceId,
          found.patientId,
          JSON.stringify(change),
        ],
      );
    await audit('privacy.deletion_record', recordId, 'update', {
      operation: 'account_deletion',
      accountDeactivated: true,
      principalsDisabled: Number(r['principalsDisabled'] ?? 0),
      sessionsRevoked: Number(r['sessionsRevoked'] ?? 0),
      deleted,
      keptByHold,
      heldDocuments,
      retainedUntil,
    });
    await audit('privacy.request', requestId, 'update', {
      status: 'fulfilled',
      legalHoldChecked: true,
      deletionExecuted: true,
    });
    await deps.queue.enqueue(
      tx,
      SEND_STATEMENT_JOB,
      { requestId, patientId: found.patientId, recordId },
      { jobKey: `send_deletion_statement_${recordId}` },
    );
    return 'executed' as const;
  });
}
