-- migration-class: expand
-- SEC05-F04 / INT04-F10 D-5 (decision HEAAA-432): replace the fail-closed stub `notifications.staff_scope_allows_patient`
-- (1201, `SELECT false`) with the T-STAFF predicate of ARCHITECTURE 21.4, in the same template text the patient policies
-- use (0702, 0902): realm `google` and (a `patient.staff_scope` row at one of the caller's locations, or the patient is in
-- the caller's break-the-glass list). One CREATE OR REPLACE, same signature, owner, volatility, search_path, ACL; no policy
-- change. The function stays SECURITY INVOKER, so `patient.staff_scope` is read under the caller's own row-level security.
-- The staff_alert policies keep their own audience and organisation conditions.

CREATE OR REPLACE FUNCTION notifications.staff_scope_allows_patient(patient uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = $1 AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR $1 = ANY (kernel.uuids('app.btg_patient_ids'))) $$;
