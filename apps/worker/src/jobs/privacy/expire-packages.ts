// `privacy.expire_packages` (ARCHITECTURE 33.1, SHARED-BOUNDARIES 6.7): daily, organisation scope. A package past `expires_at` that is
// still `ready` or `released` is expired and its object removed from the store. The object goes first: a package whose object is gone
// is not downloadable anyway (the download route also refuses it once `expires_at` has passed), and a failed removal leaves the row for
// the next run. It deletes no row and no audit event. `createdBefore` (the retention job passes it, from the retention settings: a package
// lives `EHR_RETENTION_EXPORT_PACKAGE_DAYS` after creation) also expires a package created on or before that instant, whatever its `expires_at`.
import type { PrivacyJobDeps } from './ports.js';
import { systemScope } from './scope.js';

type Row = Record<string, unknown>;

export interface ExpireResult {
  expired: number;
  failed: number;
}

export async function runExpirePackages(
  deps: PrivacyJobDeps,
  opts: { batch?: number; jobRef?: string; createdBefore?: Date } = {},
): Promise<ExpireResult> {
  const now = (deps.now ?? ((): Date => new Date()))();
  const batch = opts.batch ?? 200;
  const due = (
    await deps.db.withScope(systemScope(deps.orgId), (tx) =>
      tx.query(
        `SELECT id, patient_id, object_key FROM privacy.export_package
          WHERE status IN ('ready', 'released')
            AND (expires_at <= $1::timestamptz OR ($3::timestamptz IS NOT NULL AND created_at <= $3::timestamptz))
          ORDER BY expires_at, id LIMIT $2::int`,
        [now.toISOString(), batch, opts.createdBefore?.toISOString() ?? null],
      ),
    )
  ).rows as Row[];
  let expired = 0;
  let failed = 0;
  for (const p of due) {
    try {
      if (typeof p['object_key'] === 'string') await deps.store.remove(p['object_key']);
      const done = await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
        await tx.lockPatients([String(p['patient_id'])], 'key_share');
        const u = await tx.query(
          `UPDATE privacy.export_package SET status = 'expired' WHERE id = $1::uuid AND status IN ('ready', 'released')`,
          [p['id']],
        );
        if ((u.rowCount ?? 0) === 0) return false;
        await tx.query(
          `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, resource_id, patient_id, change, outcome)
           VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, 'worker', 'system', 'update', 'privacy.export_package', $2::uuid, $3::uuid, $4::jsonb, 'allowed')`,
          [
            (opts.jobRef ?? 'privacy.expire_packages').slice(0, 200),
            p['id'],
            p['patient_id'],
            JSON.stringify({ status: 'expired' }),
          ],
        );
        return true;
      });
      if (done) expired++;
    } catch {
      failed++; // logged by class below; the next daily run tries again
    }
  }
  if (failed > 0) deps.log.warn('package expiry could not finish some packages', { failed });
  return { expired, failed };
}
