// `reporting.refresh_ops` (ARCHITECTURE 22.15, 33.1): rebuilds the operations read models in ONE system transaction, so a reader never sees a
// half-refreshed set. Runs as app_worker (audience system, job scope org). Sources are read under that role's own policies; nothing here
// widens a right. The models hold counts, ages, states and IDs of connections, job types and clinicians, never a patient, a payload or
// an error text (M-4, BD-09).
//
// Each model is replaced as a whole: rows are upserted with this run's `refreshed_at` (the transaction start) and the rows of earlier runs
// are deleted, so a connection or job type that no longer exists disappears. Two overlapping runs are serialised by an advisory lock.
import type { KernelDb, Tx } from '@ehr/kernel';

export const REFRESH_LOCK_KEY = 'reporting.refresh_ops';
/** Outbound-call history scanned for "last success" (monthly partitions: this reaches at most the last two). */
export const LAST_SUCCESS_WINDOW_DAYS = 35;

export interface RefreshDeps {
  db: KernelDb;
  /** The organisation's `calendar_stale_minutes` setting, read in the refresh transaction (a missing setting fails the job, never a guess). */
  staleMinutes: (tx: Tx) => Promise<number>;
}

export interface RefreshResult {
  integrations: number;
  queues: number;
  calendars: number;
  alertGroups: number;
}

/** An organisation-wide system job (T-SYS): audience `system`, job scope `org`, worker realm. */
export const refreshScope = (orgId: string) =>
  ({ audience: 'system', realm: 'worker', orgId, jobScope: 'org' }) as const;

export async function runRefreshOps(deps: RefreshDeps, orgId: string): Promise<RefreshResult> {
  return deps.db.withScope(refreshScope(orgId), async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [REFRESH_LOCK_KEY]);
    const stale = await deps.staleMinutes(tx);
    if (!Number.isInteger(stale) || stale < 1)
      throw new Error('calendar_stale_minutes is not a positive integer');

    const integrations = await tx.query(
      `WITH calls AS (
         SELECT connection_id,
           count(*) FILTER (WHERE at > now() - interval '5 minutes' AND outcome IN ('ok','timeout','error'))::int AS calls_5m,
           count(*) FILTER (WHERE at > now() - interval '5 minutes' AND outcome IN ('timeout','error'))::int AS failures_5m,
           count(*) FILTER (WHERE at > now() - interval '1 hour' AND outcome IN ('ok','timeout','error'))::int AS calls_1h,
           count(*) FILTER (WHERE at > now() - interval '1 hour' AND outcome IN ('timeout','error'))::int AS failures_1h,
           max(at) FILTER (WHERE outcome = 'ok') AS last_success_at
         FROM integration_core.outbound_call
         WHERE organisation_id = $1 AND at > now() - make_interval(days => $2)
         GROUP BY connection_id),
       dead AS (
         SELECT payload ->> 'connectionId' AS connection_id, count(*)::int AS n
         FROM queue._private_jobs
         WHERE locked_at IS NULL AND attempts >= max_attempts AND payload ->> 'connectionId' ~ '^[0-9a-f-]{36}$'
         GROUP BY 1)
       INSERT INTO reporting.ops_integration_health
         (organisation_id, connection_id, kind, vendor, enabled, health, circuit_state, health_changed_at, last_success_at,
          calls_5m, failures_5m, error_rate_5m, calls_1h, failures_1h, error_rate_1h, dead_letters, refreshed_at)
       SELECT c.organisation_id, c.id, c.kind, c.vendor, c.enabled, c.health,
              CASE c.health WHEN 'ok' THEN 'closed' WHEN 'degraded' THEN 'half_open' WHEN 'down' THEN 'open' ELSE 'unknown' END,
              c.health_changed_at, k.last_success_at,
              coalesce(k.calls_5m, 0), coalesce(k.failures_5m, 0),
              CASE WHEN coalesce(k.calls_5m, 0) = 0 THEN NULL ELSE round(k.failures_5m::numeric / k.calls_5m, 4) END,
              coalesce(k.calls_1h, 0), coalesce(k.failures_1h, 0),
              CASE WHEN coalesce(k.calls_1h, 0) = 0 THEN NULL ELSE round(k.failures_1h::numeric / k.calls_1h, 4) END,
              coalesce(d.n, 0), now()
       FROM integration_core.connection c
       LEFT JOIN calls k ON k.connection_id = c.id
       LEFT JOIN dead d ON d.connection_id = c.id::text
       WHERE c.organisation_id = $1
       ON CONFLICT (organisation_id, connection_id) DO UPDATE SET
         kind = EXCLUDED.kind, vendor = EXCLUDED.vendor, enabled = EXCLUDED.enabled, health = EXCLUDED.health,
         circuit_state = EXCLUDED.circuit_state, health_changed_at = EXCLUDED.health_changed_at,
         last_success_at = EXCLUDED.last_success_at, calls_5m = EXCLUDED.calls_5m, failures_5m = EXCLUDED.failures_5m,
         error_rate_5m = EXCLUDED.error_rate_5m, calls_1h = EXCLUDED.calls_1h, failures_1h = EXCLUDED.failures_1h,
         error_rate_1h = EXCLUDED.error_rate_1h, dead_letters = EXCLUDED.dead_letters, refreshed_at = EXCLUDED.refreshed_at`,
      [orgId, LAST_SUCCESS_WINDOW_DAYS],
    );
    await tx.query(
      'DELETE FROM reporting.ops_integration_health WHERE organisation_id = $1 AND refreshed_at <> now()',
      [orgId],
    );

    // The queue is one deployment-wide table (jobs carry IDs only); the counts are written under the refreshing organisation.
    // dead = attempts exhausted; running = locked; failed = failed at least once and still retrying; ready = due now, never tried.
    const queues = await tx.query(
      `INSERT INTO reporting.ops_queue (organisation_id, task_identifier, ready, running, failed, dead, oldest_ready_age_s, refreshed_at)
       SELECT $1, t.identifier,
              count(*) FILTER (WHERE j.locked_at IS NULL AND j.attempts = 0 AND j.run_at <= now())::int,
              count(*) FILTER (WHERE j.locked_at IS NOT NULL)::int,
              count(*) FILTER (WHERE j.locked_at IS NULL AND j.attempts > 0 AND j.attempts < j.max_attempts)::int,
              count(*) FILTER (WHERE j.locked_at IS NULL AND j.attempts >= j.max_attempts)::int,
              floor(extract(epoch FROM now() - min(j.run_at) FILTER (WHERE j.locked_at IS NULL AND j.attempts = 0 AND j.run_at <= now())))::int,
              now()
       FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id
       WHERE t.identifier ~ '^[a-z][a-z0-9_]{0,40}\\.[a-z][a-z0-9_]{0,60}$'
       GROUP BY t.identifier
       ON CONFLICT (organisation_id, task_identifier) DO UPDATE SET
         ready = EXCLUDED.ready, running = EXCLUDED.running, failed = EXCLUDED.failed, dead = EXCLUDED.dead,
         oldest_ready_age_s = EXCLUDED.oldest_ready_age_s, refreshed_at = EXCLUDED.refreshed_at`,
      [orgId],
    );
    await tx.query(
      'DELETE FROM reporting.ops_queue WHERE organisation_id = $1 AND refreshed_at <> now()',
      [orgId],
    );

    const calendars = await tx.query(
      `INSERT INTO reporting.ops_calendar_staleness
         (organisation_id, clinician_principal_id, last_synced_at, stale, stale_after_minutes, refreshed_at)
       SELECT $1, clinician_principal_id, max(synced_at), max(synced_at) < now() - make_interval(mins => $2), $2, now()
       FROM scheduling.busy_block
       WHERE organisation_id = $1
       GROUP BY clinician_principal_id
       ON CONFLICT (organisation_id, clinician_principal_id) DO UPDATE SET
         last_synced_at = EXCLUDED.last_synced_at, stale = EXCLUDED.stale,
         stale_after_minutes = EXCLUDED.stale_after_minutes, refreshed_at = EXCLUDED.refreshed_at`,
      [orgId, stale],
    );
    await tx.query(
      'DELETE FROM reporting.ops_calendar_staleness WHERE organisation_id = $1 AND refreshed_at <> now()',
      [orgId],
    );

    const alerts = await tx.query(
      `INSERT INTO reporting.ops_alert_backlog (organisation_id, alert_type, severity, status, alerts, oldest_age_s, refreshed_at)
       SELECT $1, type, severity, status, count(*)::int, floor(extract(epoch FROM now() - min(created_at)))::int, now()
       FROM notifications.staff_alert
       WHERE organisation_id = $1 AND status IN ('open', 'escalated')
       GROUP BY type, severity, status
       ON CONFLICT (organisation_id, alert_type, severity, status) DO UPDATE SET
         alerts = EXCLUDED.alerts, oldest_age_s = EXCLUDED.oldest_age_s, refreshed_at = EXCLUDED.refreshed_at`,
      [orgId],
    );
    await tx.query(
      'DELETE FROM reporting.ops_alert_backlog WHERE organisation_id = $1 AND refreshed_at <> now()',
      [orgId],
    );

    // Compliance summary: always the same six rows, zeros included, so a reader can tell "none" from "not refreshed".
    await tx.query(
      `INSERT INTO reporting.compliance_btg_summary (organisation_id, metric, age_bucket, grants, refreshed_at)
       SELECT $1, m.metric, m.age_bucket, count(g.id)::int, now()
       FROM (VALUES ('open_grants','all'), ('pending_reviews','all'), ('pending_reviews','lt_1d'),
                    ('pending_reviews','1d_to_7d'), ('pending_reviews','gt_7d')) AS m(metric, age_bucket)
       LEFT JOIN audit.btg_grant g ON g.organisation_id = $1 AND (
            (m.metric = 'open_grants' AND g.revoked_at IS NULL AND g.expires_at > now())
         OR (m.metric = 'pending_reviews' AND g.review_status = 'pending' AND (
               m.age_bucket = 'all'
            OR (m.age_bucket = 'lt_1d' AND g.opened_at > now() - interval '1 day')
            OR (m.age_bucket = '1d_to_7d' AND g.opened_at <= now() - interval '1 day' AND g.opened_at > now() - interval '7 days')
            OR (m.age_bucket = 'gt_7d' AND g.opened_at <= now() - interval '7 days'))))
       GROUP BY m.metric, m.age_bucket
       ON CONFLICT (organisation_id, metric, age_bucket) DO UPDATE SET
         grants = EXCLUDED.grants, refreshed_at = EXCLUDED.refreshed_at`,
      [orgId],
    );

    return {
      integrations: integrations.rowCount ?? 0,
      queues: queues.rowCount ?? 0,
      calendars: calendars.rowCount ?? 0,
      alertGroups: alerts.rowCount ?? 0,
    };
  });
}
