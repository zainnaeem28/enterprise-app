-- migration-class: expand
-- SEC-03 findings F02..F05 (docs/security/SEC-03-rls-assessment.md, section 5; ticket HEAAA-178). SHARED-BOUNDARIES 6.2 rule 3:
-- a definer function checks the caller's scope itself.
--
-- Why triggers and not new function bodies: 0903 and 0703 are applied migrations, and a function owned by a function-owner role can
-- be neither replaced nor dropped by app_owner (the runner refuses SET ROLE, and app_owner holds the owner roles with INHERIT FALSE).
-- The tables belong to app_owner, so the rules are attached to the tables as invoker triggers. They run as the role that writes
-- (scheduling_booking_owner, patient_scope_owner) whichever route reaches the write, so calling the definer function directly
-- is bound too. The definer functions themselves are unchanged.
--
--   F02  scheduling.set_status         BEFORE UPDATE on slot_occupancy: the reservation must be visible to the caller's scope.
--   F03  scheduling.occupy             BEFORE INSERT on slot_occupancy: an overbook row needs a stored policy cap with room left.
--   F04  patient.ensure_care_relationship  BEFORE INSERT on care_relationship: booking needs a confirmed reservation; referral is staff.
--   F05  scheduling.guard_open_patient     deferred re-check of the merge guard at commit (the lock is requested, see README).

-- F02: what the function-owner role may read of a reservation, and only inside the caller's scope. ---------------------------------
-- The policy repeats the caller's own predicates (T-PAT-APPT, the staff location, T-SYS) so that "the caller's reservation" is decided
-- by the database and not by the API's earlier read. Four columns, no clinical text.
GRANT SELECT (id, organisation_id, patient_id, location_id) ON scheduling.slot_reservation TO scheduling_booking_owner;
CREATE POLICY reservation_owner_caller_select ON scheduling.slot_reservation
  FOR SELECT TO scheduling_booking_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (   ((SELECT kernel.setting('app.audience')) = 'patient' AND patient_id = ANY (kernel.uuids('app.patient_ids')))
          OR ((SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
              AND location_id = ANY (kernel.uuids('app.location_ids')))
          OR ((SELECT kernel.setting('app.audience')) = 'system'
              AND ((SELECT kernel.setting('app.job_scope')) = 'org'
                   OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))))));

CREATE FUNCTION scheduling.guard_occupancy_caller() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  -- The one move on somebody else's row that is allowed: occupy() and the sweep expire a hold whose time has run out (SAR-09).
  IF OLD.status = 'held' AND NEW.status = 'expired' AND OLD.expires_at < now() THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM scheduling.slot_reservation r WHERE r.id = OLD.id) THEN
    RAISE EXCEPTION 'occupancy not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.guard_occupancy_caller() FROM PUBLIC;
CREATE TRIGGER slot_occupancy_caller_guard BEFORE UPDATE ON scheduling.slot_occupancy FOR EACH ROW EXECUTE FUNCTION scheduling.guard_occupancy_caller();

-- F03: the overbook flag, the session key and the cap are arguments of the caller, and the function never asks whether overbooking
-- is allowed at all. Until BE-12 stores the overbookable flag with the template and occupy reads it from there (it then replaces
-- this function), the stored booking policy bounds every overbook row: some policy in force at the location (its own or the
-- all-locations one) must allow overbooking, and the overbook rows already overlapping the doctor's period must be fewer than the
-- largest stored cap. The count does not depend on the session key, so an invented key opens nothing. occupy() holds the doctor's
-- advisory lock when this runs.
GRANT USAGE ON SCHEMA organisation TO scheduling_booking_owner;
GRANT SELECT (organisation_id, location_id, overbook_cap_per_session) ON organisation.booking_policy TO scheduling_booking_owner;
CREATE POLICY booking_policy_booking_owner_read ON organisation.booking_policy
  FOR SELECT TO scheduling_booking_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff', 'system'));

CREATE FUNCTION scheduling.guard_overbook_origin() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_cap   integer;
  v_taken integer;
BEGIN
  IF NOT NEW.overbook THEN
    RETURN NEW;
  END IF;
  SELECT max(p.overbook_cap_per_session) INTO v_cap FROM organisation.booking_policy p
   WHERE p.organisation_id = NEW.organisation_id AND (p.location_id IS NULL OR p.location_id = NEW.location_id);
  IF coalesce(v_cap, 0) <= 0 THEN
    RAISE EXCEPTION 'overbooking is not allowed here' USING ERRCODE = '23P01';
  END IF;
  SELECT count(*) INTO v_taken FROM scheduling.slot_occupancy o
   WHERE o.organisation_id = NEW.organisation_id AND o.clinician_principal_id = NEW.clinician_principal_id AND o.overbook
     AND o.period && NEW.period AND o.status IN ('held', 'confirmed', 'checked_in', 'in_consultation', 'completed');
  IF v_taken >= v_cap THEN
    RAISE EXCEPTION 'the overbook capacity is used' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.guard_overbook_origin() FROM PUBLIC;
CREATE TRIGGER slot_occupancy_overbook_guard BEFORE INSERT ON scheduling.slot_occupancy FOR EACH ROW EXECUTE FUNCTION scheduling.guard_overbook_origin();

-- F04: a care relationship starts from a real event (6.6). patient_scope_owner reads the three facts it needs, inside the
-- organisation of the caller, for the audiences that can book.
GRANT USAGE ON SCHEMA scheduling TO patient_scope_owner;
GRANT SELECT (id, organisation_id, patient_id, location_id) ON scheduling.slot_reservation TO patient_scope_owner;
GRANT SELECT (id, status) ON scheduling.slot_occupancy TO patient_scope_owner;
CREATE POLICY reservation_scope_owner_select ON scheduling.slot_reservation
  FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff'));
CREATE POLICY occupancy_scope_owner_select ON scheduling.slot_occupancy
  FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('patient', 'staff'));

CREATE FUNCTION patient.guard_care_relationship_origin() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.reason = 'referral' AND kernel.setting('app.audience') IS DISTINCT FROM 'staff' THEN
    RAISE EXCEPTION 'a referral is accepted by staff' USING ERRCODE = '42501';
  END IF;
  IF NEW.reason = 'booking' AND NOT EXISTS (
       SELECT 1 FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
        WHERE r.patient_id = NEW.patient_id AND r.location_id = NEW.location_id AND r.organisation_id = NEW.organisation_id
          AND o.status IN ('confirmed', 'checked_in', 'in_consultation', 'completed')) THEN
    RAISE EXCEPTION 'no confirmed appointment of this patient at this location' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION patient.guard_care_relationship_origin() FROM PUBLIC;
CREATE TRIGGER care_relationship_origin_guard BEFORE INSERT ON patient.care_relationship FOR EACH ROW EXECUTE FUNCTION patient.guard_care_relationship_origin();

-- F05: the merge write guard on a reservation. The BEFORE trigger of 0901 reads the root's status with a plain SELECT, so a writer
-- that never took patient.lock_patients can read 'active' just before a merge commits and then wait on the foreign key. This
-- AFTER trigger repeats the read at commit, with a new snapshot: the writer's foreign key holds FOR KEY SHARE on the root until
-- then, so a merge cannot start after the writer's check, and a merge that committed before it is seen here and refused with PM001.
-- The preferred form (GRANT EXECUTE ON FUNCTION patient.guard_open_patient() TO app_owner, then the original trigger) needs a
-- grant that only the administrator can make; it is requested in README.
CREATE FUNCTION scheduling.guard_open_patient_at_commit() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.patient_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT p.status INTO v_status FROM patient.patient p WHERE p.id = NEW.patient_id AND p.organisation_id = NEW.organisation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  IF v_status = 'merged' THEN
    RAISE EXCEPTION 'patient.merged' USING ERRCODE = 'PM001';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION scheduling.guard_open_patient_at_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER slot_reservation_guard_open_commit AFTER INSERT OR UPDATE OF patient_id ON scheduling.slot_reservation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION scheduling.guard_open_patient_at_commit();

GRANT CREATE ON SCHEMA scheduling TO scheduling_booking_owner;
ALTER FUNCTION scheduling.guard_open_patient_at_commit() OWNER TO scheduling_booking_owner;
REVOKE CREATE ON SCHEMA scheduling FROM scheduling_booking_owner;
