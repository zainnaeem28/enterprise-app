-- migration-class: expand
-- Triggers of the booking tables (ARCHITECTURE 21.5, 23.1, 25.1; SHARED-BOUNDARIES 6.5, 9.2; ticket BE-11).
-- Invoker rights, search_path pinned to pg_catalog, schema-qualified names only. SQLSTATE PS001: illegal state transition or
-- a write to a kept (K) row; PS002 is the business refusal of 30 (its DETAIL carries the reason code).

CREATE TRIGGER slot_occupancy_bump_row_version BEFORE UPDATE ON scheduling.slot_occupancy FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER slot_reservation_bump_row_version BEFORE UPDATE ON scheduling.slot_reservation FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- The merge write guard (SBR-12, 9.2) on the only table of this module with a patient_id. patient.guard_open_patient is owned by
-- patient_scope_owner with EXECUTE revoked from PUBLIC, and app_owner (which runs this migration) holds no EXECUTE on it, so it
-- cannot be attached from here (DEVIATION D1, README; request to the Orchestrator: GRANT EXECUTE ON FUNCTION
-- patient.guard_open_patient() TO app_owner, then this function and its trigger are replaced by the one-line original). Until then
-- this is the same refusal under the same name (the M-5 check looks for the name): the caller's context is checked first, the root
-- is read by the function-owner role (a proxy cannot read the root under its own RLS), a merged patient is PM001, an unknown one PM008.
-- It takes no lock of its own: the booking transaction already holds the root lock from patient.lock_patients (25.2 rule 1), and the
-- foreign key to patient.patient takes FOR KEY SHARE as well, so a merge that is running makes this write wait and then refuse it.
CREATE FUNCTION scheduling.guard_open_patient() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.patient_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF (SELECT kernel.setting('app.audience')) IS NULL
     OR (SELECT kernel.setting('app.audience')) NOT IN ('patient', 'staff', 'system')
     OR (SELECT kernel.uuid1('app.org_id')) IS DISTINCT FROM NEW.organisation_id THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  SELECT p.status INTO v_status FROM patient.patient p WHERE p.id = NEW.patient_id AND p.organisation_id = NEW.organisation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  IF v_status = 'merged' THEN
    RAISE EXCEPTION 'patient.merged' USING ERRCODE = 'PM001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.guard_open_patient() FROM PUBLIC;
CREATE TRIGGER slot_reservation_guard_open BEFORE INSERT OR UPDATE ON scheduling.slot_reservation FOR EACH ROW EXECUTE FUNCTION scheduling.guard_open_patient();

-- ST-01 on slot_occupancy.status (23.1). A transition not in the table is refused with PS001. The columns that define the slot
-- never change (a different doctor, room or time is a new reservation); the hold expiry is cleared when the hold ends.
CREATE FUNCTION scheduling.guard_occupancy() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.clinician_principal_id IS DISTINCT FROM OLD.clinician_principal_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.period IS DISTINCT FROM OLD.period
     OR NEW.overbook IS DISTINCT FROM OLD.overbook OR NEW.session_key IS DISTINCT FROM OLD.session_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an occupancy keeps its slot' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    -- No status change: only the bookkeeping columns may differ, and a hold's expiry never moves.
    IF NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'a hold''s expiry does not change' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status, NEW.status) IN (
        ('held', 'confirmed'), ('held', 'expired'), ('held', 'cancelled_patient'),
        ('confirmed', 'checked_in'), ('confirmed', 'rescheduled'), ('confirmed', 'cancelled_patient'),
        ('confirmed', 'cancelled_clinic'), ('confirmed', 'no_show'),
        ('checked_in', 'in_consultation'), ('checked_in', 'no_show'),
        ('in_consultation', 'completed'))) THEN
    RAISE EXCEPTION 'illegal appointment transition' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.guard_occupancy() FROM PUBLIC;
CREATE TRIGGER slot_occupancy_guard BEFORE UPDATE ON scheduling.slot_occupancy FOR EACH ROW EXECUTE FUNCTION scheduling.guard_occupancy();

-- kernel.refuse_update_when_parent_terminal(slot_occupancy, K states) (21.5, 22.8, 22.16): a reservation accepts no update once
-- its occupancy is in a K state (every status except held, confirmed and checked_in). Cancel therefore writes the reservation's
-- cancel_reason and late_change FIRST and sets the occupancy status second (25.1, N-2). The merge participant re-points a
-- reservation only while it is R. The kernel function does not exist yet; this is the module-local equivalent.
CREATE FUNCTION scheduling.refuse_update_when_parent_terminal() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_status text;
BEGIN
  SELECT o.status INTO v_status FROM scheduling.slot_occupancy o WHERE o.id = OLD.id;
  IF v_status IS NULL OR v_status NOT IN ('held', 'confirmed', 'checked_in') THEN
    RAISE EXCEPTION 'a reservation of a finished appointment accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.service_id IS DISTINCT FROM OLD.service_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.clinician_principal_id IS DISTINCT FROM OLD.clinician_principal_id OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.booked_by_principal_id IS DISTINCT FROM OLD.booked_by_principal_id OR NEW.booked_via IS DISTINCT FROM OLD.booked_via
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a reservation keeps its service, place, clinician and origin' USING ERRCODE = 'PS001';
  END IF;
  -- Write once: the link to the appointment it replaces, and the cancellation record.
  IF OLD.rescheduled_from_id IS NOT NULL AND NEW.rescheduled_from_id IS DISTINCT FROM OLD.rescheduled_from_id THEN
    RAISE EXCEPTION 'a reservation keeps the link to the appointment it replaces' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.cancel_reason IS NOT NULL AND NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason THEN
    RAISE EXCEPTION 'a cancellation reason is recorded once' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.late_change IS NOT NULL AND NEW.late_change IS DISTINCT FROM OLD.late_change THEN
    RAISE EXCEPTION 'a late-change flag is recorded once' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.refuse_update_when_parent_terminal() FROM PUBLIC;
CREATE TRIGGER slot_reservation_parent_terminal BEFORE UPDATE ON scheduling.slot_reservation FOR EACH ROW EXECUTE FUNCTION scheduling.refuse_update_when_parent_terminal();

-- The twin, at commit (O-3): the reservation's occupancy row exists, belongs to the same organisation, place and clinician, and
-- was created by the principal who booked (a system job, the waitlist offer, has no principal of its own: its occupancy row has none). Together with the two deferred foreign keys this means no reservation can point at
-- somebody else's occupancy row and no occupancy row can be left without its reservation.
CREATE FUNCTION scheduling.check_twin() RETURNS trigger
  LANGUAGE plpgsql
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
CREATE CONSTRAINT TRIGGER slot_reservation_twin AFTER INSERT ON scheduling.slot_reservation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION scheduling.check_twin();
