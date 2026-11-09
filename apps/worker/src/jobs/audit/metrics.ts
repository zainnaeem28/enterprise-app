// Gauges of the audit jobs (DO-07 alarms `audit_anchor_late`, `audit_anchor_mismatch`). Numbers only: no ID, name or text leaves.
import type { KernelDb } from '@ehr/kernel';
import { systemScope } from './scope.js';

export interface MetricSink {
  gauge(name: string, value: number): void;
}

/**
 * `now() - max(audit.anchor.to_ts)` for the organisation, in seconds, on the database clock. With no anchor yet it is the age of
 * the oldest audit event (0 with no events), so a chain that never started grows the number instead of reading as healthy.
 */
export async function auditAnchorLateSeconds(db: KernelDb, orgId: string): Promise<number> {
  return db.withScope(systemScope(orgId), async (tx) => {
    const r = await tx.query(
      `SELECT COALESCE(
                extract(epoch FROM (now() - (SELECT max(to_ts) FROM audit.anchor WHERE organisation_id = $1::uuid))),
                extract(epoch FROM (now() - (SELECT min(occurred_at) FROM audit.event WHERE organisation_id = $1::uuid))),
                0)::float8 AS late`,
      [orgId],
    );
    return Math.max(0, Number(r.rows[0]?.['late'] ?? 0));
  });
}

/** CloudWatch embedded metric format on stdout: the agent turns the line into a metric in `EHR_METRIC_NAMESPACE` (no dimensions). */
export function emfMetricSink(
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  namespace: string = process.env['EHR_METRIC_NAMESPACE'] ?? 'EHR/App',
  now: () => number = Date.now,
): MetricSink {
  return {
    gauge(name, value) {
      write(
        JSON.stringify({
          _aws: {
            Timestamp: now(),
            CloudWatchMetrics: [
              { Namespace: namespace, Dimensions: [[]], Metrics: [{ Name: name, Unit: 'None' }] },
            ],
          },
          [name]: value,
        }),
      );
    },
  };
}
