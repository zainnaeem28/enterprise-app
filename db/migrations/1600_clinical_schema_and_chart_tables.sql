-- migration-class: expand
-- clinical schema, chart tables (ARCHITECTURE 5.1, 22.11, 22.16; PRD RA-R1-09, RA-R1-24, BR-34; ticket BE-16, migrations 1600-1699).
-- DDL only (SBR-17). Triggers: 1601. Row-level security and grants: 1602. Merge guard ownership: 1603.
--
-- Created here: problem, allergy, medication_statement (coded lists; free text is allowed and flagged uncoded), vital_sign
-- (append-only, with the range status and the bounds applied copied onto the row), vital_range (the reference ranges; ships EMPTY, the
-- content is clinical and waits for the D-12a reviewer, BQ-12) and terminology_concept (reference data for the coded pickers, loaded by
-- the worker job clinical.terminology_load). The other 22.11 tables (encounter, note, triage, referral, questionnaire_response,
-- immunisation, consent_exception) belong to BE-17 and BE-18.
--
-- Small, recorded departures from 22.11 (all additive; see the module README):
--   * every table also carries organisation_id (21.4: every template requires it), created_at / created_by, row_version / updated_at
--     where the row is mutable; terminology_concept keeps PK (system, code) and carries organisation_id as a plain column;
--   * vital_sign.encounter_id and check_in_id are plain uuid columns: the encounter table (BE-17) and the check-in table (BE-13) do
--     not exist yet, and a foreign key would force an order on tickets that the design does not ask for;
--   * the exclusion constraint of vital_range uses btree_gist, which BE-11 created in the scheduling schema (operator classes are found
--     by type, not by schema); pg_trgm lives in this schema.

CREATE SCHEMA clinical;
COMMENT ON SCHEMA clinical IS 'Encounters, notes, problems, allergies, medications, vitals, triage, referrals (ARCHITECTURE 22.11)';
REVOKE ALL ON SCHEMA clinical FROM PUBLIC;
GRANT USAGE ON SCHEMA clinical TO app_api, app_worker;
-- Needed only to move the merge write guard's ownership to the function-owner role (1603); withdrawn again there.
GRANT CREATE ON SCHEMA clinical TO patient_scope_owner;
-- Trigram index for the terminology picker (22.11). A trusted extension; the database owner may create it.
CREATE EXTENSION pg_trgm SCHEMA clinical;

CREATE TABLE clinical.problem (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  patient_id       uuid        NOT NULL REFERENCES patient.patient (id),
  code_system      text        CHECK (code_system IS NULL OR code_system IN ('snomed', 'icd10cm')),
  code             text        CHECK (code IS NULL OR code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  display          text        NOT NULL CHECK (char_length(display) BETWEEN 1 AND 200),
  coded            boolean     NOT NULL,
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'inactive', 'entered_in_error')),
  onset_date       date,
  resolved_date    date,
  recorded_by      uuid        NOT NULL REFERENCES identity.principal (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  row_version      bigint      NOT NULL DEFAULT 1,
  updated_at       timestamptz,
  CONSTRAINT problem_coded_shape CHECK (coded = (code IS NOT NULL) AND (code IS NULL) = (code_system IS NULL)),
  CONSTRAINT problem_dates CHECK (resolved_date IS NULL OR onset_date IS NULL OR resolved_date >= onset_date)
);
COMMENT ON TABLE clinical.problem IS 'class=C2; merge participant R (every status, 22.16)';
CREATE INDEX problem_patient_status_idx ON clinical.problem (patient_id, status);

CREATE TABLE clinical.allergy (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  patient_id       uuid        NOT NULL REFERENCES patient.patient (id),
  code_system      text        CHECK (code_system IS NULL OR code_system IN ('rxnorm', 'snomed')),
  code             text        CHECK (code IS NULL OR code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  display          text        NOT NULL CHECK (char_length(display) BETWEEN 1 AND 200),
  coded            boolean     NOT NULL,
  category         text        NOT NULL CHECK (category IN ('drug', 'food', 'environment')),
  reaction         text        CHECK (reaction IS NULL OR char_length(reaction) BETWEEN 1 AND 500),
  severity         text        NOT NULL DEFAULT 'unknown' CHECK (severity IN ('mild', 'moderate', 'severe', 'unknown')),
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'inactive', 'entered_in_error')),
  onset_date       date,
  resolved_date    date,
  recorded_by      uuid        NOT NULL REFERENCES identity.principal (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  row_version      bigint      NOT NULL DEFAULT 1,
  updated_at       timestamptz,
  CONSTRAINT allergy_coded_shape CHECK (coded = (code IS NOT NULL) AND (code IS NULL) = (code_system IS NULL)),
  CONSTRAINT allergy_dates CHECK (resolved_date IS NULL OR onset_date IS NULL OR resolved_date >= onset_date)
);
COMMENT ON TABLE clinical.allergy IS 'class=C2; merge participant R (every status, 22.16); read for the patient banner (28.2)';
CREATE INDEX allergy_patient_status_idx ON clinical.allergy (patient_id, status);

CREATE TABLE clinical.medication_statement (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  patient_id       uuid        NOT NULL REFERENCES patient.patient (id),
  rxnorm_code      text        CHECK (rxnorm_code IS NULL OR rxnorm_code ~ '^[0-9]{1,12}$'),
  display          text        NOT NULL CHECK (char_length(display) BETWEEN 1 AND 200),
  coded            boolean     NOT NULL,
  dose_text        text        CHECK (dose_text IS NULL OR char_length(dose_text) BETWEEN 1 AND 200),
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'entered_in_error')),
  start_date       date,
  end_date         date,
  recorded_by      uuid        NOT NULL REFERENCES identity.principal (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  row_version      bigint      NOT NULL DEFAULT 1,
  updated_at       timestamptz,
  CONSTRAINT medication_coded_shape CHECK (coded = (rxnorm_code IS NOT NULL)),
  CONSTRAINT medication_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
COMMENT ON TABLE clinical.medication_statement IS 'class=C2; merge participant R (every status, 22.16)';
CREATE INDEX medication_patient_status_idx ON clinical.medication_statement (patient_id, status);

-- Reference ranges for vitals (AL-02). Ships empty: the numbers are clinical content (D-12a, BQ-12), entered by an admin with the
-- reviewer's note; nothing here asserts that any range is clinically correct.
CREATE TABLE clinical.vital_range (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL,
  loinc_code        text        NOT NULL CHECK (loinc_code ~ '^[0-9]{1,7}-[0-9]$'),
  unit              text        NOT NULL CHECK (unit ~ '^[A-Za-z0-9%/.\[\]{}()*^_+-]{1,40}$'),
  sex               text        NOT NULL CHECK (sex IN ('any', 'female', 'male')),
  age_years         int4range   NOT NULL,
  low               numeric,
  high              numeric,
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  approved_by_note  text        NOT NULL CHECK (char_length(approved_by_note) BETWEEN 10 AND 1000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  row_version       bigint      NOT NULL DEFAULT 1,
  updated_at        timestamptz,
  retired_at        timestamptz,
  retired_by        uuid,
  CONSTRAINT vital_range_bound_present CHECK (low IS NOT NULL OR high IS NOT NULL),
  CONSTRAINT vital_range_bounds_order CHECK (low IS NULL OR high IS NULL OR low < high),
  -- Half-open, whole years, not empty, a lower bound that is a real age (the upper may be open: "[18,)").
  CONSTRAINT vital_range_age_shape CHECK (NOT isempty(age_years) AND lower_inc(age_years) AND NOT lower_inf(age_years)
                                           AND lower(age_years) >= 0 AND (upper_inf(age_years) OR upper(age_years) <= 150)),
  CONSTRAINT vital_range_retired_shape CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  -- No two active ranges overlap for one code and sex (a sex-specific range and an `any` range may; the sex-specific one wins).
  CONSTRAINT vital_range_no_overlap EXCLUDE USING gist (loinc_code WITH =, sex WITH =, age_years WITH &&) WHERE (status = 'active')
);
COMMENT ON TABLE clinical.vital_range IS 'class=C1; ships empty (D-12a); a change is a new row plus retiring the old one';
CREATE INDEX vital_range_lookup_idx ON clinical.vital_range (loinc_code, status);

CREATE TABLE clinical.vital_sign (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  patient_id       uuid        NOT NULL REFERENCES patient.patient (id),
  encounter_id     uuid,
  check_in_id      uuid,
  loinc_code       text        NOT NULL CHECK (loinc_code ~ '^[0-9]{1,7}-[0-9]$'),
  value            numeric,
  unit             text        CHECK (unit IS NULL OR unit ~ '^[A-Za-z0-9%/.\[\]{}()*^_+-]{1,40}$'),
  range_status     text        NOT NULL CHECK (range_status IN ('in_range', 'out_of_range', 'no_range', 'unit_mismatch')),
  range_id         uuid        REFERENCES clinical.vital_range (id),
  range_low        numeric,
  range_high       numeric,
  measured_at      timestamptz NOT NULL,
  by_principal_id  uuid        NOT NULL REFERENCES identity.principal (id),
  corrects_id      uuid        REFERENCES clinical.vital_sign (id),
  entered_in_error boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  -- A row is corrected at most once; the current value is the end of the chain (TDR-10).
  CONSTRAINT vital_sign_corrects_uq UNIQUE (corrects_id),
  CONSTRAINT vital_sign_error_shape CHECK (NOT entered_in_error OR (corrects_id IS NOT NULL AND value IS NULL)),
  CONSTRAINT vital_sign_value_shape CHECK (entered_in_error OR (value IS NOT NULL AND unit IS NOT NULL)),
  -- The range applied exists exactly when the value was judged against it; the bounds are copies, so a later range change
  -- rewrites no history. An entered-in-error row is stored as no_range with nothing applied (N-7).
  CONSTRAINT vital_sign_range_shape CHECK (
    CASE WHEN range_status IN ('in_range', 'out_of_range')
         THEN range_id IS NOT NULL AND (range_low IS NOT NULL OR range_high IS NOT NULL) AND value IS NOT NULL
         ELSE range_id IS NULL AND range_low IS NULL AND range_high IS NULL END),
  CONSTRAINT vital_sign_error_range CHECK (NOT entered_in_error OR range_status = 'no_range')
);
COMMENT ON TABLE clinical.vital_sign IS 'class=C2; append-only; merge participant K (a correction of a merged ID''s row is a new row on the survivor, 22.11)';
CREATE INDEX vital_sign_patient_measured_idx ON clinical.vital_sign (patient_id, measured_at);

-- Reference data for the coded pickers (RxNorm, SNOMED CT, ICD-10-CM, LOINC). Real content needs the NLM/UMLS licence account (C-09);
-- until then only what an admin or a test loads is here. Readable by every authenticated audience (C0).
CREATE TABLE clinical.terminology_concept (
  system           text        NOT NULL CHECK (system IN ('rxnorm', 'snomed', 'icd10cm', 'loinc')),
  code             text        NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  organisation_id  uuid        NOT NULL,
  display          text        NOT NULL CHECK (char_length(display) BETWEEN 1 AND 500),
  active           boolean     NOT NULL DEFAULT true,
  release          text        NOT NULL CHECK (char_length(release) BETWEEN 1 AND 40),
  loaded_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system, code)
);
COMMENT ON TABLE clinical.terminology_concept IS 'class=C0; reference data loaded by the worker job clinical.terminology_load';
CREATE INDEX terminology_display_trgm_idx ON clinical.terminology_concept USING gin (display clinical.gin_trgm_ops);
