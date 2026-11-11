-- migration-class: expand
-- The constraints of the tombstone (HEAAA-880 D-880-3), added NOT VALID and validated in 2606: a purged row holds no personal data (and has
-- purged_at); every other row holds the five required values again, so dropping NOT NULL in 2603 weakens nothing for live patients.
--
-- Down-note (forward-only): drop both constraints.

ALTER TABLE patient.patient ADD CONSTRAINT patient_status_check CHECK (status IN ('active', 'merged', 'purged')) NOT VALID;
ALTER TABLE patient.patient ADD CONSTRAINT patient_purged_shape CHECK (
  (status = 'purged') = (num_nonnulls(purged_at) = 1)
  AND (status = 'purged' OR num_nonnulls(given_name, family_name, date_of_birth, state_code, preferred_language) = 5)
  AND (status <> 'purged' OR num_nonnulls(given_name, family_name, middle_name, date_of_birth, sex_at_birth, gender_identity, phone_e164, email,
                                          address, state_code, preferred_language, photo_document_id, preferred_pharmacy, merged_into) = 0)) NOT VALID;
