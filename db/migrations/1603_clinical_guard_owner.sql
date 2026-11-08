-- migration-class: expand
-- The merge write guard of the clinical chart tables runs as the function-owner role patient_scope_owner, like
-- patient.guard_open_patient (SHARED-BOUNDARIES 6.2, 9.2): it reads the root row of the patient whatever the caller's scope is, so a
-- stale session cannot hide a merged state from it. patient_scope_owner already reads patient.patient under its own policy (0702); it
-- needs no new right. The function is in the definer inventory of db/tools/catalog-lists.mjs through the requested patch of the
-- module (this ticket may not edit db/tools): see apps/api/src/modules/clinical/chart/catalog-lists.requested.patch.
ALTER FUNCTION clinical.guard_open_patient() OWNER TO patient_scope_owner;

-- The CREATE right on the schema was needed only to move the ownership above (granted in 1600).
REVOKE CREATE ON SCHEMA clinical FROM patient_scope_owner;
