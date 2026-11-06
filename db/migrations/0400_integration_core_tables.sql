-- migration-class: expand
-- integration_core schema and tables (ARCHITECTURE 22.3, 9.1 BD-11, 25.7, 25.9, 34; ticket BE-02, migrations 0400-0499).
-- RLS and grants: 0401. receive_inbound and the ownership of inbound_message: 0402.
--
-- Secrets are never stored here: secret_ref holds the secret NAME and the store's VERSION ID only, and the CHECKs below
-- refuse a row whose JSON settings or test result carry a credential-looking key (defence in depth for the write-only rule).

CREATE SCHEMA integration_core;
COMMENT ON SCHEMA integration_core IS 'Vendor connections, outbound call log, inbound message log, secret references (ARCHITECTURE 22.3)';
REVOKE ALL ON SCHEMA integration_core FROM PUBLIC;
GRANT USAGE ON SCHEMA integration_core TO app_api, app_worker, integration_receiver_owner;
-- 21.2 point 1: PostgreSQL requires the new owner of a function or table to hold CREATE on the schema.
GRANT CREATE ON SCHEMA integration_core TO integration_receiver_owner;

-- True when any object key anywhere in the document looks like a credential. Used by CHECKs on the JSON columns.
CREATE FUNCTION integration_core.has_secret_like_key(doc jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_path_query(doc, 'lax $.**') AS node(v),
         LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(node.v) = 'object' THEN node.v ELSE '{}'::jsonb END) AS k(key)
    WHERE k.key ~* '(secret|passw|token|api[_-]?key|private[_-]?key|credential|bearer|authorization|signature)'
  )
$$;
REVOKE ALL ON FUNCTION integration_core.has_secret_like_key(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration_core.has_secret_like_key(jsonb) TO app_api, app_worker;

-- connection: one per (organisation, kind). `health` is the shared circuit state written by the health job (34.2).
CREATE TABLE integration_core.connection (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL,
  kind              text        NOT NULL CHECK (kind IN (
    'google_workspace_sso', 'google_calendar', 'email', 'sms', 'push', 'video', 'ocr', 'malware_scan', 'analytics_site')),
  vendor            text        NOT NULL CHECK (vendor ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  settings          jsonb       NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(settings) = 'object' AND NOT integration_core.has_secret_like_key(settings)
                             AND pg_column_size(settings) <= 16384),
  enabled           boolean     NOT NULL DEFAULT false,
  health            text        NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown', 'ok', 'degraded', 'down')),
  health_changed_at timestamptz,
  last_test_at      timestamptz,
  last_test_result  jsonb       CHECK (last_test_result IS NULL
                                       OR (jsonb_typeof(last_test_result) = 'object'
                                           AND NOT integration_core.has_secret_like_key(last_test_result)
                                           AND pg_column_size(last_test_result) <= 4096)),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  created_by_job    uuid,
  row_version       bigint      NOT NULL DEFAULT 1,
  updated_at        timestamptz,
  CONSTRAINT connection_org_kind_uq UNIQUE (organisation_id, kind)
);
COMMENT ON TABLE integration_core.connection IS 'class=C1';
CREATE TRIGGER connection_bump_row_version BEFORE UPDATE ON integration_core.connection
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- secret_ref: names and versions only. The ARN must sit under the prefix of its class (9.1, SC-2): an outbound reference
-- cannot point into the inbound-verification area of the secret store, and the other way round.
CREATE TABLE integration_core.secret_ref (
  connection_id          uuid        NOT NULL REFERENCES integration_core.connection (id) ON DELETE RESTRICT,
  name                   text        NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  organisation_id        uuid        NOT NULL,
  class                  text        NOT NULL CHECK (class IN ('outbound', 'inbound_verification')),
  secret_arn             text        NOT NULL CHECK (char_length(secret_arn) BETWEEN 1 AND 512),
  current_version_id     text        NOT NULL CHECK (char_length(current_version_id) BETWEEN 1 AND 128),
  rotated_at             timestamptz,
  rotated_by_person_id   uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  created_by_job         uuid,
  row_version            bigint      NOT NULL DEFAULT 1,
  updated_at             timestamptz,
  PRIMARY KEY (connection_id, name),
  CONSTRAINT secret_ref_prefix CHECK (
    (class = 'outbound' AND secret_arn LIKE '%/integration/outbound/%')
    OR (class = 'inbound_verification' AND secret_arn LIKE '%/integration/inbound/%'))
);
COMMENT ON TABLE integration_core.secret_ref IS 'class=C1';
CREATE TRIGGER secret_ref_bump_row_version BEFORE UPDATE ON integration_core.secret_ref
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- secret_change_request (25.9, SEC-01 O2-1..O2-9): the dual-controlled request for an admin-entered inbound-verification
-- secret. The value is NEVER in this table: only a salted fingerprint inside request_hash / canonical_request. The two
-- assertion columns are the evidence the worker verifies (O2-3); they carry no secret value.
CREATE TABLE integration_core.secret_change_request (
  id                    uuid        PRIMARY KEY,
  organisation_id       uuid        NOT NULL,
  connection_id         uuid        NOT NULL REFERENCES integration_core.connection (id) ON DELETE RESTRICT,
  name                  text        NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  requester_person_id   uuid        NOT NULL,
  request_hash          bytea       NOT NULL CHECK (octet_length(request_hash) = 32),
  canonical_request     bytea       NOT NULL CHECK (octet_length(canonical_request) BETWEEN 1 AND 2048),
  status                text        NOT NULL DEFAULT 'requested'
                          CHECK (status IN ('requested', 'approved', 'applied', 'rejected', 'expired')),
  approver_person_id    uuid,
  decided_at            timestamptz,
  expires_at            timestamptz NOT NULL,
  requester_assertion   jsonb       CHECK (requester_assertion IS NULL OR pg_column_size(requester_assertion) <= 8192),
  approver_assertion    jsonb       CHECK (approver_assertion IS NULL OR pg_column_size(approver_assertion) <= 8192),
  job_id                text        CHECK (char_length(job_id) <= 200),
  applied_version_id    text        CHECK (char_length(applied_version_id) <= 128),
  applied_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  created_by_job        uuid,
  row_version           bigint      NOT NULL DEFAULT 1,
  updated_at            timestamptz,
  CONSTRAINT scr_expiry CHECK (expires_at > created_at),
  -- 25.9: the approver is a different person from the requester (also enforced by the trigger below, which holds when
  -- a role bypasses column grants).
  CONSTRAINT scr_approver_differs CHECK (approver_person_id IS NULL OR approver_person_id <> requester_person_id),
  CONSTRAINT scr_decided_has_approver CHECK (
    status NOT IN ('approved', 'applied') OR (approver_person_id IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT scr_applied_shape CHECK (
    (status = 'applied' AND applied_at IS NOT NULL AND applied_version_id IS NOT NULL)
    OR (status <> 'applied' AND applied_at IS NULL AND applied_version_id IS NULL))
);
CREATE INDEX scr_open_idx ON integration_core.secret_change_request (status, expires_at) WHERE status IN ('requested', 'approved');
CREATE INDEX scr_connection_idx ON integration_core.secret_change_request (connection_id, name);
COMMENT ON TABLE integration_core.secret_change_request IS 'class=C1';
CREATE TRIGGER scr_bump_row_version BEFORE UPDATE ON integration_core.secret_change_request
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- Immutable request identity; the only legal status moves are requested -> approved | rejected | expired,
-- approved -> applied | expired | rejected. Terminal states never change. SQLSTATE PS001 (illegal state transition).
CREATE FUNCTION integration_core.guard_secret_change_request() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a secret change request is never deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.requester_person_id IS DISTINCT FROM OLD.requester_person_id
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.canonical_request IS DISTINCT FROM OLD.canonical_request
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.requester_assertion IS DISTINCT FROM OLD.requester_assertion AND OLD.requester_assertion IS NOT NULL THEN
    RAISE EXCEPTION 'a secret change request keeps its identity, hash and expiry' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'expired'))
    OR (OLD.status = 'approved'  AND NEW.status IN ('applied', 'rejected', 'expired'))) THEN
    RAISE EXCEPTION 'illegal secret change request transition % -> %', OLD.status, NEW.status USING ERRCODE = 'PS001';
  END IF;
  IF OLD.approver_person_id IS NOT NULL AND NEW.approver_person_id IS DISTINCT FROM OLD.approver_person_id THEN
    RAISE EXCEPTION 'the approver of a secret change request is set once' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.approver_person_id IS NOT NULL AND NEW.approver_person_id = NEW.requester_person_id THEN
    RAISE EXCEPTION 'the approver must differ from the requester' USING ERRCODE = 'PS001';
  END IF;
  -- An approval or application only happens before the request expires.
  IF NEW.status IN ('approved', 'applied') AND OLD.status IS DISTINCT FROM NEW.status AND now() >= NEW.expires_at THEN
    RAISE EXCEPTION 'secret change request expired' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION integration_core.guard_secret_change_request() FROM PUBLIC;
CREATE TRIGGER scr_guard BEFORE UPDATE OR DELETE ON integration_core.secret_change_request
  FOR EACH ROW EXECUTE FUNCTION integration_core.guard_secret_change_request();

-- outbound_call: one row per attempt, IDs only (no PHI, no payload, no error text). Monthly partitions. `pending` is
-- written before a vendor call that has no idempotency token (34.3) and moved once to its final outcome; `rejected`
-- covers a call refused before it left (circuit open, connection disabled).
CREATE TABLE integration_core.outbound_call (
  id               uuid        NOT NULL,
  organisation_id  uuid        NOT NULL,
  connection_id    uuid        NOT NULL,
  operation        text        NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_.]{0,99}$'),
  correlation_type text        CHECK (correlation_type ~ '^[a-z][a-z0-9_.]{0,99}$'),
  correlation_id   uuid,
  attempt          integer     NOT NULL CHECK (attempt BETWEEN 1 AND 25),
  outcome          text        NOT NULL CHECK (outcome IN ('pending', 'ok', 'timeout', 'error', 'rejected')),
  error_class      text        CHECK (error_class ~ '^[a-z][a-z0-9_.]{0,63}$'),
  http_status      integer     CHECK (http_status BETWEEN 100 AND 599),
  latency_ms       integer     CHECK (latency_ms >= 0),
  vendor_ref       text        CHECK (char_length(vendor_ref) <= 200),
  at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
COMMENT ON TABLE integration_core.outbound_call IS 'class=C1';
CREATE INDEX outbound_call_connection_idx ON integration_core.outbound_call (connection_id, at);
CREATE INDEX outbound_call_correlation_idx ON integration_core.outbound_call (correlation_id) WHERE correlation_id IS NOT NULL;

-- Rows are never deleted. A `pending` row moves once to a final outcome; every other column is fixed.
CREATE FUNCTION integration_core.guard_outbound_call() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbound call rows are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.outcome <> 'pending' THEN
    RAISE EXCEPTION 'a finished outbound call row does not change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.outcome = 'pending'
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.correlation_type IS DISTINCT FROM OLD.correlation_type
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.at IS DISTINCT FROM OLD.at THEN
    RAISE EXCEPTION 'a pending outbound call moves once to its outcome and keeps its identity' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION integration_core.guard_outbound_call() FROM PUBLIC;
CREATE TRIGGER outbound_call_guard BEFORE UPDATE OR DELETE ON integration_core.outbound_call
  FOR EACH ROW EXECUTE FUNCTION integration_core.guard_outbound_call();

CREATE TABLE integration_core.outbound_call_y2026m11 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_y2026m12 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_y2027m01 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_y2027m02 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_y2027m03 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_y2027m04 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2027-04-01 00:00:00+00') TO ('2027-05-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_y2027m05 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2027-05-01 00:00:00+00') TO ('2027-06-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_y2027m06 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2027-06-01 00:00:00+00') TO ('2027-07-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_y2027m07 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2027-07-01 00:00:00+00') TO ('2027-08-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_y2027m08 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2027-08-01 00:00:00+00') TO ('2027-09-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_y2027m09 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2027-09-01 00:00:00+00') TO ('2027-10-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_y2027m10 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2027-10-01 00:00:00+00') TO ('2027-11-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_y2027m11 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2027-11-01 00:00:00+00') TO ('2027-12-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_y2027m12 PARTITION OF integration_core.outbound_call FOR VALUES FROM ('2027-12-01 00:00:00+00') TO ('2028-01-01 00:00:00+00');
CREATE TABLE integration_core.outbound_call_default PARTITION OF integration_core.outbound_call DEFAULT;

-- Partitions hold no grant for any role: the application reaches rows through the parent only.
REVOKE ALL ON integration_core.outbound_call_y2026m11 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_y2026m12 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_y2027m01 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_y2027m02 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_y2027m03 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_y2027m04 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_y2027m05 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_y2027m06 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_y2027m07 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_y2027m08 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_y2027m09 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_y2027m10 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_y2027m11 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_y2027m12 FROM PUBLIC, app_owner;
REVOKE ALL ON integration_core.outbound_call_default FROM PUBLIC, app_owner;

-- inbound_message (22.3, 25.7): the opaque, encrypted vendor payload, de-duplicated by (organisation, source, event_id).
-- No patient_id column by design (22.3 draft 6): the handler resolves the patient and writes its own rows. The table is
-- handed to integration_receiver_owner in 0402, after its grants exist.
CREATE TABLE integration_core.inbound_message (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  source           text        NOT NULL CHECK (source ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  event_id         text        NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 255 AND event_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@=+/-]*$'),
  message_type     text        NOT NULL CHECK (message_type ~ '^[a-z][a-z0-9_.]{0,99}$'),
  received_at      timestamptz NOT NULL DEFAULT now(),
  payload          bytea       NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 262144),
  status           text        NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received', 'dispatched', 'handled', 'no_handler', 'failed')),
  handler          text        CHECK (handler ~ '^[a-z][a-z0-9_.]{0,99}$'),
  error_class      text        CHECK (error_class ~ '^[a-z][a-z0-9_.]{0,63}$'),
  handled_at       timestamptz,
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  CONSTRAINT inbound_message_dedupe UNIQUE (organisation_id, source, event_id)
);
CREATE INDEX inbound_message_status_idx ON integration_core.inbound_message (status, received_at);
COMMENT ON TABLE integration_core.inbound_message IS 'class=C2';
COMMENT ON COLUMN integration_core.inbound_message.payload IS 'class=C2 envelope-encrypted vendor payload; only the worker role can decrypt';

REVOKE ALL ON integration_core.connection, integration_core.secret_ref, integration_core.secret_change_request,
  integration_core.outbound_call, integration_core.inbound_message FROM PUBLIC;
-- app_owner keeps no right on the tables that nothing references. Two exceptions, both deliberate:
--   connection      - a foreign-key check runs as the owner of the referencing table (app_owner for secret_ref and
--                     secret_change_request) and needs SELECT on the referenced row. Referential checks bypass RLS and the
--                     table is FORCEd, so ordinary statements as app_owner still see and change nothing.
--   inbound_message - its owner's ACL entry moves to integration_receiver_owner when 0402 transfers ownership; revoking it
--                     here would leave the new owner with no right to insert. After the transfer app_owner holds nothing.
REVOKE ALL ON integration_core.secret_ref, integration_core.secret_change_request, integration_core.outbound_call
  FROM app_owner;
