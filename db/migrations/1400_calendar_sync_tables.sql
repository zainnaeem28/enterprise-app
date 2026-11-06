-- migration-class: expand
-- calendar_sync schema and tables (ARCHITECTURE 22.9; ticket BE-14, migrations 1400-1499). DDL only (SBR-17).
-- Triggers: 1401. Row-level security and grants: 1402. The busy-block writer (scheduling.replace_busy_blocks): 1403.
--
-- Class C1 only: no patient column anywhere in this schema (22.9: event_map is keyed by the occupancy, never the patient).
-- Secrets are never stored here: calendar_link names the secret (token_secret_name) and the secret store holds it.
--
-- Small, recorded departures from 22.9 (additive; see the module README):
--   * calendar_link.discarded_token_hash: the full-resync rule (33.1, QA-AL-01) needs "SHA-256 of the last discarded token" as the
--     marker of the resync a null token owes (SAR-IDF-03). Only the hash is kept, never the token itself.
--   * organisation_id, created_*, row_version, updated_at on every table (21.4 template, BD-15 conventions).
--   * token_secret_name is fixed to 'cal-<principal id>' by CHECK, so the reference a link names can only ever be its own doctor's.

CREATE SCHEMA calendar_sync;
COMMENT ON SCHEMA calendar_sync IS 'Calendar links, sync tokens, watch channels, busy-event map (ARCHITECTURE 22.9)';
REVOKE ALL ON SCHEMA calendar_sync FROM PUBLIC;
GRANT USAGE ON SCHEMA calendar_sync TO app_api, app_worker;

CREATE TABLE calendar_sync.calendar_link (
  clinician_principal_id uuid        PRIMARY KEY REFERENCES identity.principal (id),
  organisation_id        uuid        NOT NULL,
  google_calendar_id     text        NOT NULL CHECK (char_length(google_calendar_id) BETWEEN 1 AND 256 AND google_calendar_id !~ '[[:cntrl:]]'),
  status                 text        NOT NULL CHECK (status IN ('pending_consent', 'active', 'token_revoked', 'error')),
  token_secret_name      text        NOT NULL,
  sync_token             text        CHECK (sync_token IS NULL OR char_length(sync_token) BETWEEN 1 AND 2048),
  discarded_token_hash   bytea       CHECK (discarded_token_hash IS NULL OR octet_length(discarded_token_hash) = 32),
  last_synced_at         timestamptz,
  last_error_code        text        CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_.]{0,63}$'),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  created_by_job         uuid,
  row_version            bigint      NOT NULL DEFAULT 1,
  updated_at             timestamptz,
  CONSTRAINT calendar_link_token_name CHECK (token_secret_name = 'cal-' || clinician_principal_id::text)
);
COMMENT ON TABLE calendar_sync.calendar_link IS 'class=C1; refresh token only by name (outbound secret, BD-11); no patient data';
CREATE INDEX calendar_link_status_idx ON calendar_sync.calendar_link (status);

CREATE TABLE calendar_sync.watch_channel (
  id                     uuid        PRIMARY KEY,
  organisation_id        uuid        NOT NULL,
  clinician_principal_id uuid        NOT NULL REFERENCES identity.principal (id),
  channel_id             text        NOT NULL CHECK (channel_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  resource_id            text        NOT NULL CHECK (resource_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  -- 29.5 / TDR-05: which channel-token key signed this channel's token. No token and no token hash is stored: the API verifies the
  -- token without reading this table.
  token_key_version      text        NOT NULL CHECK (token_key_version ~ '^[A-Za-z0-9_-]{1,32}$'),
  expires_at             timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by_job         uuid,
  CONSTRAINT watch_channel_channel_uq UNIQUE (channel_id)
);
COMMENT ON TABLE calendar_sync.watch_channel IS 'class=C1; worker only; no token or token hash (TDR-05)';
CREATE INDEX watch_channel_expires_idx ON calendar_sync.watch_channel (expires_at);
CREATE INDEX watch_channel_clinician_idx ON calendar_sync.watch_channel (clinician_principal_id);

CREATE TABLE calendar_sync.event_map (
  occupancy_id           uuid        PRIMARY KEY REFERENCES scheduling.slot_occupancy (id),
  organisation_id        uuid        NOT NULL,
  clinician_principal_id uuid        NOT NULL REFERENCES identity.principal (id),
  -- Deterministic from the occupancy ID (34.3): a retry cannot create a second event. Google ids are base32hex; ours are 35 characters (PostgreSQL caps a repetition count at 255).
  google_event_id        text        NOT NULL CHECK (google_event_id ~ '^[a-v0-9]{5,255}$'),
  state                  text        NOT NULL CHECK (state IN ('pending', 'created', 'deleted', 'failed')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by_job         uuid,
  row_version            bigint      NOT NULL DEFAULT 1,
  updated_at             timestamptz
);
COMMENT ON TABLE calendar_sync.event_map IS 'class=C1; keyed by occupancy, no patient column';
CREATE INDEX event_map_clinician_state_idx ON calendar_sync.event_map (clinician_principal_id, state);
