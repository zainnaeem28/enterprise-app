-- migration-class: contract
-- contract-approval: HEAAA-880 decision log D-880-3 (Security Reviewer PASS; Solution Architect decision): the patient row may become a de-identified
-- tombstone, so its status check admits 'purged' and the five required personal columns may be NULL. 2605 adds the constraints that keep every
-- other row complete. This only RELAXES rules: the previous release never writes NULL there and never reads a purged row (none exists until the
-- retention job purges a patient, ten years after a deletion request at the earliest).
--
-- Down-note (forward-only): to go back, add the old status check and SET NOT NULL on the five columns once no row is purged.

ALTER TABLE patient.patient DROP CONSTRAINT patient_status_check;
