// `privacy.send_deletion_statement` (owner ruling C, item 1 (d)): sends the patient the statement stored on the deletion record, then
// records that it was sent. The send is outside the database transaction; a failure (for instance the e-mail provider is not configured:
// C-11) leaves the record unsent and the job is retried. At-least-once: if the mark fails after a send, the retry sends again, which the
// sender port must tolerate (it is told the record ID to deduplicate on).
import { isUuid } from './ids.js';
import type { RetentionJobDeps } from './ports.js';
import { patientsScope, systemScope } from './scope.js';
import { renderStatementText, type DeletionStatement } from './statement.js';

type Row = Record<string, unknown>;

export type SendStatementOutcome = 'sent' | 'already_sent' | 'gone';

export async function runSendDeletionStatement(
  deps: RetentionJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'privacy.send_deletion_statement',
): Promise<SendStatementOutcome> {
  const requestId = payload['requestId'];
  if (!isUuid(requestId)) throw new Error('privacy.send_deletion_statement: bad payload');
  const now = (deps.now ?? ((): Date => new Date()))();

  const rec = await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const r = (
      await tx.query(
        `SELECT d.id, d.statement, d.statement_sent_at, q.patient_id
           FROM privacy.deletion_record d JOIN privacy.request q ON q.id = d.request_id
          WHERE d.request_id = $1::uuid`,
        [requestId],
      )
    ).rows[0] as Row | undefined;
    if (r === undefined) return undefined;
    return {
      id: String(r['id']),
      statement: r['statement'] as DeletionStatement,
      sent: r['statement_sent_at'] !== null,
      patientId: String(r['patient_id']),
      ids: await deps.closureOf(tx, String(r['patient_id'])),
    };
  });
  if (rec === undefined) return 'gone';
  if (rec.sent) return 'already_sent';
  const { subject, text } = renderStatementText(rec.statement);
  await deps.statements.send({
    recordId: rec.id,
    requestId,
    patientId: rec.patientId,
    subject,
    text,
    statement: rec.statement,
  });
  const ids = [...new Set([rec.patientId, ...rec.ids])].sort();
  await deps.db.withScope(patientsScope(deps.orgId, ids), async (tx) => {
    await tx.lockPatients([rec.patientId], 'key_share');
    const u = await tx.query(
      `UPDATE privacy.deletion_record SET statement_sent_at = $2::timestamptz WHERE id = $1::uuid AND statement_sent_at IS NULL`,
      [rec.id, now.toISOString()],
    );
    if ((u.rowCount ?? 0) === 0) return;
    await tx.query(
      `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, resource_id, patient_id, change, outcome)
       VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, 'worker', 'system', 'update', 'privacy.deletion_record', $2::uuid, $3::uuid, $4::jsonb, 'allowed')`,
      [
        `${jobRef}:${requestId}`.slice(0, 200),
        rec.id,
        rec.patientId,
        JSON.stringify({ statementSent: true }),
      ],
    );
  });
  return 'sent';
}
