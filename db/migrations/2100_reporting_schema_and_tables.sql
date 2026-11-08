-- migration-class: expand
-- reporting schema: the R1 operations read models (ARCHITECTURE 22.15, 33.1 `reporting.refresh_ops`; ticket BE-21, migrations 2100-2199).
-- RLS and grants: 2101. Every table is a stored read model, refreshed every minute by the worker job and replaced as a whole
-- (rows for things that no longer exist are removed in the same transaction). Class C0/C1 only (M-4): counts, ages, states and
-- IDs of connections, job types and clinicians. No patient ID, no payload, no error text, no free text of any kind.
--
-- Design addition (README O-1): `ops_alert_backlog` is not listed in 22.15; the acceptance of BE-21 asks the operations feed to show the
-- alert backlog, and the staff_alert table itself is C2, so the feed reads this counts-only table instead.

CREATE SCHEMA reporting;
COMMENT ON SCHEMA reporting IS 'R1 operations read models (ARCHITECTURE 22.15): C0/C1 counts and states only';
REVOKE ALL ON SCHEMA reporting FROM PUBLIC;
GRANT USAGE ON SCHEMA reporting TO app_api, app_worker, reporting_ro;

-- Per connection: health, last success, error rate (5 min, 1 h), circuit state, dead letters.
-- circuit_state is the shared state written by the health job (integration_core.connection.health): ok -> closed,
-- degraded -> half_open, down -> open, unknown -> unknown.
CREATE TABLE reporting.ops_integration_health (
  organisation_id   uuid        NOT NULL,
  connection_id     uuid        NOT NULL,
  kind              text        NOT NULL,
  vendor            text        NOT NULL,
  enabled           boolean     NOT NULL,
  health            text        NOT NULL CHECK (health IN ('unknown', 'ok', 'degraded', 'down')),
  circuit_state     text        NOT NULL CHECK (circuit_state IN ('unknown', 'closed', 'half_open', 'open')),
  health_changed_at timestamptz,
  last_success_at   timestamptz,
  calls_5m          integer     NOT NULL CHECK (calls_5m >= 0),
  failures_5m       integer     NOT NULL CHECK (failures_5m >= 0),
  error_rate_5m     numeric(5,4) CHECK (error_rate_5m BETWEEN 0 AND 1),
  calls_1h          integer     NOT NULL CHECK (calls_1h >= 0),
  failures_1h       integer     NOT NULL CHECK (failures_1h >= 0),
  error_rate_1h     numeric(5,4) CHECK (error_rate_1h BETWEEN 0 AND 1),
  dead_letters      integer     NOT NULL CHECK (dead_letters >= 0),
  refreshed_at      timestamptz NOT NULL,
  PRIMARY KEY (organisation_id, connection_id)
);
COMMENT ON TABLE reporting.ops_integration_health IS 'class=C1; read model; writer: worker reporting.refresh_ops';

-- Per job type: ready, running, failed (retrying), dead, oldest age of a ready job.
CREATE TABLE reporting.ops_queue (
  organisation_id    uuid        NOT NULL,
  task_identifier    text        NOT NULL CHECK (task_identifier ~ '^[a-z][a-z0-9_]{0,40}\.[a-z][a-z0-9_]{0,60}$'),
  ready              integer     NOT NULL CHECK (ready >= 0),
  running            integer     NOT NULL CHECK (running >= 0),
  failed             integer     NOT NULL CHECK (failed >= 0),
  dead               integer     NOT NULL CHECK (dead >= 0),
  oldest_ready_age_s integer     CHECK (oldest_ready_age_s >= 0),
  refreshed_at       timestamptz NOT NULL,
  PRIMARY KEY (organisation_id, task_identifier)
);
COMMENT ON TABLE reporting.ops_queue IS 'class=C1; read model; writer: worker reporting.refresh_ops';

-- Per clinician with a synced calendar: last sync and the stale flag (threshold: setting calendar_stale_minutes).
CREATE TABLE reporting.ops_calendar_staleness (
  organisation_id        uuid        NOT NULL,
  clinician_principal_id uuid        NOT NULL,
  last_synced_at         timestamptz NOT NULL,
  stale                  boolean     NOT NULL,
  stale_after_minutes    integer     NOT NULL CHECK (stale_after_minutes >= 1),
  refreshed_at           timestamptz NOT NULL,
  PRIMARY KEY (organisation_id, clinician_principal_id)
);
COMMENT ON TABLE reporting.ops_calendar_staleness IS 'class=C1; read model; writer: worker reporting.refresh_ops';

-- Alert backlog: alerts still needing a person (open or escalated), counts only. No patient, no resource ID.
CREATE TABLE reporting.ops_alert_backlog (
  organisation_id uuid        NOT NULL,
  alert_type      text        NOT NULL,
  severity        text        NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status          text        NOT NULL CHECK (status IN ('open', 'escalated')),
  alerts          integer     NOT NULL CHECK (alerts >= 1),
  oldest_age_s    integer     NOT NULL CHECK (oldest_age_s >= 0),
  refreshed_at    timestamptz NOT NULL,
  PRIMARY KEY (organisation_id, alert_type, severity, status)
);
COMMENT ON TABLE reporting.ops_alert_backlog IS 'class=C1 (counts only; design addition, see module README O-1); read model; writer: worker reporting.refresh_ops';

-- Break-the-glass summary for compliance: open grants and pending reviews by age. Counts only.
CREATE TABLE reporting.compliance_btg_summary (
  organisation_id uuid        NOT NULL,
  metric          text        NOT NULL CHECK (metric IN ('open_grants', 'pending_reviews')),
  age_bucket      text        NOT NULL CHECK (age_bucket IN ('all', 'lt_1d', '1d_to_7d', 'gt_7d')),
  grants          integer     NOT NULL CHECK (grants >= 0),
  refreshed_at    timestamptz NOT NULL,
  PRIMARY KEY (organisation_id, metric, age_bucket)
);
COMMENT ON TABLE reporting.compliance_btg_summary IS 'class=C1 (counts only); read model; writer: worker reporting.refresh_ops';
