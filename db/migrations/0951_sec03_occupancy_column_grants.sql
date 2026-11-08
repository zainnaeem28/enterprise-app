-- migration-class: expand
-- SEC-03 finding F09 (docs/security/SEC-03-rls-assessment.md, section 5; ticket HEAAA-181). SHARED-BOUNDARIES 6.5: the occupancy twin
-- carries no patient identifier. 0902 granted SELECT on the whole table, so every patient and staff session of the organisation could
-- read `created_by` (the booking principal) and `session_key` and `created_by_job` of every row, and correlate who booked which slot.
-- The table grant is replaced by a column grant: the columns of the twin, plus `row_version` (the reservation read in
-- scheduling/core/service.ts adds the two row versions into the ETag). The policies are unchanged (row scope), the owner role
-- scheduling_booking_owner keeps its own grants (it writes `created_by`), and only the two application roles lose the three columns.
REVOKE SELECT ON scheduling.slot_occupancy FROM app_api, app_worker;
GRANT SELECT (id, organisation_id, location_id, clinician_principal_id, room_id, period, status, expires_at, overbook, row_version)
  ON scheduling.slot_occupancy TO app_api, app_worker;

-- The twin check at commit (0901, check_twin) is an invoker trigger: it ran as the booking role and read `created_by` and used
-- SELECT *, so the column grant above would refuse every reservation insert. It becomes a SECURITY DEFINER function of
-- scheduling_booking_owner (the owner of the twin's other writers, which keeps table-level SELECT on the occupancy table and its
-- own policy), exactly as 0904 did for guard_open_patient_at_commit. Same body; the search_path stays pg_catalog.
CREATE OR REPLACE FUNCTION scheduling.check_twin() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  o scheduling.slot_occupancy%ROWTYPE;
BEGIN
  SELECT * INTO o FROM scheduling.slot_occupancy WHERE id = NEW.id;
  IF NOT FOUND OR o.organisation_id <> NEW.organisation_id OR o.location_id <> NEW.location_id
     OR o.clinician_principal_id <> NEW.clinician_principal_id
     OR (o.created_by IS NOT NULL AND o.created_by IS DISTINCT FROM NEW.booked_by_principal_id) THEN
    RAISE EXCEPTION 'a reservation and its occupancy row must agree' USING ERRCODE = 'PS001';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION scheduling.check_twin() FROM PUBLIC;
GRANT CREATE ON SCHEMA scheduling TO scheduling_booking_owner; -- the ownership transfer needs it (21.2 point 1); withdrawn at once
ALTER FUNCTION scheduling.check_twin() OWNER TO scheduling_booking_owner;
REVOKE CREATE ON SCHEMA scheduling FROM scheduling_booking_owner;
