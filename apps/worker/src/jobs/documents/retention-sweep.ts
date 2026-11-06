// `documents.retention_sweep` (ARCHITECTURE 33.1, PRD BR-29): daily, organisation scope. Removes the stored objects of documents that
// are `deleted` (a deletion request was decided `deleted` after the hold and retention checks, so there is nothing left to decide
// here) and of `quarantined` files once they have been kept for the investigation window. It deletes no row and no audit event, and it
// never touches a document under a legal hold. Until D-8 is decided nothing becomes `deleted`, so the sweep removes only quarantined
// files (BR-29).
import type { DocumentsJobDeps } from './ports.js';
import { systemScope } from './scope.js';

type Row = Record<string, unknown>;

export interface SweepResult {
  removed: number;
  failed: number;
}

export async function runRetentionSweep(
  deps: DocumentsJobDeps,
  opts: { batch?: number; quarantineKeepDays?: number } = {},
): Promise<SweepResult> {
  const now = (deps.now ?? ((): Date => new Date()))();
  const batch = opts.batch ?? 200;
  const keep = opts.quarantineKeepDays ?? 30;
  const due = (
    await deps.db.withScope(systemScope(deps.orgId), (tx) =>
      tx.query(
        `SELECT v.document_id, v.version, v.bucket, v.object_key
           FROM documents.document_version v JOIN documents.document d ON d.id = v.document_id
          WHERE v.object_removed_at IS NULL
            AND (d.status = 'deleted' OR (d.status = 'quarantined' AND v.scanned_at < $1::timestamptz - make_interval(days => $2::int)))
            AND coalesce((SELECT h.action FROM documents.legal_hold h WHERE h.document_id = d.id ORDER BY h.seq DESC LIMIT 1), 'released') <> 'placed'
          ORDER BY v.document_id, v.version LIMIT $3::int`,
        [now.toISOString(), keep, batch],
      ),
    )
  ).rows as Row[];
  let removed = 0;
  let failed = 0;
  for (const r of due) {
    try {
      await deps.store.remove(r['bucket'] as 'quarantine' | 'clean', String(r['object_key']));
      const u = await deps.db.withScope(systemScope(deps.orgId), (tx) =>
        tx.query(
          `UPDATE documents.document_version SET object_removed_at = $3::timestamptz WHERE document_id = $1::uuid AND version = $2 AND object_removed_at IS NULL`,
          [r['document_id'], r['version'], now.toISOString()],
        ),
      );
      if ((u.rowCount ?? 0) > 0) removed++;
    } catch {
      failed++; // logged by class by the task wrapper's caller; the next daily run tries again
    }
  }
  if (failed > 0) deps.log.warn('retention sweep could not remove some objects', { failed });
  return { removed, failed };
}
