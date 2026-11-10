-- migration-class: expand
-- QA-EXEC-F05 / QA04-F02 (HEAAA-633; TC-BK-17, SAR-09, RA-R1-03 6.5(b)): three parallel assignments of one room to three visits that
-- overlap in time all succeeded. `PUT /appointments/{id}/assignment` writes `queue_entry.room_id` only; the room exclusion
-- constraint of 0900 guards `slot_occupancy.room_id`, which an assignment never writes, so nothing could refuse the second
-- assignment, in parallel or in sequence. The room a visit is sent to is now guarded by the database as well:
--   * `room_period` is the visit's own period, copied from its occupancy row by a trigger whenever `room_id` is set (a client cannot
--     write it: no column grant), and cleared when the room is cleared. A room with no readable occupancy period is refused, so the
--     constraint can never be switched off by a missing row;
--   * `queue_entry_room_excl` refuses two queue entries that hold the same room for overlapping periods (23P01, which the API
--     answers as 409 scheduling.slot_taken). A finished visit (`done`) holds no room.
-- The API additionally takes the room's advisory lock (the `rm:` key of scheduling.occupy) and keeps its read of the booked
-- occupancy rows, so an assignment and a booking of the same room are serialised too. Existing rows keep room_period NULL and sit
-- outside the constraint (no DML in a migration); the next write of their room fills it.
ALTER TABLE scheduling.queue_entry ADD COLUMN room_period tstzrange;

CREATE FUNCTION scheduling.queue_entry_set_room_period() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.room_id IS NULL THEN
    NEW.room_period := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.room_id IS NOT DISTINCT FROM OLD.room_id THEN
    NEW.room_period := OLD.room_period;
    RETURN NEW;
  END IF;
  SELECT o.period INTO NEW.room_period FROM scheduling.slot_occupancy o WHERE o.id = NEW.id;
  IF NEW.room_period IS NULL THEN
    RAISE EXCEPTION 'a room needs the period of the visit' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.queue_entry_set_room_period() FROM PUBLIC;
CREATE TRIGGER queue_entry_room_period BEFORE INSERT OR UPDATE ON scheduling.queue_entry
  FOR EACH ROW EXECUTE FUNCTION scheduling.queue_entry_set_room_period();

ALTER TABLE scheduling.queue_entry ADD CONSTRAINT queue_entry_room_excl
  EXCLUDE USING gist (room_id WITH =, room_period WITH &&)
  WHERE (room_id IS NOT NULL AND room_period IS NOT NULL AND stage <> 'done');
