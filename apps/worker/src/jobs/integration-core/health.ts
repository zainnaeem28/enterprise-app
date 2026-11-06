// `integration_core.health_check` (every 5 minutes, ARCHITECTURE 33.1, 34.2): probes every enabled connection with its
// adapter, derives the shared health state and writes it to `integration_core.connection.health`, which the operations
// dashboard reads (NFR-21). A change INTO `down` publishes `integration_core.connection_down`, a change OUT of it
// publishes `integration_core.connection_restored`, in the same transaction as the update, so the operations alert
// (notifications handler, ARCHITECTURE 24) fires exactly when the stored state changes.
//
// Derivation (deterministic, documented in the module README):
//   probe ok     -> `ok`, or `degraded` when the last 5 minutes hold >= 5 calls and >= 50 % of them failed
//   probe failed -> `degraded` on the first failed probe after `ok`/`unknown`; `down` on the second in a row
//   disabled     -> `unknown` (nothing is probed)
import type { KernelDb, Logger, Queue } from '@ehr/kernel';
import { AdapterFailure } from './errors.js';
import type { AdapterRegistry, CredentialReader } from './adapters.js';
import { systemScope } from './scope.js';

export type Health = 'unknown' | 'ok' | 'degraded' | 'down';

export interface HealthDeps {
  db: KernelDb;
  orgId: string;
  queue: Queue;
  adapters: AdapterRegistry;
  credentials: (connectionId: string) => CredentialReader;
  log: Logger;
  now?: () => Date;
  probeTimeoutMs?: number;
}

export interface HealthChange {
  connectionId: string;
  kind: string;
  from: Health;
  to: Health;
}

export function nextHealth(
  previous: Health,
  probeOk: boolean,
  recent: { total: number; failed: number },
): Health {
  if (probeOk) return recent.total >= 5 && recent.failed / recent.total >= 0.5 ? 'degraded' : 'ok';
  return previous === 'degraded' || previous === 'down' ? 'down' : 'degraded';
}

export async function runHealthCheck(deps: HealthDeps): Promise<HealthChange[]> {
  const scope = systemScope(deps.orgId);
  const conns = await deps.db.withScope(scope, (tx) =>
    tx.query(
      `SELECT id, kind, vendor, settings, enabled, health FROM integration_core.connection ORDER BY kind`,
    ),
  );
  const changes: HealthChange[] = [];
  for (const row of conns.rows) {
    const id = String(row.id);
    const kind = String(row.kind);
    const previous = String(row.health) as Health;
    try {
      let next: Health;
      let result: Record<string, unknown>;
      if (row.enabled !== true) {
        next = 'unknown';
        result = { ok: false, skipped: 'disabled' };
      } else {
        const adapter = deps.adapters.get(kind);
        if (adapter === undefined) {
          next = nextHealth(previous, false, { total: 0, failed: 0 });
          result = { ok: false, skipped: 'no_adapter' };
        } else {
          const started = Date.now();
          let ok = false;
          let httpStatus: number | undefined;
          try {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), deps.probeTimeoutMs ?? 5_000);
            try {
              const h = await Promise.race([
                adapter.healthCheck({
                  connection: {
                    id,
                    kind,
                    vendor: String(row.vendor),
                    settings: Object.freeze({ ...(row.settings as Record<string, unknown>) }),
                  },
                  credentials: deps.credentials(id),
                  signal: ac.signal,
                }),
                new Promise<never>((_, rej) =>
                  ac.signal.addEventListener('abort', () => rej(new AdapterFailure(true))),
                ),
              ]);
              ok = h.ok;
              httpStatus = h.httpStatus;
            } finally {
              clearTimeout(t);
            }
          } catch {
            ok = false;
          }
          const recent = await deps.db.withScope(scope, async (tx) => {
            const r = await tx.query(
              `SELECT count(*)::int AS total, count(*) FILTER (WHERE outcome IN ('timeout', 'error'))::int AS failed
                 FROM integration_core.outbound_call
                WHERE connection_id = $1::uuid AND at > now() - interval '5 minutes' AND outcome <> 'pending'`,
              [id],
            );
            return { total: Number(r.rows[0]?.total ?? 0), failed: Number(r.rows[0]?.failed ?? 0) };
          });
          next = nextHealth(previous, ok, recent);
          result = {
            ok,
            latencyMs: Date.now() - started,
            ...(httpStatus === undefined ? {} : { httpStatus }),
          };
        }
      }
      const at = (deps.now ?? (() => new Date()))();
      await deps.db.withScope(scope, async (tx) => {
        await tx.query(
          `UPDATE integration_core.connection
              SET health = $2, health_changed_at = CASE WHEN health IS DISTINCT FROM $2 THEN $3::timestamptz ELSE health_changed_at END,
                  last_test_at = $3::timestamptz, last_test_result = $4::jsonb
            WHERE id = $1::uuid`,
          [id, next, at.toISOString(), JSON.stringify({ ...result, checkedAt: at.toISOString() })],
        );
        if (next !== previous) {
          if (next === 'down')
            await deps.queue.publish(tx, 'integration_core.connection_down', {
              connectionId: id,
              organisationId: deps.orgId,
            });
          else if (previous === 'down')
            await deps.queue.publish(tx, 'integration_core.connection_restored', {
              connectionId: id,
              organisationId: deps.orgId,
            });
        }
      });
      if (next !== previous) changes.push({ connectionId: id, kind, from: previous, to: next });
    } catch (err) {
      // One connection's failure must not stop the sweep; the job is retried as a whole by the queue only if all fail.
      deps.log.error('health check failed for a connection', {
        kind,
        sqlstate: (err as { code?: unknown } | null)?.code,
      });
    }
  }
  return changes;
}
