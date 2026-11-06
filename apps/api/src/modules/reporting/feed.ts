// The operations feed: `GET /api/v1/admin/reports/ops` (ARCHITECTURE 29.4). Reads the stored read models under the CALLER's scope (admin realm,
// T-CONF), so row-level security is the second line after the route guard's `reporting.ops.read`. The compliance summary is included only for
// a caller holding the `btg_grants` slice; for anyone else the key is absent, never empty.
import type { Tx } from '@ehr/kernel';

/** A refresh older than this many seconds makes the whole feed `stale` (the job runs every 60 s; 3 missed runs). */
export const FEED_STALE_AFTER_S = 180;

export interface OpsFeed {
  generatedAt: string | null;
  stale: boolean;
  summary: {
    openCircuits: number;
    degradedCircuits: number;
    deadLetters: number;
    alertBacklog: number;
    staleCalendars: number;
  };
  integrations: Array<{
    connectionId: string;
    kind: string;
    vendor: string;
    enabled: boolean;
    health: string;
    circuitState: string;
    healthChangedAt: string | null;
    lastSuccessAt: string | null;
    calls5m: number;
    failures5m: number;
    errorRate5m: number | null;
    calls1h: number;
    failures1h: number;
    errorRate1h: number | null;
    deadLetters: number;
  }>;
  queues: Array<{
    taskIdentifier: string;
    ready: number;
    running: number;
    failed: number;
    dead: number;
    oldestReadyAgeSeconds: number | null;
  }>;
  calendars: Array<{
    clinicianPrincipalId: string;
    lastSyncedAt: string;
    stale: boolean;
    staleAfterMinutes: number;
  }>;
  alertBacklog: Array<{
    type: string;
    severity: string;
    status: string;
    alerts: number;
    oldestAgeSeconds: number;
  }>;
  compliance?: { btg: Array<{ metric: string; ageBucket: string; grants: number }> };
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as Date).toISOString();

export async function readOpsFeed(tx: Tx, withCompliance: boolean): Promise<OpsFeed> {
  const health = (
    await tx.query(
      `SELECT * FROM reporting.ops_integration_health ORDER BY kind, vendor, connection_id`,
    )
  ).rows as Row[];
  const queues = (
    await tx.query(
      `SELECT * FROM reporting.ops_queue ORDER BY dead DESC, failed DESC, task_identifier`,
    )
  ).rows as Row[];
  const cals = (
    await tx.query(
      `SELECT * FROM reporting.ops_calendar_staleness ORDER BY stale DESC, last_synced_at, clinician_principal_id`,
    )
  ).rows as Row[];
  const alerts = (
    await tx.query(
      `SELECT * FROM reporting.ops_alert_backlog
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, alert_type, status`,
    )
  ).rows as Row[];
  const age = (
    await tx.query(
      `SELECT max(r) AS refreshed_at, floor(extract(epoch FROM now() - max(r)))::int AS age_s FROM (
         SELECT max(refreshed_at) AS r FROM reporting.ops_integration_health UNION ALL
         SELECT max(refreshed_at) FROM reporting.ops_queue UNION ALL
         SELECT max(refreshed_at) FROM reporting.ops_calendar_staleness UNION ALL
         SELECT max(refreshed_at) FROM reporting.ops_alert_backlog) s`,
    )
  ).rows[0] as Row;
  // An empty model set (never refreshed, or genuinely nothing to show) is reported as stale only when it has never been written.
  const ageS = numOrNull(age['age_s']);
  const feed: OpsFeed = {
    generatedAt: iso(age['refreshed_at']),
    stale: ageS === null || ageS > FEED_STALE_AFTER_S,
    summary: {
      openCircuits: health.filter((h) => h['circuit_state'] === 'open' && h['enabled'] === true)
        .length,
      degradedCircuits: health.filter(
        (h) => h['circuit_state'] === 'half_open' && h['enabled'] === true,
      ).length,
      deadLetters: queues.reduce((n, q) => n + num(q['dead']), 0),
      alertBacklog: alerts.reduce((n, a) => n + num(a['alerts']), 0),
      staleCalendars: cals.filter((c) => c['stale'] === true).length,
    },
    integrations: health.map((h) => ({
      connectionId: h['connection_id'] as string,
      kind: h['kind'] as string,
      vendor: h['vendor'] as string,
      enabled: h['enabled'] as boolean,
      health: h['health'] as string,
      circuitState: h['circuit_state'] as string,
      healthChangedAt: iso(h['health_changed_at']),
      lastSuccessAt: iso(h['last_success_at']),
      calls5m: num(h['calls_5m']),
      failures5m: num(h['failures_5m']),
      errorRate5m: numOrNull(h['error_rate_5m']),
      calls1h: num(h['calls_1h']),
      failures1h: num(h['failures_1h']),
      errorRate1h: numOrNull(h['error_rate_1h']),
      deadLetters: num(h['dead_letters']),
    })),
    queues: queues.map((q) => ({
      taskIdentifier: q['task_identifier'] as string,
      ready: num(q['ready']),
      running: num(q['running']),
      failed: num(q['failed']),
      dead: num(q['dead']),
      oldestReadyAgeSeconds: numOrNull(q['oldest_ready_age_s']),
    })),
    calendars: cals.map((c) => ({
      clinicianPrincipalId: c['clinician_principal_id'] as string,
      lastSyncedAt: iso(c['last_synced_at']) as string,
      stale: c['stale'] as boolean,
      staleAfterMinutes: num(c['stale_after_minutes']),
    })),
    alertBacklog: alerts.map((a) => ({
      type: a['alert_type'] as string,
      severity: a['severity'] as string,
      status: a['status'] as string,
      alerts: num(a['alerts']),
      oldestAgeSeconds: num(a['oldest_age_s']),
    })),
  };
  if (withCompliance) {
    const btg = (
      await tx.query(
        `SELECT metric, age_bucket, grants FROM reporting.compliance_btg_summary ORDER BY metric, age_bucket`,
      )
    ).rows as Row[];
    feed.compliance = {
      btg: btg.map((b) => ({
        metric: b['metric'] as string,
        ageBucket: b['age_bucket'] as string,
        grants: num(b['grants']),
      })),
    };
  }
  return feed;
}
