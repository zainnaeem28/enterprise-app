-- migration-class: expand
-- clinical front-door tables (ARCHITECTURE 22.11, 22.16, 25.5; PRD RA-R1-06, RA-R1-07, RA-R1-08, RA-R1-29, RA-R1-30; ticket BE-18,
-- migrations 1700-1799). DDL only (SBR-17). Triggers (and the merge guard ownership): 1701. Row-level security and grants: 1702.
--
-- Created here: questionnaire_response, triage_assessment (append-only; a re-triage is a new row), referral, referral_inbox (the
-- PHI-minimal inbox of a sent internal referral), consent_exception (append-only record of an emergency exception to BR-09) and
-- follow_up (RA-R1-30 follow-up record). The other 22.11 tables belong to BE-16 (chart) and BE-17 (encounters, notes).
--
-- Small, recorded departures from 22.11 (all additive; see the module README):
--   * every table also carries organisation_id (21.4: every template requires it), created_at / created_by, row_version / updated_at
--     where the row is mutable;
--   * reservation_id, check_in_id, encounter_id, alert_id and the follow-up's booked reservation are plain uuid columns, not foreign
--     keys: the scheduling, notifications and BE-17 tables are other modules' (SHARED-BOUNDARIES 4), and a foreign key would force an
--     order on tickets that the design does not ask for. The service reads them through the owner's own RLS and ports;
--   * follow_up is NEW: 22.11 has no table for the follow-up record that RA-R1-30 and the ticket name (the BOOKING part is
--     scheduling's, SHARED-BOUNDARIES 4). It is the task-list row of UI-UX PC-07: patient, place, optional service, owner, due date,
--     reason, status, and the reservation once booked. Merge class R for open and booked, K for done and cancelled. Needs the
--     Architect's confirmation (module README, limitations);
--   * triage_assessment.location_id is added: the triage save is audited and alerted per location (25.5) and the check-in row of
--     scheduling is not readable by a clinical policy.

CREATE TABLE clinical.questionnaire_response (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  patient_id       uuid        NOT NULL REFERENCES patient.patient (id),
  reservation_id   uuid,
  template_key     text        NOT NULL CHECK (char_length(template_key) BETWEEN 1 AND 100),
  template_version integer     NOT NULL CHECK (template_version >= 1),
  answers          jsonb       NOT NULL CHECK (jsonb_typeof(answers) = 'object' AND pg_column_size(answers) <= 65536),
  status           text        NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted')),
  submitted_at     timestamptz,
  red_flag         boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  row_version      bigint      NOT NULL DEFAULT 1,
  updated_at       timestamptz,
  CONSTRAINT questionnaire_response_submitted_shape CHECK ((status = 'submitted') = (submitted_at IS NOT NULL)),
  CONSTRAINT questionnaire_response_red_flag_shape CHECK (status = 'submitted' OR NOT red_flag)
);
COMMENT ON TABLE clinical.questionnaire_response IS 'class=C2; merge participant R/K (in_progress R; submitted K)';
CREATE INDEX questionnaire_response_reservation_idx ON clinical.questionnaire_response (reservation_id);
CREATE INDEX questionnaire_response_patient_idx ON clinical.questionnaire_response (patient_id, created_at);
-- One response per patient, visit and template while it is being filled in or after it is submitted: the portal saves a draft
-- and submits the same row. A second draft for the same visit and template is refused by the database.
CREATE UNIQUE INDEX questionnaire_response_visit_uq ON clinical.questionnaire_response (patient_id, reservation_id, template_key)
  WHERE reservation_id IS NOT NULL;

CREATE TABLE clinical.triage_assessment (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  check_in_id      uuid        NOT NULL,
  patient_id       uuid        NOT NULL REFERENCES patient.patient (id),
  location_id      uuid        NOT NULL REFERENCES organisation.location (id),
  category         text        NOT NULL CHECK (category IN ('emergency', 'urgent', 'standard', 'non_urgent')),
  symptoms         jsonb       CHECK (symptoms IS NULL OR (jsonb_typeof(symptoms) = 'object' AND pg_column_size(symptoms) <= 16384)),
  notes            text        CHECK (notes IS NULL OR char_length(notes) <= 5000),
  red_flag         boolean     NOT NULL DEFAULT false,
  alert_id         uuid,
  by_principal_id  uuid        NOT NULL REFERENCES identity.principal (id),
  assessed_at      timestamptz NOT NULL DEFAULT now(),
  supersedes_id    uuid        REFERENCES clinical.triage_assessment (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  -- A raised red flag names its alert; the alert row commits with the triage or not at all (25.5).
  CONSTRAINT triage_alert_shape CHECK (red_flag OR alert_id IS NULL),
  CONSTRAINT triage_supersedes_uq UNIQUE (supersedes_id)
);
COMMENT ON TABLE clinical.triage_assessment IS 'class=C2; append-only; merge participant K';
-- One first triage per check-in; a re-triage is a new row that supersedes the current one (22.11).
CREATE UNIQUE INDEX triage_first_per_check_in_uq ON clinical.triage_assessment (check_in_id) WHERE supersedes_id IS NULL;
CREATE INDEX triage_check_in_idx ON clinical.triage_assessment (check_in_id);
CREATE INDEX triage_patient_idx ON clinical.triage_assessment (patient_id, assessed_at);

CREATE TABLE clinical.referral (
  id                    uuid        PRIMARY KEY,
  organisation_id       uuid        NOT NULL,
  patient_id            uuid        NOT NULL REFERENCES patient.patient (id),
  from_location_id      uuid        NOT NULL REFERENCES organisation.location (id),
  from_principal_id     uuid        NOT NULL REFERENCES identity.principal (id),
  target_kind           text        NOT NULL CHECK (target_kind IN ('internal_location', 'internal_service', 'external')),
  target_location_id    uuid        REFERENCES organisation.location (id),
  target_service_id     uuid        REFERENCES organisation.service (id),
  target_external_text  text        CHECK (target_external_text IS NULL OR char_length(btrim(target_external_text)) BETWEEN 1 AND 500),
  reason                text        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2048),
  status                text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'completed', 'cancelled')),
  decided_by            uuid        REFERENCES identity.principal (id),
  decided_at            timestamptz,
  decline_reason        text        CHECK (decline_reason IS NULL OR char_length(decline_reason) BETWEEN 1 AND 500),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  row_version           bigint      NOT NULL DEFAULT 1,
  updated_at            timestamptz,
  -- 22.11 (draft 7): an internal referral names the location that receives it; for internal_service the sender picks the location
  -- at send time. An external one names free text and no location.
  CONSTRAINT referral_target_shape CHECK (
    CASE target_kind
      WHEN 'internal_location' THEN target_location_id IS NOT NULL AND target_service_id IS NULL AND target_external_text IS NULL
      WHEN 'internal_service'  THEN target_service_id IS NOT NULL AND (target_location_id IS NOT NULL OR status = 'draft') AND target_external_text IS NULL
      ELSE target_external_text IS NOT NULL AND target_location_id IS NULL AND target_service_id IS NULL END),
  CONSTRAINT referral_decision_shape CHECK (
    (status IN ('accepted', 'declined') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    OR (status NOT IN ('accepted', 'declined') AND (decided_by IS NULL OR status = 'completed'))),
  CONSTRAINT referral_decline_reason_shape CHECK ((status = 'declined') = (decline_reason IS NOT NULL))
);
COMMENT ON TABLE clinical.referral IS 'class=C2; merge participant R/K (draft, sent, accepted R; declined, completed, cancelled K)';
CREATE INDEX referral_patient_idx ON clinical.referral (patient_id);
CREATE INDEX referral_target_status_idx ON clinical.referral (target_location_id, status);

-- The PHI-minimal inbox of a sent internal referral (22.11 note): no patient column, the referral ID is the only label.
CREATE TABLE clinical.referral_inbox (
  referral_id         uuid        PRIMARY KEY REFERENCES clinical.referral (id),
  organisation_id     uuid        NOT NULL,
  target_location_id  uuid        NOT NULL REFERENCES organisation.location (id),
  patient_label_ref   uuid        NOT NULL,
  status              text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  decided_at          timestamptz,
  row_version         bigint      NOT NULL DEFAULT 1,
  updated_at          timestamptz,
  CONSTRAINT referral_inbox_label CHECK (patient_label_ref = referral_id),
  CONSTRAINT referral_inbox_decided CHECK ((status = 'pending') = (decided_at IS NULL))
);
COMMENT ON TABLE clinical.referral_inbox IS 'class=C1; no patient_id; written by clinical in the send transaction';
CREATE INDEX referral_inbox_target_idx ON clinical.referral_inbox (target_location_id, status);

-- The emergency exception to BR-09 (22.11): append-only. encounter_id is a plain uuid until BE-17's table exists.
CREATE TABLE clinical.consent_exception (
  id                 uuid        PRIMARY KEY,
  organisation_id    uuid        NOT NULL,
  encounter_id       uuid        NOT NULL,
  patient_id         uuid        NOT NULL REFERENCES patient.patient (id),
  missing_templates  text[]      NOT NULL CHECK (cardinality(missing_templates) BETWEEN 1 AND 50),
  reason             text        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500),
  by_principal_id    uuid        NOT NULL REFERENCES identity.principal (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  CONSTRAINT consent_exception_encounter_uq UNIQUE (encounter_id)
);
COMMENT ON TABLE clinical.consent_exception IS 'class=C2; append-only; merge participant K';
CREATE INDEX consent_exception_patient_idx ON clinical.consent_exception (patient_id, created_at);

-- RA-R1-30 follow-up record (departure above): the task-list row; the booking itself is scheduling's.
CREATE TABLE clinical.follow_up (
  id                     uuid        PRIMARY KEY,
  organisation_id        uuid        NOT NULL,
  patient_id             uuid        NOT NULL REFERENCES patient.patient (id),
  location_id            uuid        NOT NULL REFERENCES organisation.location (id),
  service_id             uuid        REFERENCES organisation.service (id),
  requested_by           uuid        NOT NULL REFERENCES identity.principal (id),
  owner_principal_id     uuid        REFERENCES identity.principal (id),
  due_on                 date        NOT NULL,
  reason                 text        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  status                 text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'booked', 'done', 'cancelled')),
  booked_reservation_id  uuid,
  closed_at              timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  row_version            bigint      NOT NULL DEFAULT 1,
  updated_at             timestamptz,
  CONSTRAINT follow_up_booked_shape CHECK ((status = 'booked') = (booked_reservation_id IS NOT NULL) OR status IN ('done', 'cancelled')),
  CONSTRAINT follow_up_closed_shape CHECK ((status IN ('done', 'cancelled')) = (closed_at IS NOT NULL))
);
COMMENT ON TABLE clinical.follow_up IS 'class=C2; merge participant R/K (open, booked R; done, cancelled K)';
CREATE INDEX follow_up_patient_idx ON clinical.follow_up (patient_id, status);
CREATE INDEX follow_up_location_due_idx ON clinical.follow_up (location_id, status, due_on);
