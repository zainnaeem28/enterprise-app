-- migration-class: expand
-- audit.anchor (ARCHITECTURE 22.2, section 6 "tamper evidence by batch anchoring"; SAR-04, SAR-10).
-- One anchor per closed time range [from_ts, to_ts): row count, Merkle root over the rows' audit.row_digest in
-- (occurred_at, event_id) order, and the previous anchor's hash. Anchors form a chain. Insert-only, like the events.

CREATE TABLE audit.anchor (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  from_ts         timestamptz NOT NULL,
  to_ts           timestamptz NOT NULL,
  row_count       bigint      NOT NULL CHECK (row_count >= 0),
  merkle_root     bytea       NOT NULL CHECK (octet_length(merkle_root) = 32),
  prev_hash       bytea       NOT NULL CHECK (octet_length(prev_hash) = 32),
  hash            bytea       NOT NULL CHECK (octet_length(hash) = 32),
  archived_at     timestamptz,
  archive_key     text        CHECK (char_length(archive_key) <= 500),
  late_rows       integer     NOT NULL DEFAULT 0 CHECK (late_rows >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anchor_range CHECK (from_ts <= to_ts),
  -- 22.2 says UQ (to_ts); the deployment is single-organisation, so the pair is the same constraint.
  CONSTRAINT anchor_org_to_ts_uq UNIQUE (organisation_id, to_ts)
);
COMMENT ON TABLE audit.anchor IS 'class=C1';

CREATE TRIGGER anchor_append_only BEFORE UPDATE OR DELETE ON audit.anchor
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER anchor_no_truncate BEFORE TRUNCATE ON audit.anchor
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();

REVOKE ALL ON audit.anchor FROM PUBLIC, app_owner;
