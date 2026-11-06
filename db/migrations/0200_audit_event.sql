-- migration-class: expand
-- audit schema and audit.event (ARCHITECTURE 22.2, 21.5; SHARED-BOUNDARIES 8.1; ticket BE-01, migrations 0200-0299).
-- Append-only, partitioned by month on occurred_at. Rows are written only by app_api, app_worker and the function-owner
-- roles, in bounded transactions. app_owner owns the objects and is stripped of every privilege on them
-- (R-app-owner-no-audit-insert; TC-AU-04 step 3 expects 42501 before any trigger runs). RLS and grants: 0203.

CREATE SCHEMA audit;
COMMENT ON SCHEMA audit IS 'Audit events, anchors, break-the-glass grants, export jobs (ARCHITECTURE 22.2)';
REVOKE ALL ON SCHEMA audit FROM PUBLIC;
GRANT USAGE ON SCHEMA audit TO app_api, app_worker, audit_archiver,
  scheduling_booking_owner, patient_scope_owner, patient_match_owner, integration_receiver_owner;

-- 21.5 audit.require_bounded_tx (SAR-10): refuses a transaction whose transaction_timeout SETTING is 0 (unset) or above
-- the bound of 60 s. It checks the setting, not elapsed time. pg_settings reports the value in milliseconds.
-- Invoker rights, pg_catalog only. SQLSTATE PA001.
CREATE FUNCTION audit.require_bounded_tx() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  bound_ms constant bigint := 60000;
  timeout_ms bigint;
BEGIN
  SELECT s.setting::bigint INTO timeout_ms FROM pg_catalog.pg_settings s WHERE s.name = 'transaction_timeout';
  IF timeout_ms IS NULL OR timeout_ms = 0 OR timeout_ms > bound_ms THEN
    RAISE EXCEPTION 'audit rows are written only in bounded transactions (transaction_timeout must be 1..60 s)'
      USING ERRCODE = 'PA001';
  END IF;
  RETURN NEW;
END
$$;

-- Append-only: refuses every UPDATE and DELETE (and TRUNCATE) whoever asks. The design names kernel.append_only (21.5);
-- that function belongs to the kernel migrations (0001-0099), which this ticket may not edit, so the audit tables use
-- this audit-owned twin with the same behaviour. SQLSTATE 42501, so the API maps it like a privilege refusal.
CREATE FUNCTION audit.refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'audit rows are append-only (% on %.% refused)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$$;

REVOKE ALL ON FUNCTION audit.require_bounded_tx(), audit.refuse_change() FROM PUBLIC;

-- audit.event (22.2): the SHARED-BOUNDARIES 8.1 envelope. Columns the design lists are all present; organisation_id is the
-- 21.1 scope key. anchor_id is kept for the design but is never populated: no role may UPDATE an audit row, and anchoring
-- identifies rows by the half-open time range [from_ts, to_ts) of the anchor (see the note in the module README).
CREATE TABLE audit.event (
  event_id           uuid        NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  organisation_id    uuid        NOT NULL,
  request_id         uuid,
  job_id             text        CHECK (char_length(job_id) <= 200),
  actor_principal_id uuid,
  actor_person_id    uuid,
  realm              text        NOT NULL CHECK (realm IN ('patient_pool', 'google', 'admin_pool', 'partner_pool', 'worker', 'none')),
  audience           text        NOT NULL CHECK (audience IN ('anonymous', 'patient', 'staff', 'partner', 'system', 'public')),
  action             text        NOT NULL CHECK (action IN (
    'view', 'search', 'create', 'update', 'sign', 'cosign', 'addend', 'export', 'print', 'download', 'merge',
    'btg_open', 'btg_review', 'config_change', 'role_change_request', 'role_change_decision', 'elevation',
    'sign_in', 'sign_out', 'session_revoke', 'denied',
    'care_attach', 'consent_exception', 'kill_switch', 'enrol', 'link_person', 'secret_write')),
  resource_type      text        NOT NULL CHECK (char_length(resource_type) <= 100),
  resource_id        uuid,
  patient_id         uuid,
  location_id        uuid,
  btg_grant_id       uuid,
  reason             text        CHECK (char_length(reason) <= 500),
  ip                 inet,
  user_agent         text        CHECK (char_length(user_agent) <= 512),
  change             jsonb,
  outcome            text        NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  denial_reason      text        CHECK (denial_reason IN ('forbidden', 'not_visible')),
  anchor_id          bigint,
  PRIMARY KEY (event_id, occurred_at),
  -- 8.1: a denial carries a reason, an allowed event does not; the action of a denial is `denied`.
  CONSTRAINT event_denial_shape CHECK (
    (outcome = 'allowed' AND denial_reason IS NULL AND action <> 'denied')
    OR (outcome = 'denied' AND denial_reason IS NOT NULL AND action = 'denied')),
  -- 8.1: request_id is null for worker jobs, which use job_id instead.
  CONSTRAINT event_origin CHECK (request_id IS NOT NULL OR job_id IS NOT NULL),
  -- 8.1: a reason is required for BTG and export.
  CONSTRAINT event_reason_required CHECK (action NOT IN ('btg_open', 'export') OR char_length(btrim(reason)) > 0)
) PARTITION BY RANGE (occurred_at);
COMMENT ON TABLE audit.event IS 'class=C2';

-- 22.2 indexes (per partition, created through the parent).
CREATE INDEX event_occurred_at_brin ON audit.event USING brin (occurred_at);
CREATE INDEX event_patient_idx ON audit.event (patient_id, occurred_at) WHERE patient_id IS NOT NULL;
CREATE INDEX event_actor_person_idx ON audit.event (actor_person_id, occurred_at);
CREATE INDEX event_resource_idx ON audit.event (resource_type, resource_id);

-- Row-level triggers on the parent are cloned to every partition, so a direct write to a partition is refused too.
CREATE TRIGGER event_require_bounded_tx BEFORE INSERT ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit.require_bounded_tx();
CREATE TRIGGER event_append_only BEFORE UPDATE OR DELETE ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_no_truncate BEFORE TRUNCATE ON audit.event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();

-- audit.row_digest: the leaf of the anchoring Merkle tree. SHA-256 of the canonical JSON array of every column except
-- anchor_id, timestamps rendered in UTC with microseconds. Stable across sessions and time zones.
CREATE FUNCTION audit.row_digest(e audit.event) RETURNS bytea
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$
  SELECT pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
    e.event_id,
    pg_catalog.to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    e.organisation_id, e.request_id, e.job_id, e.actor_principal_id, e.actor_person_id, e.realm, e.audience, e.action,
    e.resource_type, e.resource_id, e.patient_id, e.location_id, e.btg_grant_id, e.reason,
    pg_catalog.host(e.ip) || '/' || pg_catalog.masklen(e.ip), e.user_agent, e.change, e.outcome, e.denial_reason
  )::text, 'UTF8'))
$$;
REVOKE ALL ON FUNCTION audit.row_digest(audit.event) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.row_digest(audit.event) TO app_worker, app_api;

-- Monthly partitions, Nov 2026 .. Dec 2027, and a default partition so that a missed month never blocks an audited
-- read. Creating the next months is an operations migration (add before the horizon; the verification job reports the
-- remaining horizon). Detach/drop is audit_archiver's dual-controlled procedure (DO-09b), not built here.
CREATE TABLE audit.event_y2026m11 PARTITION OF audit.event FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE audit.event_y2026m12 PARTITION OF audit.event FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE audit.event_y2027m01 PARTITION OF audit.event FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE audit.event_y2027m02 PARTITION OF audit.event FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');
CREATE TABLE audit.event_y2027m03 PARTITION OF audit.event FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');
CREATE TABLE audit.event_y2027m04 PARTITION OF audit.event FOR VALUES FROM ('2027-04-01 00:00:00+00') TO ('2027-05-01 00:00:00+00');
CREATE TABLE audit.event_y2027m05 PARTITION OF audit.event FOR VALUES FROM ('2027-05-01 00:00:00+00') TO ('2027-06-01 00:00:00+00');
CREATE TABLE audit.event_y2027m06 PARTITION OF audit.event FOR VALUES FROM ('2027-06-01 00:00:00+00') TO ('2027-07-01 00:00:00+00');
CREATE TABLE audit.event_y2027m07 PARTITION OF audit.event FOR VALUES FROM ('2027-07-01 00:00:00+00') TO ('2027-08-01 00:00:00+00');
CREATE TABLE audit.event_y2027m08 PARTITION OF audit.event FOR VALUES FROM ('2027-08-01 00:00:00+00') TO ('2027-09-01 00:00:00+00');
CREATE TABLE audit.event_y2027m09 PARTITION OF audit.event FOR VALUES FROM ('2027-09-01 00:00:00+00') TO ('2027-10-01 00:00:00+00');
CREATE TABLE audit.event_y2027m10 PARTITION OF audit.event FOR VALUES FROM ('2027-10-01 00:00:00+00') TO ('2027-11-01 00:00:00+00');
CREATE TABLE audit.event_y2027m11 PARTITION OF audit.event FOR VALUES FROM ('2027-11-01 00:00:00+00') TO ('2027-12-01 00:00:00+00');
CREATE TABLE audit.event_y2027m12 PARTITION OF audit.event FOR VALUES FROM ('2027-12-01 00:00:00+00') TO ('2028-01-01 00:00:00+00');
CREATE TABLE audit.event_default PARTITION OF audit.event DEFAULT;

-- Statement-level triggers are not cloned to partitions: TRUNCATE of a partition is refused one by one.
CREATE TRIGGER event_y2026m11_no_truncate BEFORE TRUNCATE ON audit.event_y2026m11
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_y2026m12_no_truncate BEFORE TRUNCATE ON audit.event_y2026m12
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_y2027m01_no_truncate BEFORE TRUNCATE ON audit.event_y2027m01
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_y2027m02_no_truncate BEFORE TRUNCATE ON audit.event_y2027m02
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_y2027m03_no_truncate BEFORE TRUNCATE ON audit.event_y2027m03
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_y2027m04_no_truncate BEFORE TRUNCATE ON audit.event_y2027m04
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_y2027m05_no_truncate BEFORE TRUNCATE ON audit.event_y2027m05
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_y2027m06_no_truncate BEFORE TRUNCATE ON audit.event_y2027m06
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_y2027m07_no_truncate BEFORE TRUNCATE ON audit.event_y2027m07
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_y2027m08_no_truncate BEFORE TRUNCATE ON audit.event_y2027m08
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_y2027m09_no_truncate BEFORE TRUNCATE ON audit.event_y2027m09
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_y2027m10_no_truncate BEFORE TRUNCATE ON audit.event_y2027m10
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_y2027m11_no_truncate BEFORE TRUNCATE ON audit.event_y2027m11
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_y2027m12_no_truncate BEFORE TRUNCATE ON audit.event_y2027m12
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER event_default_no_truncate BEFORE TRUNCATE ON audit.event_default
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();

-- Partitions hold no grant for any role: the application reaches rows through the parent only, and app_owner loses its own.
REVOKE ALL ON audit.event_y2026m11 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_y2026m12 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_y2027m01 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_y2027m02 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_y2027m03 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_y2027m04 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_y2027m05 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_y2027m06 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_y2027m07 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_y2027m08 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_y2027m09 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_y2027m10 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_y2027m11 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_y2027m12 FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event_default FROM PUBLIC, app_owner;
REVOKE ALL ON audit.event FROM PUBLIC, app_owner;
