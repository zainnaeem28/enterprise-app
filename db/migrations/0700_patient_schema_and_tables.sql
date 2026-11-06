-- migration-class: expand
-- patient schema and tables of ARCHITECTURE 22.6 (ticket BE-08, migrations 0700-0799). DDL only (SBR-17). Triggers and
-- guards: 0701. Row-level security and grants: 0702. Scope, registration and lock functions: 0703. Matching: 0704.
--
-- Created here: patient, patient_contact, insurance_coverage, consent, communication_preference, care_relationship,
-- staff_scope, care_team_member, duplicate_flag, match_check, and the merge map patient_merge. patient_merge is created
-- here, with no writer, because the staff-scope derivation (SHARED-BOUNDARIES 6.6) reads closure(S) from it; BE-09
-- (0800-0899) adds merge_request, merge_residue and the functions that write the map (begin_merge, complete_merge).
--
-- Small, recorded departures from 22.6 (all additive; see the module README):
--   * staff_scope and patient_merge carry organisation_id (every template requires the organisation predicate, 21.4);
--   * match_check carries candidate_patient_ids and candidate_strengths next to candidate_refs, so a ref stays opaque
--     to the client while the server can still map it back (the refs themselves are random UUIDs);
--   * consent carries signed_name (the typed signature, BR-09 evidence);
--   * email is text with a lower-case CHECK, not citext (the extension is not installed; identity.principal does the same).

CREATE SCHEMA patient;
COMMENT ON SCHEMA patient IS 'Patient root, contacts, insurance, consents, preferences, care relationships, staff scope, matching (ARCHITECTURE 22.6)';
REVOKE ALL ON SCHEMA patient FROM PUBLIC;
GRANT USAGE ON SCHEMA patient TO app_api, app_worker, patient_scope_owner, patient_match_owner;
-- Needed only to move table and function ownership to the function-owner roles; withdrawn again at the end of 0703/0704.
GRANT CREATE ON SCHEMA patient TO patient_scope_owner, patient_match_owner;

-- The record number: organisation-unique (UQ below), generated, never typed by a user.
CREATE SEQUENCE patient.mrn_seq AS bigint START WITH 1000001 MINVALUE 1000001 NO CYCLE;

CREATE TABLE patient.patient (
  id                 uuid        PRIMARY KEY,
  organisation_id    uuid        NOT NULL,
  mrn                text        NOT NULL CHECK (mrn ~ '^MRN-[0-9]{7,12}$'),
  given_name         text        NOT NULL CHECK (char_length(btrim(given_name)) BETWEEN 1 AND 100),
  family_name        text        NOT NULL CHECK (char_length(btrim(family_name)) BETWEEN 1 AND 100),
  middle_name        text        CHECK (middle_name IS NULL OR char_length(middle_name) <= 100),
  date_of_birth      date        NOT NULL CHECK (date_of_birth BETWEEN DATE '1880-01-01' AND DATE '2200-01-01'),
  sex_at_birth       text        CHECK (sex_at_birth IN ('female', 'male', 'intersex', 'unknown')),
  gender_identity    text        CHECK (gender_identity IS NULL OR char_length(gender_identity) <= 100),
  phone_e164         text        CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email              text        CHECK (email IS NULL OR (char_length(email) BETWEEN 3 AND 320 AND email = lower(email) AND position('@' in email) > 1)),
  address            jsonb       CHECK (address IS NULL OR (jsonb_typeof(address) = 'object' AND pg_column_size(address) <= 4096)),
  state_code         text        NOT NULL REFERENCES organisation.jurisdiction (code),
  preferred_language text        NOT NULL DEFAULT 'en' CHECK (preferred_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$'),
  photo_document_id  uuid,
  preferred_pharmacy jsonb       CHECK (preferred_pharmacy IS NULL OR (jsonb_typeof(preferred_pharmacy) = 'object' AND pg_column_size(preferred_pharmacy) <= 2048)),
  status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged')),
  merged_into        uuid        REFERENCES patient.patient (id),
  created_via        text        NOT NULL CHECK (created_via IN ('self', 'front_desk')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  created_by_job     uuid,
  row_version        bigint      NOT NULL DEFAULT 1,
  updated_at         timestamptz,
  CONSTRAINT patient_merged_shape CHECK ((status = 'merged') = (merged_into IS NOT NULL)),
  CONSTRAINT patient_not_self_merged CHECK (merged_into IS NULL OR merged_into <> id),
  CONSTRAINT patient_mrn_uq UNIQUE (organisation_id, mrn)
);
COMMENT ON TABLE patient.patient IS 'class=C2; merge root; status and merged_into change only through complete_merge (BE-09)';
CREATE INDEX patient_match_name_dob_idx ON patient.patient (organisation_id, lower(family_name), date_of_birth);
CREATE INDEX patient_phone_idx ON patient.patient (organisation_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX patient_email_idx ON patient.patient (organisation_id, email) WHERE email IS NOT NULL;
CREATE INDEX patient_merged_into_idx ON patient.patient (merged_into) WHERE merged_into IS NOT NULL;

CREATE TABLE patient.patient_contact (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  patient_id      uuid        NOT NULL REFERENCES patient.patient (id),
  kind            text        NOT NULL CHECK (kind IN ('emergency', 'next_of_kin')),
  name            text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  relationship    text        CHECK (relationship IS NULL OR char_length(relationship) <= 100),
  phone           text        CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  email           text        CHECK (email IS NULL OR (char_length(email) BETWEEN 3 AND 320 AND email = lower(email))),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz
);
COMMENT ON TABLE patient.patient_contact IS 'class=C2; merge participant R';
CREATE INDEX patient_contact_patient_idx ON patient.patient_contact (patient_id);

CREATE TABLE patient.insurance_coverage (
  id                 uuid        PRIMARY KEY,
  organisation_id    uuid        NOT NULL,
  patient_id         uuid        NOT NULL REFERENCES patient.patient (id),
  payer_name         text        NOT NULL CHECK (char_length(btrim(payer_name)) BETWEEN 1 AND 200),
  member_id          text        NOT NULL CHECK (char_length(btrim(member_id)) BETWEEN 1 AND 100),
  group_number       text        CHECK (group_number IS NULL OR char_length(group_number) <= 100),
  front_document_id  uuid,
  back_document_id   uuid,
  eligibility_status text        NOT NULL DEFAULT 'unknown'
                       CHECK (eligibility_status IN ('unknown', 'verified_active', 'verified_inactive', 'unable_to_verify')),
  verified_at        timestamptz,
  verified_by        uuid,
  active             boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  created_by_job     uuid,
  row_version        bigint      NOT NULL DEFAULT 1,
  updated_at         timestamptz,
  -- RA-R1-29: a verification result names who verified and when; an unknown status names neither.
  CONSTRAINT insurance_verification_shape CHECK (
    (eligibility_status = 'unknown' AND verified_at IS NULL AND verified_by IS NULL)
    OR (eligibility_status <> 'unknown' AND verified_at IS NOT NULL AND verified_by IS NOT NULL))
);
COMMENT ON TABLE patient.insurance_coverage IS 'class=C2; merge participant R';
CREATE INDEX insurance_coverage_patient_idx ON patient.insurance_coverage (patient_id);

CREATE TABLE patient.consent (
  id                     uuid        PRIMARY KEY,
  organisation_id        uuid        NOT NULL,
  patient_id             uuid        NOT NULL REFERENCES patient.patient (id),
  template_key           text        NOT NULL CHECK (char_length(template_key) BETWEEN 1 AND 100),
  template_version       integer     NOT NULL CHECK (template_version >= 1),
  status                 text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'superseded', 'withdrawn')),
  signed_at              timestamptz,
  signer_principal_id    uuid,
  signer_relationship    text        CHECK (signer_relationship IS NULL OR signer_relationship IN ('self', 'proxy', 'staff_witnessed')),
  signed_name            text        CHECK (signed_name IS NULL OR char_length(btrim(signed_name)) BETWEEN 1 AND 200),
  signature_document_id  uuid,
  withdrawn_at           timestamptz,
  reason                 text        CHECK (reason IS NULL OR char_length(reason) <= 500),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  created_by_job         uuid,
  row_version            bigint      NOT NULL DEFAULT 1,
  updated_at             timestamptz,
  CONSTRAINT consent_signed_shape CHECK (
    (status = 'pending' AND signed_at IS NULL AND withdrawn_at IS NULL)
    OR (status IN ('signed', 'superseded') AND signed_at IS NOT NULL AND signer_principal_id IS NOT NULL
        AND signer_relationship IS NOT NULL AND signed_name IS NOT NULL AND withdrawn_at IS NULL)
    OR (status = 'withdrawn' AND withdrawn_at IS NOT NULL))
);
COMMENT ON TABLE patient.consent IS 'class=C2; merge participant R/K (pending and signed R; superseded and withdrawn K)';
CREATE INDEX consent_patient_template_idx ON patient.consent (patient_id, template_key, status);
-- 22.6 draft 6: signing a new version supersedes the old one in the same transaction.
CREATE UNIQUE INDEX consent_one_signed_uq ON patient.consent (patient_id, template_key) WHERE status = 'signed';
-- One open request per template and version: asking twice returns the same pending row.
CREATE UNIQUE INDEX consent_one_pending_uq ON patient.consent (patient_id, template_key, template_version) WHERE status = 'pending';

CREATE TABLE patient.communication_preference (
  patient_id       uuid        PRIMARY KEY REFERENCES patient.patient (id),
  organisation_id  uuid        NOT NULL,
  channels         text[]      NOT NULL CHECK (channels <@ ARRAY['email', 'sms', 'push', 'in_app']::text[] AND cardinality(channels) BETWEEN 0 AND 4),
  reminder_channel text        CHECK (reminder_channel IS NULL OR reminder_channel IN ('email', 'sms', 'push', 'in_app')),
  language         text        NOT NULL CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$'),
  quiet_hours      jsonb       CHECK (quiet_hours IS NULL OR (jsonb_typeof(quiet_hours) = 'object' AND pg_column_size(quiet_hours) <= 512)),
  -- 22.6: always false for PHI channels. There is no marketing channel in R1; the column exists for the consent record only.
  marketing_opt_in boolean     NOT NULL DEFAULT false CHECK (marketing_opt_in = false),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  created_by_job   uuid,
  row_version      bigint      NOT NULL DEFAULT 1,
  updated_at       timestamptz,
  CONSTRAINT communication_preference_reminder_in_channels CHECK (reminder_channel IS NULL OR reminder_channel = ANY (channels))
);
COMMENT ON TABLE patient.communication_preference IS 'class=C2; merge participant R (survivor row wins, 22.16)';

CREATE TABLE patient.care_relationship (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  patient_id      uuid        NOT NULL REFERENCES patient.patient (id),
  location_id     uuid        NOT NULL REFERENCES organisation.location (id),
  reason          text        NOT NULL CHECK (reason IN ('registration', 'booking', 'referral', 'attach', 'merge')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  ended_reason    text        CHECK (ended_reason IS NULL OR char_length(ended_reason) <= 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  CONSTRAINT care_relationship_end_shape CHECK ((ended_at IS NULL) = (ended_reason IS NULL)),
  CONSTRAINT care_relationship_order CHECK (ended_at IS NULL OR ended_at >= started_at)
);
COMMENT ON TABLE patient.care_relationship IS 'class=C2; written only by patient_scope_owner functions; handled by complete_merge';
CREATE UNIQUE INDEX care_relationship_open_uq ON patient.care_relationship (patient_id, location_id) WHERE ended_at IS NULL;
CREATE INDEX care_relationship_location_idx ON patient.care_relationship (location_id);

-- Derived (SHARED-BOUNDARIES 6.6 scope invariant). Written only by patient_scope_owner functions.
CREATE TABLE patient.staff_scope (
  patient_id      uuid NOT NULL,
  location_id     uuid NOT NULL,
  organisation_id uuid NOT NULL,
  PRIMARY KEY (patient_id, location_id)
);
COMMENT ON TABLE patient.staff_scope IS 'class=C1 by itself, PHI-adjacent; derived, definer-written, exempt from the merge guard';
CREATE INDEX staff_scope_location_idx ON patient.staff_scope (location_id, patient_id);

CREATE TABLE patient.care_team_member (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  patient_id      uuid        NOT NULL REFERENCES patient.patient (id),
  principal_id    uuid        NOT NULL,
  role            text        NOT NULL CHECK (role IN ('primary_clinician', 'clinician', 'nurse', 'coordinator')),
  from_date       date        NOT NULL DEFAULT current_date,
  to_date         date,
  end_reason      text        CHECK (end_reason IN ('staff', 'merged_duplicate')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  CONSTRAINT care_team_end_shape CHECK ((to_date IS NULL) = (end_reason IS NULL)),
  CONSTRAINT care_team_order CHECK (to_date IS NULL OR to_date >= from_date)
);
COMMENT ON TABLE patient.care_team_member IS 'class=C2; merge participant R/K (active R; ended K)';
CREATE UNIQUE INDEX care_team_open_uq ON patient.care_team_member (patient_id, principal_id, role) WHERE to_date IS NULL;
CREATE INDEX care_team_principal_idx ON patient.care_team_member (principal_id) WHERE to_date IS NULL;

CREATE TABLE patient.duplicate_flag (
  id                   uuid        PRIMARY KEY,
  organisation_id      uuid        NOT NULL,
  patient_id           uuid        NOT NULL REFERENCES patient.patient (id),
  candidate_patient_id uuid        NOT NULL REFERENCES patient.patient (id),
  strength             text        NOT NULL CHECK (strength IN ('exact', 'probable')),
  source               text        NOT NULL CHECK (source IN ('self_registration', 'front_desk')),
  status               text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'not_duplicate', 'merge_requested', 'resolved')),
  resolved_by          uuid,
  resolved_reason      text        CHECK (resolved_reason IN ('staff', 'merged', 'merged_duplicate')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  created_by_job       uuid,
  row_version          bigint      NOT NULL DEFAULT 1,
  updated_at           timestamptz,
  CONSTRAINT duplicate_flag_distinct CHECK (patient_id <> candidate_patient_id),
  CONSTRAINT duplicate_flag_resolution_shape CHECK (
    (status IN ('open', 'merge_requested') AND resolved_reason IS NULL)
    OR (status IN ('not_duplicate', 'resolved') AND resolved_reason IS NOT NULL))
);
COMMENT ON TABLE patient.duplicate_flag IS 'class=C2; merge participant R/K (open and merge_requested R)';
CREATE INDEX duplicate_flag_status_idx ON patient.duplicate_flag (status, created_at);
CREATE INDEX duplicate_flag_patient_idx ON patient.duplicate_flag (patient_id);
CREATE INDEX duplicate_flag_candidate_idx ON patient.duplicate_flag (candidate_patient_id);
-- One open flag per pair, whichever way round it was raised.
CREATE UNIQUE INDEX duplicate_flag_open_pair_uq ON patient.duplicate_flag
  (least(patient_id, candidate_patient_id), greatest(patient_id, candidate_patient_id)) WHERE status IN ('open', 'merge_requested');

-- The merge map (SHARED-BOUNDARIES 9.2). BE-09 owns the writer (complete_merge); this ticket reads it for closure(S).
CREATE TABLE patient.patient_merge (
  merged_id           uuid        PRIMARY KEY REFERENCES patient.patient (id),
  organisation_id     uuid        NOT NULL,
  direct_survivor_id  uuid        NOT NULL REFERENCES patient.patient (id),
  final_survivor_id   uuid        NOT NULL REFERENCES patient.patient (id),
  merge_request_id    uuid        NOT NULL,
  merged_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_merge_not_self CHECK (merged_id <> direct_survivor_id AND merged_id <> final_survivor_id)
);
COMMENT ON TABLE patient.patient_merge IS 'class=C2; definer-written by complete_merge (BE-09); exempt from the merge guard';
CREATE INDEX patient_merge_final_idx ON patient.patient_merge (final_survivor_id);

-- 25.3: the proof that a registration was preceded by a match. Created by patient.match_candidates (patient_match_owner),
-- marked used by register and attach (patient_scope_owner). Never holds the searched values: only a keyed hash.
CREATE TABLE patient.match_check (
  id                    uuid        PRIMARY KEY,
  organisation_id       uuid        NOT NULL,
  principal_id          uuid        NOT NULL,
  location_id           uuid        REFERENCES organisation.location (id),
  values_hash           bytea       NOT NULL CHECK (octet_length(values_hash) = 32),
  candidate_refs        uuid[]      NOT NULL CHECK (cardinality(candidate_refs) <= 5),
  candidate_patient_ids uuid[]      NOT NULL,
  candidate_strengths   text[]      NOT NULL,
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_check_arrays CHECK (
    cardinality(candidate_refs) = cardinality(candidate_patient_ids)
    AND cardinality(candidate_refs) = cardinality(candidate_strengths)
    AND candidate_strengths <@ ARRAY['exact', 'probable']::text[])
);
COMMENT ON TABLE patient.match_check IS 'class=C2 (candidate ids point at patients); expires in 15 minutes; no patient_id column, so no merge handling';
CREATE INDEX match_check_expires_idx ON patient.match_check (expires_at);
