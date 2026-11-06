-- migration-class: expand
-- Triggers of the flow tables (ARCHITECTURE 21.5, 22.8, 22.16, 23.1 ST-06; SHARED-BOUNDARIES 9.2; ticket BE-13).
-- Invoker rights, search_path pinned to pg_catalog, schema-qualified names only, except scheduling.flow_guard_open_patient (below).
-- SQLSTATE PS001: illegal state transition or a write to a kept (K) row.
--
-- The database, not the route, decides which moves a queue entry, a waitlist entry and an offer may make, and that a K row is never
-- written again (so a row left on a merged ID can never be the target of a later write, 22.16).

CREATE TRIGGER check_in_bump_row_version BEFORE UPDATE ON scheduling.check_in FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER queue_entry_bump_row_version BEFORE UPDATE ON scheduling.queue_entry FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER waitlist_entry_bump_row_version BEFORE UPDATE ON scheduling.waitlist_entry FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER waitlist_offer_bump_row_version BEFORE UPDATE ON scheduling.waitlist_offer FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- The merge write guard (SBR-12, 9.2) on the four tables with a patient_id. Same refusal as patient.guard_open_patient and
-- documents.guard_open_patient (a copy: that function is owned by patient_scope_owner with EXECUTE revoked from PUBLIC, so the
-- migration role cannot attach it; BE-11 departure D1). It is moved to patient_scope_owner at the end of this file, so it reads
-- the root whatever the caller's scope is, and it takes FOR KEY SHARE, which conflicts with the merge's FOR UPDATE on the root.
CREATE FUNCTION scheduling.flow_guard_open_patient() RETURNS trigger
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
  SELECT p.status INTO v_status FROM patient.patient p WHERE p.id = NEW.patient_id AND p.organisation_id = NEW.organisation_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  IF v_status = 'merged' THEN
    RAISE EXCEPTION 'patient.merged' USING ERRCODE = 'PM001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.flow_guard_open_patient() FROM PUBLIC;
CREATE TRIGGER check_in_guard_open BEFORE INSERT OR UPDATE ON scheduling.check_in FOR EACH ROW EXECUTE FUNCTION scheduling.flow_guard_open_patient();
CREATE TRIGGER queue_entry_guard_open BEFORE INSERT OR UPDATE ON scheduling.queue_entry FOR EACH ROW EXECUTE FUNCTION scheduling.flow_guard_open_patient();
CREATE TRIGGER waitlist_entry_guard_open BEFORE INSERT OR UPDATE ON scheduling.waitlist_entry FOR EACH ROW EXECUTE FUNCTION scheduling.flow_guard_open_patient();
CREATE TRIGGER waitlist_offer_guard_open BEFORE INSERT OR UPDATE ON scheduling.waitlist_offer FOR EACH ROW EXECUTE FUNCTION scheduling.flow_guard_open_patient();

-- A check-in and a queue entry belong to a reservation: the same organisation, patient and place, and the appointment is checked in
-- (set_status confirmed -> checked_in comes first, in the same transaction). A check-in of somebody else's reservation, or of one that
-- is not checked in, cannot be written by any role.
CREATE FUNCTION scheduling.flow_check_reservation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  r scheduling.slot_reservation%ROWTYPE;
  v_status text;
BEGIN
  SELECT * INTO r FROM scheduling.slot_reservation WHERE id = NEW.id;
  IF NOT FOUND OR r.organisation_id <> NEW.organisation_id OR r.patient_id <> NEW.patient_id OR r.location_id <> NEW.location_id THEN
    RAISE EXCEPTION 'a check-in belongs to its reservation' USING ERRCODE = 'PS001';
  END IF;
  SELECT o.status INTO v_status FROM scheduling.slot_occupancy o WHERE o.id = NEW.id;
  IF v_status IS DISTINCT FROM 'checked_in' THEN
    RAISE EXCEPTION 'the appointment is not checked in' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.flow_check_reservation() FROM PUBLIC;
CREATE TRIGGER check_in_reservation BEFORE INSERT ON scheduling.check_in FOR EACH ROW EXECUTE FUNCTION scheduling.flow_check_reservation();
CREATE TRIGGER queue_entry_reservation BEFORE INSERT ON scheduling.queue_entry FOR EACH ROW EXECUTE FUNCTION scheduling.flow_check_reservation();

-- check_in: kernel.refuse_update_when_parent_terminal(slot_occupancy, K states) (22.8): no update once the occupancy has left
-- `checked_in`. The merge participant re-points it only while it is R. What a check-in is never changes.
CREATE FUNCTION scheduling.flow_guard_check_in() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_status text;
BEGIN
  SELECT o.status INTO v_status FROM scheduling.slot_occupancy o WHERE o.id = OLD.id;
  IF v_status IS DISTINCT FROM 'checked_in' THEN
    RAISE EXCEPTION 'a check-in of a finished visit accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.checked_in_at IS DISTINCT FROM OLD.checked_in_at OR NEW.by_principal_id IS DISTINCT FROM OLD.by_principal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a check-in keeps its place, method and time' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.flow_guard_check_in() FROM PUBLIC;
CREATE TRIGGER check_in_guard BEFORE UPDATE ON scheduling.check_in FOR EACH ROW EXECUTE FUNCTION scheduling.flow_guard_check_in();

-- queue_entry: refuse_update_when_terminal('done') (22.8). `done` is K. The stage clock moves with the stage.
CREATE FUNCTION scheduling.flow_guard_queue_entry() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.stage = 'done' THEN
    RAISE EXCEPTION 'a finished queue entry accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.entered_at IS DISTINCT FROM OLD.entered_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a queue entry keeps its place and arrival time' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    NEW.stage_changed_at := now();
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.flow_guard_queue_entry() FROM PUBLIC;
CREATE TRIGGER queue_entry_guard BEFORE UPDATE ON scheduling.queue_entry FOR EACH ROW EXECUTE FUNCTION scheduling.flow_guard_queue_entry();

-- waitlist_entry (ST-06 neighbours, 22.8): active -> offered | cancelled | expired; offered -> fulfilled | active | expired.
-- fulfilled, cancelled and expired are K. An offered entry is never cancelled directly: the offer is declined first (it returns to
-- active), so no offer is left open on a cancelled entry. What an entry asks for (service, place, doctor, window, queue position)
-- never changes: a different wish is a new entry at the back of the line.
CREATE FUNCTION scheduling.flow_guard_waitlist_entry() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status IN ('fulfilled', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'a finished waitlist entry accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.service_id IS DISTINCT FROM OLD.service_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.clinician_principal_id IS DISTINCT FROM OLD.clinician_principal_id OR NEW."window" IS DISTINCT FROM OLD."window"
     OR NEW.position_at IS DISTINCT FROM OLD.position_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a waitlist entry keeps what it asks for and its place in line' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status, NEW.status) IN (
        ('active', 'offered'), ('active', 'cancelled'), ('active', 'expired'),
        ('offered', 'fulfilled'), ('offered', 'active'), ('offered', 'expired'))) THEN
    RAISE EXCEPTION 'illegal waitlist transition' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.flow_guard_waitlist_entry() FROM PUBLIC;
CREATE TRIGGER waitlist_entry_guard BEFORE UPDATE ON scheduling.waitlist_entry FOR EACH ROW EXECUTE FUNCTION scheduling.flow_guard_waitlist_entry();

-- waitlist_offer (ST-06): offered -> accepted | declined | expired, once. A decided offer is K.
CREATE FUNCTION scheduling.flow_guard_waitlist_offer() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status <> 'offered' THEN
    RAISE EXCEPTION 'a decided offer accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.waitlist_entry_id IS DISTINCT FROM OLD.waitlist_entry_id OR NEW.occupancy_id IS DISTINCT FROM OLD.occupancy_id
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an offer keeps its slot and its expiry' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('accepted', 'declined', 'expired') THEN
    RAISE EXCEPTION 'illegal offer transition' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.flow_guard_waitlist_offer() FROM PUBLIC;
CREATE TRIGGER waitlist_offer_guard BEFORE UPDATE ON scheduling.waitlist_offer FOR EACH ROW EXECUTE FUNCTION scheduling.flow_guard_waitlist_offer();

-- no_show_flag is insert-only: no update, no delete, whoever asks.
CREATE FUNCTION scheduling.flow_refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'this table is insert-only' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION scheduling.flow_refuse_change() FROM PUBLIC;
CREATE TRIGGER no_show_flag_insert_only BEFORE UPDATE OR DELETE ON scheduling.no_show_flag FOR EACH ROW EXECUTE FUNCTION scheduling.flow_refuse_change();

ALTER FUNCTION scheduling.flow_guard_open_patient() OWNER TO patient_scope_owner;
-- The CREATE right on the schema was needed only to move the ownership above (granted in 1300).
REVOKE CREATE ON SCHEMA scheduling FROM patient_scope_owner;
