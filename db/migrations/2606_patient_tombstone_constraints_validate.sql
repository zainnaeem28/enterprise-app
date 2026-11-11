-- migration-class: expand
-- Validates the two constraints that 2605 added NOT VALID (DEVOPS-PLAN 5.2: the steps are separate migrations). Every existing row is active or
-- merged with its required columns set, so validation passes.
--
-- Down-note (forward-only): none needed; dropping the constraints is the down path of 2605.

ALTER TABLE patient.patient VALIDATE CONSTRAINT patient_status_check;
ALTER TABLE patient.patient VALIDATE CONSTRAINT patient_purged_shape;
