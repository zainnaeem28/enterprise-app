// Adapters over the other modules' tables, for the privacy jobs. Plain SELECTs under the job's own scope (T-SYS): the owning modules'
// row-level security decides what is visible. A published function on the documents interface would replace the first one.
import type { Tx } from '@ehr/kernel';
import { isUuid } from './ids.js';
import type { LegalHoldReader } from './ports.js';

type Row = Record<string, unknown>;

/** Documents whose latest legal-hold row says `placed` (append-only rows, `seq` orders them). */
export const documentsLegalHolds: LegalHoldReader = {
  async documentsUnderHold(tx, patientIds) {
    if (!patientIds.every(isUuid)) throw new Error('privacy: bad patient ids');
    const r = await tx.query(
      `SELECT count(*)::int AS n FROM documents.document d
        WHERE d.patient_id = ANY($1::uuid[])
          AND coalesce((SELECT h.action FROM documents.legal_hold h WHERE h.document_id = d.id ORDER BY h.seq DESC LIMIT 1), 'released') = 'placed'`,
      [[...patientIds]],
    );
    return Number((r.rows[0] as Row | undefined)?.['n'] ?? 0);
  },
};

/** The patient and every ID merged into it, directly or through a chain, from the merge map (9.2). */
export async function closureOf(tx: Tx, patientId: string): Promise<string[]> {
  if (!isUuid(patientId)) return [];
  const r = await tx.query(
    `WITH final AS (
       SELECT coalesce((SELECT m.final_survivor_id FROM patient.patient_merge m WHERE m.merged_id = $1::uuid), $1::uuid) AS id)
     SELECT f.id AS id FROM final f
     UNION SELECT m.merged_id FROM patient.patient_merge m, final f WHERE m.final_survivor_id = f.id`,
    [patientId],
  );
  return (r.rows as Row[]).map((x) => String(x['id']));
}
