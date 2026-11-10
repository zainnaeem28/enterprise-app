-- migration-class: expand
-- QA-EXEC-F11, decision HEAAA-632 D-F11-T1 (option A), product ruling D-F11-1: the overbook cap is the total number of active
-- bookings in one slot, the first included (TC-BK-15: cap 2 admits exactly 2). Before this migration the first booking was a normal
-- row that the cap never counted and the extras were counted per session day, so a slot admitted 1 + cap.
--
-- Now, in an overbookable window with a cap of 2 or more, every booking is an overbook row (availability/search.ts resolve) and its
-- session key names the slot. scheduling.occupy (0903, unchanged) counts the overbook rows of that key under the doctor's dr: lock and
-- refuses at the cap. This guard, which runs inside occupy under the same dr: and rm: locks and on every other insert, adds the rules
-- that must hold whatever the caller passes:
--   (a) an overbook row is refused when the active rows of the doctor that overlap its period (overbook or not, the first booking
--       included) have reached max(stored cap); a stored cap of 0 or 1 means no overbooking;
--   (b) a room held by another clinician is never shared when either row is an overbook row (the exclusion constraint ignores overbook
--       rows; normal with normal stays the constraint's);
--   (c) a normal row is refused while an overbook row of the same doctor overlaps it (for example after the cap was lowered to 1).
-- Why a trigger function and not a new occupy: occupy is owned by scheduling_booking_owner and the runner cannot replace it (0904 header);
-- this function belongs to app_owner. The observable rules are those of HEAAA-632 R3. Expand-only: CREATE OR REPLACE with the same
-- signature; no data is rewritten (nothing is deployed). Lowering the cap never cancels a booking, it only refuses new ones.
--
-- The guard bounds an overbook row by max(stored cap) across the location's own policy and the all-locations policy, as an outer
-- bound. The exact cap is the resolved policy that occupy receives as p_overbook_cap.

CREATE OR REPLACE FUNCTION scheduling.guard_overbook_origin() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_cap   integer;
  v_taken integer;
BEGIN
  IF NEW.overbook THEN
    SELECT max(p.overbook_cap_per_session) INTO v_cap FROM organisation.booking_policy p
     WHERE p.organisation_id = NEW.organisation_id AND (p.location_id IS NULL OR p.location_id = NEW.location_id);
    IF coalesce(v_cap, 0) <= 1 THEN
      RAISE EXCEPTION 'overbooking is not allowed here' USING ERRCODE = '23P01';
    END IF;
    -- (a) every active row of the doctor overlapping the period counts, overbook or not.
    SELECT count(*) INTO v_taken FROM scheduling.slot_occupancy o
     WHERE o.organisation_id = NEW.organisation_id AND o.clinician_principal_id = NEW.clinician_principal_id
       AND o.period && NEW.period AND o.status IN ('held', 'confirmed', 'checked_in', 'in_consultation', 'completed')
       AND NOT (o.status = 'held' AND o.expires_at < now());
    IF v_taken >= v_cap THEN
      RAISE EXCEPTION 'the overbook capacity is used' USING ERRCODE = '23P01';
    END IF;
  ELSIF EXISTS (
       -- (c) a normal row is refused while an overbook row of the same doctor overlaps it (the constraint ignores overbook rows).
       SELECT 1 FROM scheduling.slot_occupancy o
        WHERE o.organisation_id = NEW.organisation_id AND o.clinician_principal_id = NEW.clinician_principal_id AND o.overbook
          AND o.period && NEW.period AND o.status IN ('held', 'confirmed', 'checked_in', 'in_consultation', 'completed')
          AND NOT (o.status = 'held' AND o.expires_at < now())) THEN
    RAISE EXCEPTION 'the slot is taken' USING ERRCODE = '23P01';
  END IF;
  -- (b) a room held by another clinician is refused when either row is an overbook row (normal with normal is the constraint's).
  IF NEW.room_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM scheduling.slot_occupancy o
        WHERE o.organisation_id = NEW.organisation_id AND o.room_id = NEW.room_id
          AND o.clinician_principal_id <> NEW.clinician_principal_id AND (NEW.overbook OR o.overbook)
          AND o.period && NEW.period AND o.status IN ('held', 'confirmed', 'checked_in', 'in_consultation', 'completed')
          AND NOT (o.status = 'held' AND o.expires_at < now())) THEN
    RAISE EXCEPTION 'the room is taken' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END
$$;
