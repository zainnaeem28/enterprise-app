// `kernel queue sync-task-types`: writes the job registry (code) into `queue_api.task_type` (21.8, amendment A-1).
// Runs as app_worker in the deploy pipeline before the API rollout, and again at worker start-up. Upsert only: it never
// deletes, so an older worker in a rolling deploy cannot remove a newer type.
import type { Queryable } from '../db.js';
import type { JobRegistry } from './enqueue.js';

export async function syncTaskTypes(tx: Queryable, registry: JobRegistry): Promise<number> {
  const types = registry.list();
  for (const t of types) {
    await tx.query(
      `INSERT INTO queue_api.task_type (task_identifier, job_class, api_enqueue, max_attempts)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (task_identifier) DO UPDATE
         SET job_class = EXCLUDED.job_class, api_enqueue = EXCLUDED.api_enqueue,
             max_attempts = EXCLUDED.max_attempts, updated_at = now()`,
      [t.name, t.jobClass, t.apiEnqueue, t.maxAttempts],
    );
  }
  return types.length;
}
