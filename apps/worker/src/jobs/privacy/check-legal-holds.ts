// `privacy.check_legal_holds` (ARCHITECTURE 33.1, PRD BR-29): started when a deletion request is recorded. It counts the documents of
// the patient (and of every ID merged into the patient) that are under a legal hold and writes the count and the time on the request,
// where compliance sees it. A patient session cannot read holds, which is why the system does it. It deletes nothing and decides
// nothing: what deletion means is undecided (D-8), so the request stays `blocked_d8` whatever the count.
import type { Tx } from '@ehr/kernel';
import { isUuid } from './ids.js';
import type { PrivacyJobDeps } from './ports.js';
import { patientsScope, systemScope } from './scope.js';

type Row = Record<string, unknown>;

export type HoldCheckOutcome = 'checked' | 'gone' | 'final';

export async function runCheckLegalHolds(
  deps: PrivacyJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'privacy.check_legal_holds',
): Promise<HoldCheckOutcome> {
  const requestId = payload['requestId'];
  if (!isUuid(requestId)) throw new Error('privacy.check_legal_holds: bad payload');
  const now = deps.now ?? ((): Date => new Date());

  // The request's patient today (a merge may have moved the request to the survivor, so the payload's ID can be stale).
  const found = await deps.db.withScope(systemScope(deps.orgId), async (tx: Tx) => {
    const r = (
      await tx.query(`SELECT patient_id, status FROM privacy.request WHERE id = $1::uuid`, [
        requestId,
      ])
    ).rows[0] as Row | undefined;
    if (r === undefined) return undefined;
    return {
      patientId: String(r['patient_id']),
      status: String(r['status']),
      ids: await deps.closureOf(tx, String(r['patient_id'])),
    };
  });
  if (found === undefined) return 'gone';
  if (found.status === 'fulfilled' || found.status === 'refused') return 'final';
  const ids = [...new Set([found.patientId, ...found.ids])].sort();

  return deps.db.withScope(patientsScope(deps.orgId, ids), async (tx) => {
    const n = await deps.holds.documentsUnderHold(tx, ids);
    await tx.lockPatients([found.patientId], 'key_share');
    const u = await tx.query(
      `UPDATE privacy.request SET legal_hold_documents = $2, legal_hold_checked_at = $3::timestamptz
        WHERE id = $1::uuid AND status NOT IN ('fulfilled', 'refused')`,
      [requestId, n, now().toISOString()],
    );
    if ((u.rowCount ?? 0) === 0) return 'final' as const;
    await tx.query(
      `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, resource_id, patient_id, change, outcome)
       VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, 'worker', 'system', 'update', 'privacy.request', $2::uuid, $3::uuid, $4::jsonb, 'allowed')`,
      [
        `${jobRef}:${requestId}`.slice(0, 200),
        requestId,
        found.patientId,
        JSON.stringify({ legalHoldChecked: true }),
      ],
    );
    return 'checked' as const;
  });
}
