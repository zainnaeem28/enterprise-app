-- migration-class: expand
-- scheduling flow tables (ARCHITECTURE 22.8, 22.16, 25.5, 25.6; ticket BE-13, migrations 1300-1399).
-- DDL only (SBR-17). Triggers: 1301. Row-level security and grants: 1302.
--
-- Created here: check_in and queue_entry (a patient's arrival and place in the queue; both keyed by the reservation ID),
-- waitlist_entry and waitlist_offer (BR-03), and no_show_flag (the sweep's "flag for staff" where automatic no-show is off).
--
-- Small, recorded departures from 22.8 (all additive; see the module README):
--   * no_show_flag is new: the design says the sweep "flags for staff" and names no place for the flag. It is keyed by the
--     reservation, carries no patient column (the reservation is the merge participant), and is insert-only;
--   * waitlist_offer.decided_at (when the offer left `offered`), waitlist_entry.position_at defaults to now() (FIFO key);
--   * waitlist_entry.window and waitlist_offer's foreign keys are as designed; "window" is quoted because WINDOW is a keyword.

-- Needed only to move the merge write guard's ownership to the function-owner role (1301); withdrawn again there.
GRANT CREATE ON SCHEMA scheduling TO patient_scope_owner;

CREATE TABLE scheduling.check_in (
  id                uuid        PRIMARY KEY REFERENCES scheduling.slot_reservation (id),
  organisation_id   uuid        NOT NULL,
  patient_id        uuid        NOT NULL REFERENCES patient.patient (id),
  location_id       uuid        NOT NULL REFERENCES organisation.location (id),
  method            text        NOT NULL CHECK (method IN ('desk', 'qr')),
  checked_in_at     timestamptz NOT NULL DEFAULT now(),
  by_principal_id   uuid        NOT NULL REFERENCES identity.principal (id),
  -- Booleans only (AC-09): the questionnaire, the required consents and the insurance card are each done or not. Never the content.
  previsit_status   jsonb       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  created_by_job    uuid,
  row_version       bigint      NOT NULL DEFAULT 1,
  updated_at        timestamptz,
  CONSTRAINT check_in_previsit_shape CHECK (
    jsonb_typeof(previsit_status) = 'object'
    AND jsonb_typeof(previsit_status -> 'questionnaire') = 'boolean'
    AND jsonb_typeof(previsit_status -> 'consents') = 'boolean'
    AND jsonb_typeof(previsit_status -> 'insurance') = 'boolean'
    AND (previsit_status - 'questionnaire' - 'consents' - 'insurance') = '{}'::jsonb)
);
COMMENT ON TABLE scheduling.check_in IS 'class=C2; merge participant R/K (R while the occupancy is checked_in; K once in_consultation, completed or no_show)';
CREATE INDEX check_in_patient_idx ON scheduling.check_in (patient_id);
CREATE INDEX check_in_location_time_idx ON scheduling.check_in (location_id, checked_in_at);

CREATE TABLE scheduling.queue_entry (
  id                              uuid        PRIMARY KEY REFERENCES scheduling.check_in (id),
  organisation_id                 uuid        NOT NULL,
  patient_id                      uuid        NOT NULL REFERENCES patient.patient (id),
  location_id                     uuid        NOT NULL REFERENCES organisation.location (id),
  stage                           text        NOT NULL CHECK (stage IN ('waiting', 'vitals', 'triage', 'ready', 'with_clinician', 'done')),
  assigned_clinician_principal_id uuid        REFERENCES identity.principal (id),
  room_id                         uuid        REFERENCES organisation.room (id),
  entered_at                      timestamptz NOT NULL DEFAULT now(),
  stage_changed_at                timestamptz NOT NULL DEFAULT now(),
  -- 22.11 (clinical.triage_assessment.category). Set by the triage save of BE-18 through this module's service.
  triage_category                 text        CHECK (triage_category IS NULL OR triage_category IN ('emergency', 'urgent', 'standard', 'non_urgent')),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_by                      uuid,
  created_by_job                  uuid,
  row_version                     bigint      NOT NULL DEFAULT 1,
  updated_at                      timestamptz
);
COMMENT ON TABLE scheduling.queue_entry IS 'class=C2; merge participant R/K (done is K; every other stage is R)';
CREATE INDEX queue_entry_location_stage_idx ON scheduling.queue_entry (location_id, stage, entered_at);
CREATE INDEX queue_entry_patient_idx ON scheduling.queue_entry (patient_id);

CREATE TABLE scheduling.waitlist_entry (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  patient_id              uuid        NOT NULL REFERENCES patient.patient (id),
  service_id              uuid        NOT NULL REFERENCES organisation.service (id),
  location_id             uuid        REFERENCES organisation.location (id),
  clinician_principal_id  uuid        REFERENCES identity.principal (id),
  "window"                tstzrange   NOT NULL,
  status                  text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'offered', 'fulfilled', 'cancelled', 'expired')),
  cancel_reason           text        CHECK (cancel_reason IS NULL OR cancel_reason IN ('patient', 'staff', 'merged_duplicate')),
  position_at             timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  created_by_job          uuid,
  row_version             bigint      NOT NULL DEFAULT 1,
  updated_at              timestamptz,
  CONSTRAINT waitlist_entry_window_shape CHECK (NOT isempty("window") AND NOT lower_inf("window") AND NOT upper_inf("window")),
  CONSTRAINT waitlist_entry_cancel_shape CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL))
);
COMMENT ON TABLE scheduling.waitlist_entry IS 'class=C2; merge participant R/K (active and offered are R; fulfilled, cancelled and expired are K)';
CREATE INDEX waitlist_entry_service_status_idx ON scheduling.waitlist_entry (service_id, status, position_at);
CREATE INDEX waitlist_entry_patient_idx ON scheduling.waitlist_entry (patient_id);

CREATE TABLE scheduling.waitlist_offer (
  id                 uuid        PRIMARY KEY,
  organisation_id    uuid        NOT NULL,
  waitlist_entry_id  uuid        NOT NULL REFERENCES scheduling.waitlist_entry (id),
  patient_id         uuid        NOT NULL REFERENCES patient.patient (id),
  -- The held slot: the occupancy (= reservation) the offer job created for this patient through scheduling.hold.
  occupancy_id       uuid        NOT NULL REFERENCES scheduling.slot_occupancy (id),
  status             text        NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted', 'declined', 'expired')),
  expires_at         timestamptz NOT NULL,
  decided_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  created_by_job     uuid,
  row_version        bigint      NOT NULL DEFAULT 1,
  updated_at         timestamptz,
  CONSTRAINT waitlist_offer_decided_shape CHECK ((status = 'offered') = (decided_at IS NULL))
);
COMMENT ON TABLE scheduling.waitlist_offer IS 'class=C2; merge participant R/K (offered is R; accepted, declined and expired are K)';
-- One offer per slot at a time (25.6).
CREATE UNIQUE INDEX waitlist_offer_open_occupancy_uq ON scheduling.waitlist_offer (occupancy_id) WHERE status = 'offered';
CREATE INDEX waitlist_offer_entry_idx ON scheduling.waitlist_offer (waitlist_entry_id);
CREATE INDEX waitlist_offer_patient_idx ON scheduling.waitlist_offer (patient_id);
CREATE INDEX waitlist_offer_due_idx ON scheduling.waitlist_offer (expires_at) WHERE status = 'offered';

-- The no-show sweep's flag (25.x, 33.1 `scheduling.no_show_sweep`): where automatic no-show is not allowed the sweep records that the
-- appointment is a candidate and staff decide. Insert-only, one row per reservation, no patient column (never re-pointed).
CREATE TABLE scheduling.no_show_flag (
  reservation_id   uuid        PRIMARY KEY REFERENCES scheduling.slot_reservation (id),
  organisation_id  uuid        NOT NULL,
  location_id      uuid        NOT NULL REFERENCES organisation.location (id),
  flagged_at       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by_job   uuid
);
COMMENT ON TABLE scheduling.no_show_flag IS 'class=C1; no patient column; insert-only (written by the no-show sweep)';
CREATE INDEX no_show_flag_location_idx ON scheduling.no_show_flag (location_id, flagged_at);
