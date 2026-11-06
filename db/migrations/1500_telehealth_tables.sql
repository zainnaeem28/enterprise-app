-- migration-class: expand
-- telehealth schema and tables (ARCHITECTURE 22.10, 22.16, 25.x, 29.2, 29.3; ticket BE-15, migrations 1500-1599). DDL only (SBR-17).
-- Triggers: 1501. Row-level security and grants: 1502.
--
-- Created here: video_session, participant, location_confirmation (22.10) and join_token (see departure 1).
--
-- Small, recorded departures from 22.10 (all additive; see the module README):
--   1. telehealth.join_token is new. 22.10 says "join tokens are never stored", and that stays true of the vendor's attendee token:
--      only the vendor hands it out, once, and it is never written here. The row records that one was ISSUED (who, for which
--      participant, until when, and how it ended). That is what makes "single-use, short-lived" enforceable on our side (at most one
--      live token per participant, a new issue supersedes the old one), what the kill switch revokes (ST-4, BE-05) and what the merge
--      re-points (the ticket names the join-token tables).
--   2. video_session.vendor, recording_enabled (CHECK false: recording is off in R1, SEC-D-14), organisation_id and the usual audit columns.
--      vendor_meeting_id is NULL until the create_meeting job has the vendor's answer.
--   3. participant.waiting_since (when the person asked to join and was not yet admitted: the waiting room list), admitted_at,
--      admitted_by, device_checked_at and the usual columns. principal_id is NOT NULL (the UQ is per session and principal).
--   4. location_confirmation.principal_id (who confirmed: the patient or the proxy) and override_reason as a closed code.

CREATE SCHEMA telehealth;
COMMENT ON SCHEMA telehealth IS 'Video sessions, participants and the waiting room, join-token issuance, location confirmations (ARCHITECTURE 22.10)';
REVOKE ALL ON SCHEMA telehealth FROM PUBLIC;
GRANT USAGE ON SCHEMA telehealth TO app_api, app_worker;
-- Needed only to move the merge write guard's ownership to the function-owner role (1501); withdrawn again there.
GRANT CREATE ON SCHEMA telehealth TO patient_scope_owner;

CREATE TABLE telehealth.video_session (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  reservation_id          uuid        NOT NULL UNIQUE REFERENCES scheduling.slot_reservation (id),
  patient_id              uuid        NOT NULL REFERENCES patient.patient (id),
  clinician_principal_id  uuid        NOT NULL REFERENCES identity.principal (id),
  vendor                  text        CHECK (vendor IS NULL OR vendor ~ '^[a-z][a-z0-9_]{0,39}$'),
  vendor_meeting_id       text        CHECK (vendor_meeting_id IS NULL OR (char_length(vendor_meeting_id) BETWEEN 1 AND 200 AND vendor_meeting_id !~ '[[:cntrl:]]')),
  status                  text        NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'open', 'ended', 'failed')),
  -- SEC-D-14: recording is off by default and R1 has no way to turn it on.
  recording_enabled       boolean     NOT NULL DEFAULT false CHECK (NOT recording_enabled),
  opened_at               timestamptz,
  ended_at                timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  created_by_job          uuid,
  row_version             bigint      NOT NULL DEFAULT 1,
  updated_at              timestamptz,
  CONSTRAINT video_session_vendor_pair CHECK ((vendor IS NULL) = (vendor_meeting_id IS NULL)),
  CONSTRAINT video_session_times CHECK (
    (status IN ('ended', 'failed')) = (ended_at IS NOT NULL)
    AND (status <> 'open' OR opened_at IS NOT NULL))
);
COMMENT ON TABLE telehealth.video_session IS 'class=C2; merge participant R/K (scheduled and open are R; ended and failed are K)';
CREATE INDEX video_session_patient_idx ON telehealth.video_session (patient_id);
CREATE INDEX video_session_clinician_idx ON telehealth.video_session (clinician_principal_id, status);
CREATE INDEX video_session_live_idx ON telehealth.video_session (created_at) WHERE status IN ('scheduled', 'open');

CREATE TABLE telehealth.participant (
  id                 uuid        PRIMARY KEY,
  organisation_id    uuid        NOT NULL,
  session_id         uuid        NOT NULL REFERENCES telehealth.video_session (id),
  patient_id         uuid        NOT NULL REFERENCES patient.patient (id),
  role               text        NOT NULL CHECK (role IN ('patient', 'proxy', 'clinician')),
  principal_id       uuid        NOT NULL REFERENCES identity.principal (id),
  vendor_attendee_id text        CHECK (vendor_attendee_id IS NULL OR (char_length(vendor_attendee_id) BETWEEN 1 AND 200 AND vendor_attendee_id !~ '[[:cntrl:]]')),
  admission          text        NOT NULL DEFAULT 'waiting' CHECK (admission IN ('waiting', 'admitted', 'removed')),
  waiting_since      timestamptz,
  admitted_at        timestamptz,
  admitted_by        uuid        REFERENCES identity.principal (id),
  joined_at          timestamptz,
  left_at            timestamptz,
  -- Camera, microphone, bandwidth: pass or fail only (22.10). Nothing the device reports beyond that.
  device_check       jsonb,
  device_checked_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  created_by_job     uuid,
  row_version        bigint      NOT NULL DEFAULT 1,
  updated_at         timestamptz,
  CONSTRAINT participant_session_principal_uq UNIQUE (session_id, principal_id),
  CONSTRAINT participant_device_check_shape CHECK (
    device_check IS NULL OR (
      jsonb_typeof(device_check) = 'object'
      AND device_check ?& ARRAY['camera', 'mic', 'bandwidth']
      AND (device_check - 'camera' - 'mic' - 'bandwidth') = '{}'::jsonb
      AND device_check ->> 'camera' IN ('pass', 'fail')
      AND device_check ->> 'mic' IN ('pass', 'fail')
      AND device_check ->> 'bandwidth' IN ('pass', 'fail'))),
  CONSTRAINT participant_device_check_time CHECK ((device_check IS NULL) = (device_checked_at IS NULL)),
  CONSTRAINT participant_admitted_shape CHECK (
    (admission = 'admitted' AND admitted_at IS NOT NULL) OR (admission = 'waiting' AND admitted_at IS NULL) OR admission = 'removed')
);
COMMENT ON TABLE telehealth.participant IS 'class=C2; merge participant R/K (R while its session is scheduled or open; K once it is ended or failed)';
CREATE INDEX participant_patient_idx ON telehealth.participant (patient_id);
CREATE INDEX participant_session_idx ON telehealth.participant (session_id, admission);

-- One row per join-token ISSUE. The token itself is the vendor's and is never stored (22.10); no hash of it either: nothing here can
-- be used to join. At most one token per participant is live (`issued`); issuing another supersedes it. A short life: 15 minutes at most.
CREATE TABLE telehealth.join_token (
  id                 uuid        PRIMARY KEY,
  organisation_id    uuid        NOT NULL,
  session_id         uuid        NOT NULL REFERENCES telehealth.video_session (id),
  participant_id     uuid        NOT NULL REFERENCES telehealth.participant (id),
  patient_id         uuid        NOT NULL REFERENCES patient.patient (id),
  principal_id       uuid        NOT NULL REFERENCES identity.principal (id),
  status             text        NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'used', 'revoked')),
  issued_at          timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoke_reason      text        CHECK (revoke_reason IS NULL OR revoke_reason IN ('superseded', 'session_ended', 'kill_switch', 'vendor_failed', 'removed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  created_by_job     uuid,
  row_version        bigint      NOT NULL DEFAULT 1,
  updated_at         timestamptz,
  CONSTRAINT join_token_short_lived CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'),
  CONSTRAINT join_token_revoked_shape CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
                                             AND (status = 'revoked' OR (revoked_at IS NULL AND revoke_reason IS NULL)))
);
COMMENT ON TABLE telehealth.join_token IS 'class=C2; issuance record of a vendor join token (the token is never stored); merge participant R/K (by its session)';
CREATE UNIQUE INDEX join_token_live_uq ON telehealth.join_token (participant_id) WHERE status = 'issued';
CREATE INDEX join_token_session_idx ON telehealth.join_token (session_id);
CREATE INDEX join_token_patient_idx ON telehealth.join_token (patient_id);
CREATE INDEX join_token_principal_idx ON telehealth.join_token (principal_id) WHERE status = 'issued';

-- Append-only (K for every row): what a person said about where they are, and what the licensing rule answered at that moment.
CREATE TABLE telehealth.location_confirmation (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  reservation_id   uuid        NOT NULL REFERENCES scheduling.slot_reservation (id),
  patient_id       uuid        NOT NULL REFERENCES patient.patient (id),
  principal_id     uuid        NOT NULL REFERENCES identity.principal (id),
  stated_state     text        NOT NULL CHECK (stated_state ~ '^[A-Z]{2}$'),
  confirmed_at     timestamptz NOT NULL DEFAULT now(),
  result           text        NOT NULL CHECK (result IN ('allowed', 'refused_not_licensed', 'refused_not_operating')),
  -- Flag mode only (setting telehealth_licensing_mode = flag): the visit goes ahead although the rule said no, and the row says so.
  override_reason  text        CHECK (override_reason IS NULL OR override_reason = 'licensing_mode_flag'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  CONSTRAINT location_confirmation_override CHECK (override_reason IS NULL OR result <> 'allowed')
);
COMMENT ON TABLE telehealth.location_confirmation IS 'class=C2; merge participant: K for every row (kept, never re-pointed)';
CREATE INDEX location_confirmation_reservation_idx ON telehealth.location_confirmation (reservation_id, principal_id, confirmed_at DESC);
CREATE INDEX location_confirmation_patient_idx ON telehealth.location_confirmation (patient_id);
