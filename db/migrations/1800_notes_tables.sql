-- migration-class: expand
-- clinical encounters and notes (ARCHITECTURE 22.11, 22.16, 23.2, 25.5; PRD RA-R1-09, BR-11, BR-12; ticket BE-17, migrations 1800-1899).
-- DDL only (SBR-17). Triggers (and the merge guard ownership): 1801. Row-level security and grants: 1802.
--
-- Created here: encounter, note, note_cosign (append-only) and note_addendum (append-only). The schema `clinical` and the other
-- 22.11 tables belong to BE-16 (chart, 1600-1603) and BE-18 (front door, 1700-1702).
--
-- Small, recorded departures from 22.11 (all additive; see the module README):
--   * every table also carries organisation_id (21.4: every template requires it), created_at / created_by, row_version / updated_at
--     where the row is mutable;
--   * encounter.reservation_id is a plain uuid (unique), not a foreign key: the reservation is scheduling's table (SHARED-BOUNDARIES 4);
--   * note.template_id is the KEY of a built-in note template (text, for example 'soap'), because no note-template table exists in
--     22.11 or 22.5 and R1 ships one template; the template list is code (module README), not data;
--   * note.cosign_required_from holds the principal whose co-signature the note waits for (the author's supervisor on the day the
--     trainee submitted it); note.submitted_for_cosign_at stamps that day. A note that was never submitted for co-signature has both null;
--   * a signed note's `signed_by` is the signature of record: the author for a direct signature, the supervisor for a co-signed trainee
--     note (author_principal_id keeps the author).

CREATE TABLE clinical.encounter (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  patient_id              uuid        NOT NULL REFERENCES patient.patient (id),
  location_id             uuid        NOT NULL REFERENCES organisation.location (id),
  reservation_id          uuid,
  clinician_principal_id  uuid        NOT NULL REFERENCES identity.principal (id),
  mode                    text        NOT NULL CHECK (mode IN ('in_person', 'video')),
  status                  text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_consultation', 'completed', 'cancelled')),
  started_at              timestamptz,
  ended_at                timestamptz,
  note_deferred_reason    text        CHECK (note_deferred_reason IS NULL OR char_length(btrim(note_deferred_reason)) BETWEEN 10 AND 500),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  row_version             bigint      NOT NULL DEFAULT 1,
  updated_at              timestamptz,
  CONSTRAINT encounter_reservation_uq UNIQUE (reservation_id),
  CONSTRAINT encounter_times_shape CHECK (
    (status = 'open'            AND started_at IS NULL     AND ended_at IS NULL)
 OR (status = 'in_consultation' AND started_at IS NOT NULL AND ended_at IS NULL)
 OR (status = 'completed'       AND started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at >= started_at)
 OR (status = 'cancelled'       AND started_at IS NULL     AND ended_at IS NOT NULL)),
  CONSTRAINT encounter_deferral_shape CHECK (note_deferred_reason IS NULL OR status = 'completed')
);
COMMENT ON TABLE clinical.encounter IS 'class=C2; merge participant R/K (open, in_consultation R; completed, cancelled K)';
CREATE INDEX encounter_patient_started_idx ON clinical.encounter (patient_id, started_at);
CREATE INDEX encounter_clinician_status_idx ON clinical.encounter (clinician_principal_id, status);

CREATE TABLE clinical.note (
  id                        uuid        PRIMARY KEY,
  organisation_id           uuid        NOT NULL,
  encounter_id              uuid        NOT NULL REFERENCES clinical.encounter (id),
  patient_id                uuid        NOT NULL REFERENCES patient.patient (id),
  author_principal_id       uuid        NOT NULL REFERENCES identity.principal (id),
  template_id               text        NOT NULL CHECK (template_id ~ '^[a-z][a-z0-9_-]{0,39}$'),
  body                      jsonb       NOT NULL CHECK (jsonb_typeof(body) = 'object' AND pg_column_size(body) <= 204800),
  status                    text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_cosign', 'signed')),
  submitted_for_cosign_at   timestamptz,
  cosign_required_from      uuid        REFERENCES identity.principal (id),
  signed_at                 timestamptz,
  signed_by                 uuid        REFERENCES identity.principal (id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  row_version               bigint      NOT NULL DEFAULT 1,
  updated_at                timestamptz,
  CONSTRAINT note_signed_shape CHECK ((status = 'signed') = (signed_at IS NOT NULL AND signed_by IS NOT NULL)),
  CONSTRAINT note_cosign_shape CHECK (
    (status = 'draft' AND submitted_for_cosign_at IS NULL AND cosign_required_from IS NULL)
 OR (status = 'pending_cosign' AND submitted_for_cosign_at IS NOT NULL AND cosign_required_from IS NOT NULL)
 OR (status = 'signed' AND (submitted_for_cosign_at IS NULL) = (cosign_required_from IS NULL))),
  CONSTRAINT note_cosigner_not_author CHECK (cosign_required_from IS NULL OR cosign_required_from <> author_principal_id)
);
COMMENT ON TABLE clinical.note IS 'class=C2; merge participant R/K (draft, pending_cosign R; signed K); a signed note is locked (23.2)';
CREATE INDEX note_patient_created_idx ON clinical.note (patient_id, created_at);
CREATE INDEX note_author_status_idx ON clinical.note (author_principal_id, status);
CREATE INDEX note_encounter_idx ON clinical.note (encounter_id);

CREATE TABLE clinical.note_cosign (
  note_id                 uuid        PRIMARY KEY REFERENCES clinical.note (id),
  organisation_id         uuid        NOT NULL,
  patient_id              uuid        NOT NULL REFERENCES patient.patient (id),
  supervisor_principal_id uuid        NOT NULL REFERENCES identity.principal (id),
  cosigned_at             timestamptz NOT NULL DEFAULT now(),
  created_by              uuid
);
COMMENT ON TABLE clinical.note_cosign IS 'class=C2; append-only; merge participant K';
CREATE INDEX note_cosign_patient_idx ON clinical.note_cosign (patient_id);

CREATE TABLE clinical.note_addendum (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  note_id                 uuid        NOT NULL REFERENCES clinical.note (id),
  patient_id              uuid        NOT NULL REFERENCES patient.patient (id),
  author_principal_id     uuid        NOT NULL REFERENCES identity.principal (id),
  body                    text        NOT NULL CHECK (char_length(btrim(body)) >= 1 AND octet_length(body) <= 51200),
  signed_at               timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid
);
COMMENT ON TABLE clinical.note_addendum IS 'class=C2; append-only; merge participant K (carries the survivor patient_id if the note patient was merged, 9.2)';
CREATE INDEX note_addendum_note_idx ON clinical.note_addendum (note_id, signed_at);
CREATE INDEX note_addendum_patient_idx ON clinical.note_addendum (patient_id);
