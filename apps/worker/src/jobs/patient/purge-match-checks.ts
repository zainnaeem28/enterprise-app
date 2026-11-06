// `patient.purge_match_checks` (ARCHITECTURE 25.3, hourly): deletes match checks that expired. A check lives 15 minutes; it holds a
// keyed hash and candidate IDs, so it is not kept longer than needed. Batched; organisation-wide (T-SYS).
import type { KernelDb } from '@ehr/kernel';
import { systemScope } from './scope.js';

const BATCH = 1000;

export async function runPurgeMatchChecks(deps: {
  db: KernelDb;
  orgId: string;
}): Promise<{ deleted: number }> {
  let deleted = 0;
  for (;;) {
    const n = await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
      const r = await tx.query(
        `DELETE FROM patient.match_check WHERE id IN (SELECT id FROM patient.match_check WHERE expires_at < now() LIMIT ${BATCH})`,
      );
      return r.rowCount ?? 0;
    });
    deleted += n;
    if (n < BATCH) return { deleted };
  }
}
