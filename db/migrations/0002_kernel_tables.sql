-- migration-class: expand
-- The four kernel tables of ARCHITECTURE 22.1, with the column conventions of 21.1.
-- Every table gets RLS and FORCE in 0003 in the same release; no application role has a grant before then.

CREATE TABLE kernel.idempotency_key (
  organisation_id   uuid        NOT NULL,
  principal_id      uuid        NOT NULL,
  route_template    text        NOT NULL CHECK (char_length(route_template) <= 200),
  key               uuid        NOT NULL,
  request_hash      bytea       NOT NULL CHECK (octet_length(request_hash) = 32),
  response_status   smallint,
  response_body     bytea       CHECK (octet_length(response_body) <= 65536),
  response_location text        CHECK (char_length(response_location) <= 2048),
  state             text        NOT NULL CHECK (state IN ('in_progress', 'completed')),
  expires_at        timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  created_by_job    uuid,
  row_version       bigint      NOT NULL DEFAULT 1,
  updated_at        timestamptz,
  PRIMARY KEY (organisation_id, principal_id, route_template, key)
);
CREATE INDEX idempotency_key_expires_at_idx ON kernel.idempotency_key (expires_at);
COMMENT ON TABLE kernel.idempotency_key IS 'class=C2';

CREATE TABLE kernel.setting (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  key             text        NOT NULL CHECK (char_length(key) <= 200),
  value           jsonb       NOT NULL,
  value_schema    text        NOT NULL CHECK (char_length(value_schema) <= 200),
  location_id     uuid,
  pre_auth        boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  CONSTRAINT setting_org_key_location_uq UNIQUE NULLS NOT DISTINCT (organisation_id, key, location_id)
);
COMMENT ON TABLE kernel.setting IS 'class=C1';

CREATE TABLE kernel.reference_data_version (
  organisation_id uuid        NOT NULL,
  dataset         text        NOT NULL CHECK (char_length(dataset) <= 100),
  version         text        NOT NULL CHECK (char_length(version) <= 100),
  applied_at      timestamptz NOT NULL,
  checksum        bytea       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  PRIMARY KEY (organisation_id, dataset)
);
COMMENT ON TABLE kernel.reference_data_version IS 'class=C1';

CREATE TABLE kernel.rate_counter (
  organisation_id uuid        NOT NULL,
  key             text        NOT NULL CHECK (char_length(key) <= 200),
  window_start    timestamptz NOT NULL,
  count           integer     NOT NULL CHECK (count >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  PRIMARY KEY (organisation_id, key, window_start)
);
CREATE INDEX rate_counter_window_start_idx ON kernel.rate_counter (window_start);
COMMENT ON TABLE kernel.rate_counter IS 'class=C1';

CREATE TRIGGER idempotency_key_bump_row_version BEFORE UPDATE ON kernel.idempotency_key
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER setting_bump_row_version BEFORE UPDATE ON kernel.setting
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER reference_data_version_bump_row_version BEFORE UPDATE ON kernel.reference_data_version
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER rate_counter_bump_row_version BEFORE UPDATE ON kernel.rate_counter
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
