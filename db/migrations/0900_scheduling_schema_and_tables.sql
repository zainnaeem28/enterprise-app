-- migration-class: expand
-- scheduling schema, booking core (ARCHITECTURE 5.1, 22.8, 23.1; SHARED-BOUNDARIES 6.5; ticket BE-11, migrations 0900-0999).
-- DDL only (SBR-17). Triggers: 0901. Row-level security and grants: 0902. Definer functions: 0903.
--
-- Created here: slot_occupancy (the PHI-free twin that carries the booking invariant) and slot_reservation (holds and
-- appointments, with the patient). The other 22.8 tables (templates, blocked time, busy blocks, check-in, queue, waitlist,
-- roster) belong to BE-12 and BE-13.
--
-- Small, recorded departures from 22.8 (all additive; see the module README):
--   * slot_reservation.id also references slot_occupancy (deferred), so an orphan reservation fails at commit just as an orphan
--     occupancy row does (the twin is enforced in both directions);
--   * rescheduled_from_id is a plain self reference plus a unique index (one reschedule per reservation);
--   * the exclusion constraints use btree_gist (a trusted extension, created here by the database owner, in the scheduling schema).

CREATE SCHEMA scheduling;
COMMENT ON SCHEMA scheduling IS 'Slot occupancy, reservations (holds and appointments), availability, check-in, queue, waitlist (ARCHITECTURE 22.8)';
REVOKE ALL ON SCHEMA scheduling FROM PUBLIC;
GRANT USAGE ON SCHEMA scheduling TO app_api, app_worker, scheduling_booking_owner;
-- btree_gist (a trusted extension; the database owner may create it) lives in this schema: the migration role has no search_path
-- schema to fall back on, and its operator classes are resolved by type, not by name.
CREATE EXTENSION btree_gist SCHEMA scheduling;
-- Needed only to move function ownership to the function-owner role; withdrawn again at the end of 0903.
GRANT CREATE ON SCHEMA scheduling TO scheduling_booking_owner;

CREATE TABLE scheduling.slot_occupancy (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  location_id             uuid        NOT NULL REFERENCES organisation.location (id),
  clinician_principal_id  uuid        NOT NULL REFERENCES identity.principal (id),
  room_id                 uuid        REFERENCES organisation.room (id),
  period                  tstzrange   NOT NULL,
  status                  text        NOT NULL CHECK (status IN ('held', 'confirmed', 'checked_in', 'in_consultation', 'completed',
                                                              'cancelled_patient', 'cancelled_clinic', 'rescheduled', 'no_show', 'expired')),
  expires_at              timestamptz,
  overbook                boolean     NOT NULL DEFAULT false,
  session_key             text        CHECK (session_key IS NULL OR char_length(session_key) BETWEEN 1 AND 200),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  created_by_job          uuid,
  row_version             bigint      NOT NULL DEFAULT 1,
  updated_at              timestamptz,
  -- [) bounds, finite, not empty: a half-open interval is what makes back-to-back visits not overlap.
  CONSTRAINT slot_occupancy_period_shape CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
                                                AND NOT lower_inf(period) AND NOT upper_inf(period)),
  CONSTRAINT slot_occupancy_hold_expiry CHECK ((status = 'held') = (expires_at IS NOT NULL)),
  CONSTRAINT slot_occupancy_overbook_session CHECK (NOT overbook OR session_key IS NOT NULL),
  -- BR-02, RA-R1-03: one active visit per doctor and time. Overbook rows are excluded (they are counted against the cap instead).
  CONSTRAINT slot_occupancy_doctor_excl EXCLUDE USING gist (clinician_principal_id WITH =, period WITH &&)
    WHERE (status IN ('held', 'confirmed', 'checked_in', 'in_consultation', 'completed') AND NOT overbook),
  -- SAR-09: the same for a room, where one is assigned. A video visit has none.
  CONSTRAINT slot_occupancy_room_excl EXCLUDE USING gist (room_id WITH =, period WITH &&)
    WHERE (room_id IS NOT NULL AND status IN ('held', 'confirmed', 'checked_in', 'in_consultation', 'completed') AND NOT overbook)
);
COMMENT ON TABLE scheduling.slot_occupancy IS 'class=C1; PHI-free twin of slot_reservation (no patient, no service, no free text); written only by scheduling.occupy and scheduling.set_status';
CREATE INDEX slot_occupancy_location_start_idx ON scheduling.slot_occupancy (location_id, lower(period));
CREATE INDEX slot_occupancy_held_expiry_idx ON scheduling.slot_occupancy (status, expires_at) WHERE status = 'held';
CREATE INDEX slot_occupancy_clinician_period_idx ON scheduling.slot_occupancy USING gist (clinician_principal_id, period);
CREATE INDEX slot_occupancy_session_idx ON scheduling.slot_occupancy (clinician_principal_id, session_key) WHERE overbook;

CREATE TABLE scheduling.slot_reservation (
  id                        uuid        PRIMARY KEY,
  organisation_id           uuid        NOT NULL,
  patient_id                uuid        NOT NULL REFERENCES patient.patient (id),
  service_id                uuid        NOT NULL REFERENCES organisation.service (id),
  location_id               uuid        NOT NULL REFERENCES organisation.location (id),
  clinician_principal_id    uuid        NOT NULL REFERENCES identity.principal (id),
  mode                      text        NOT NULL CHECK (mode IN ('in_person', 'video')),
  reason                    text        CHECK (reason IS NULL OR char_length(reason) <= 500),
  patient_stated_state      text        CHECK (patient_stated_state IS NULL OR patient_stated_state ~ '^[A-Z]{2}$'),
  licensing_result          text        CHECK (licensing_result IS NULL OR licensing_result IN ('not_required', 'allowed', 'flagged')),
  booked_by_principal_id    uuid        NOT NULL REFERENCES identity.principal (id),
  booked_via                text        NOT NULL CHECK (booked_via IN ('patient', 'proxy', 'staff', 'waitlist')),
  rescheduled_from_id       uuid        REFERENCES scheduling.slot_reservation (id),
  follow_up_of_encounter_id uuid,
  cancel_reason             text        CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 500),
  late_change               boolean,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  created_by_job            uuid,
  row_version               bigint      NOT NULL DEFAULT 1,
  updated_at                timestamptz,
  CONSTRAINT slot_reservation_not_self_rescheduled CHECK (rescheduled_from_id IS NULL OR rescheduled_from_id <> id),
  -- A video visit is checked against the licensing rule (TL-1); an in-person visit is not.
  CONSTRAINT slot_reservation_licensing_shape CHECK ((mode = 'video') OR licensing_result IS NULL OR licensing_result = 'not_required')
);
COMMENT ON TABLE scheduling.slot_reservation IS 'class=C2; merge participant R/K (R while the occupancy is held, confirmed or checked_in)';
CREATE UNIQUE INDEX slot_reservation_rescheduled_from_uq ON scheduling.slot_reservation (rescheduled_from_id) WHERE rescheduled_from_id IS NOT NULL;
CREATE INDEX slot_reservation_patient_idx ON scheduling.slot_reservation (patient_id, created_at);
CREATE INDEX slot_reservation_clinician_idx ON scheduling.slot_reservation (clinician_principal_id);
CREATE INDEX slot_reservation_location_idx ON scheduling.slot_reservation (location_id);

-- O-3: the twin. Both rows are created in one transaction; either one without the other fails at commit.
ALTER TABLE scheduling.slot_occupancy
  ADD CONSTRAINT slot_occupancy_reservation_fk FOREIGN KEY (id) REFERENCES scheduling.slot_reservation (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE scheduling.slot_reservation
  ADD CONSTRAINT slot_reservation_occupancy_fk FOREIGN KEY (id) REFERENCES scheduling.slot_occupancy (id) DEFERRABLE INITIALLY DEFERRED;
