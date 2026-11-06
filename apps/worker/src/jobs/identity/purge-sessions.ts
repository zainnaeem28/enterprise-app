// `identity.purge_sessions` (ARCHITECTURE 33.1, hourly): deletes a session only when it was revoked or expired (idle or
// absolute) more than 24 hours ago AND no unused, unexpired `webauthn_challenge` row still references it (SAR-IDF-05: a
// `tx_sign` challenge must survive its 30-minute window). The challenge table belongs to BE-05; the condition is added
// when that table exists, so this job is correct before and after it.
import type { KernelDb } from '@ehr/kernel';
import { systemScope } from './scope.js';

export const PURGE_AFTER_HOURS = 24;
const BATCH = 1000;

export async function runPurgeSessions(deps: {
  db: KernelDb;
  orgId: string;
  now?: () => Date;
}): Promise<{ deleted: number }> {
  const cutoff = new Date(
    (deps.now ?? (() => new Date()))().getTime() - PURGE_AFTER_HOURS * 3_600_000,
  );
  let deleted = 0;
  for (;;) {
    const n = await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
      const hasChallenges =
        (await tx.query(`SELECT to_regclass('identity.webauthn_challenge') IS NOT NULL AS present`))
          .rows[0]?.['present'] === true;
      const r = await tx.query(
        `DELETE FROM identity.session WHERE id IN (
           SELECT s.id FROM identity.session s
            WHERE LEAST(COALESCE(s.revoked_at, 'infinity'::timestamptz), s.idle_expires_at, s.absolute_expires_at) < $1
              ${hasChallenges ? `AND NOT EXISTS (SELECT 1 FROM identity.webauthn_challenge c WHERE c.session_id = s.id AND c.used_at IS NULL AND c.expires_at > now())` : ''}
            LIMIT ${BATCH})`,
        [cutoff],
      );
      return r.rowCount ?? 0;
    });
    deleted += n;
    if (n < BATCH) return { deleted };
  }
}
