-- migration-class: expand
-- The scheduling_booking_owner functions (SHARED-BOUNDARIES 6.2 inventory, 6.5; ARCHITECTURE 21.6, 22.8, 25.1, 25.2; ticket BE-11):
-- occupy, set_status and expire_holds. Each is SECURITY DEFINER, owned by the NOLOGIN function-owner role scheduling_booking_owner,
-- has a fixed search_path = pg_catalog, schema-qualified names only, REVOKE ALL FROM PUBLIC and a narrow EXECUTE list (DF-1, DF-8).
-- Each checks the caller's scope settings itself before acting (6.2 rule 3): the database cannot see the caller's permission, so the
-- API guard checks the permission (BD-07) and the settings decide here which audience may make which change.
--
-- SQLSTATEs: 23P01 the exclusion constraint (or the overbook cap) decided against this caller (409 scheduling.slot_taken, 30);
-- PS001 illegal transition (409 <module>.invalid_transition); 42501 not available to this caller; 22023 bad argument.

-- scheduling.occupy (25.1 step 5, SAR-09, 6.5): marks the stale holds that overlap the doctor's or the room's period as expired,
-- takes the per-session lock when the slot is overbookable, then inserts the held occupancy row. The exclusion constraints decide.
-- The caller inserts the slot_reservation row (same id) under its own RLS in the same transaction. Returns the hold's expiry.
--
-- Overbookable session (BR-02, RA-R1-03): every row of the session is flagged overbook and is excluded from the constraints; the
-- rows of one session are counted under pg_advisory_xact_lock(hashtext('ob:' || doctor || session_key)) against p_overbook_cap,
-- which the API reads from the booking policy (overbook_cap_per_session). A cap of 0 refuses an overbook row.
CREATE FUNCTION scheduling.occupy(
  p_id uuid, p_location uuid, p_clinician uuid, p_room uuid, p_period tstzrange, p_hold_seconds integer,
  p_overbook boolean, p_session_key text, p_overbook_cap integer
) RETURNS timestamptz
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_aud       text := kernel.setting('app.audience');
  v_org       uuid := kernel.uuid1('app.org_id');
  v_principal uuid := kernel.uuid1('app.principal_id');
  v_expires   timestamptz;
  v_count     integer;
  v_lk1       text;
  v_lk2       text;
BEGIN
  IF v_org IS NULL OR v_aud IS NULL OR v_aud NOT IN ('patient', 'staff', 'system') THEN
    RAISE EXCEPTION 'occupy: not available to this caller' USING ERRCODE = '42501';
  END IF;
  IF v_aud <> 'system' AND v_principal IS NULL THEN
    RAISE EXCEPTION 'occupy: not available to this caller' USING ERRCODE = '42501';
  END IF;
  IF v_aud = 'staff' AND (kernel.setting('app.realm') <> 'google' OR NOT p_location = ANY (kernel.uuids('app.location_ids'))) THEN
    RAISE EXCEPTION 'occupy: the location is not the caller''s' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_location IS NULL OR p_clinician IS NULL OR p_period IS NULL OR p_overbook IS NULL
     OR p_hold_seconds IS NULL OR p_hold_seconds NOT BETWEEN 60 AND 7200
     OR isempty(p_period) OR lower_inf(p_period) OR upper_inf(p_period) OR NOT lower_inc(p_period) OR upper_inc(p_period)
     OR upper(p_period) - lower(p_period) NOT BETWEEN interval '5 minutes' AND interval '12 hours'
     OR (p_overbook AND (p_session_key IS NULL OR char_length(p_session_key) NOT BETWEEN 1 AND 200 OR p_overbook_cap IS NULL OR p_overbook_cap < 0 OR p_overbook_cap > 100))
     OR (NOT p_overbook AND p_session_key IS NOT NULL) THEN
    RAISE EXCEPTION 'occupy: bad argument' USING ERRCODE = '22023';
  END IF;

  -- BE11-F01: two concurrent inserts into a GiST exclusion constraint that conflict with each other each wait for the other's
  -- uncommitted row and deadlock (40P01), and the victim may be the one that would have won. So the writers of one doctor's (and one
  -- room's) time are serialised first, by transaction advisory locks taken in one global order (sorted keys), after the patient locks
  -- (25.2) and before the overbook lock. The constraint stays the authority; the lock only removes the deadlock.
  v_lk1 := 'dr:' || p_clinician::text;
  v_lk2 := CASE WHEN p_room IS NULL THEN NULL ELSE 'rm:' || p_room::text END;
  IF v_lk2 IS NOT NULL AND v_lk2 < v_lk1 THEN v_lk1 := v_lk2; v_lk2 := 'dr:' || p_clinician::text; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_lk1));
  IF v_lk2 IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtext(v_lk2)); END IF;

  -- SAR-09: expire the stale holds in the way, on the doctor AND on the room, so a lapsed hold never causes a false "taken". The
  -- rows are locked in id order, so two racing callers wait for each other instead of deadlocking; the one that waits then finds
  -- the row no longer held and skips it.
  UPDATE scheduling.slot_occupancy o SET status = 'expired', expires_at = NULL
   WHERE o.id IN (SELECT x.id FROM scheduling.slot_occupancy x
                   WHERE x.organisation_id = v_org AND x.status = 'held' AND x.expires_at < now() AND x.period && p_period
                     AND (x.clinician_principal_id = p_clinician OR (p_room IS NOT NULL AND x.room_id = p_room))
                   ORDER BY x.id FOR UPDATE)
     AND o.status = 'held' AND o.expires_at < now();

  IF p_overbook THEN
    PERFORM pg_advisory_xact_lock(hashtext('ob:' || p_clinician::text || p_session_key));
    SELECT count(*) INTO v_count FROM scheduling.slot_occupancy o
     WHERE o.organisation_id = v_org AND o.clinician_principal_id = p_clinician AND o.session_key = p_session_key AND o.overbook
       AND o.status IN ('held', 'confirmed', 'checked_in', 'in_consultation', 'completed');
    IF v_count >= p_overbook_cap THEN
      RAISE EXCEPTION 'the session is full' USING ERRCODE = '23P01';
    END IF;
  END IF;

  v_expires := now() + make_interval(secs => p_hold_seconds);
  INSERT INTO scheduling.slot_occupancy (id, organisation_id, location_id, clinician_principal_id, room_id, period, status, expires_at,
                                         overbook, session_key, created_by)
  VALUES (p_id, v_org, p_location, p_clinician, p_room, p_period, 'held', v_expires, p_overbook, p_session_key, v_principal);
  RETURN v_expires;
END
$$;

-- scheduling.set_status (25.1 confirm, cancel, reschedule; 23.1): moves one occupancy row from p_from to p_to. The audience decides
-- which moves it may make (below); the transition table itself is the trigger of 0901. A confirm after the hold's expiry does not
-- raise: it marks the hold expired and returns 'hold_expired' so the caller can answer 409 with alternatives (25.1). Any other
-- refusal raises PS001. The API has already read the reservation under the caller's own RLS (404 if invisible, 6.5).
CREATE FUNCTION scheduling.set_status(p_id uuid, p_from text, p_to text) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_aud     text := kernel.setting('app.audience');
  v_org     uuid := kernel.uuid1('app.org_id');
  v_status  text;
  v_expires timestamptz;
  v_lk1     text;
  v_lk2     text;
BEGIN
  IF v_org IS NULL OR v_aud IS NULL OR v_aud NOT IN ('patient', 'staff', 'system') THEN
    RAISE EXCEPTION 'set_status: not available to this caller' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'set_status: bad argument' USING ERRCODE = '22023';
  END IF;
  -- Who may make which move. A patient (or proxy) holds, confirms, cancels and reschedules their own appointments and checks in by
  -- QR; staff do everything the desk and the clinic do; the system job sweeps holds, marks no-shows and accepts a waitlist offer.
  IF NOT (CASE v_aud
            WHEN 'patient' THEN (p_from, p_to) IN (('held', 'confirmed'), ('held', 'cancelled_patient'), ('confirmed', 'cancelled_patient'),
                                                    ('confirmed', 'rescheduled'), ('confirmed', 'checked_in'))
            WHEN 'staff'   THEN (p_from, p_to) IN (('held', 'confirmed'), ('held', 'cancelled_patient'), ('confirmed', 'cancelled_patient'),
                                                    ('confirmed', 'cancelled_clinic'), ('confirmed', 'rescheduled'), ('confirmed', 'checked_in'),
                                                    ('confirmed', 'no_show'), ('checked_in', 'in_consultation'), ('checked_in', 'no_show'),
                                                    ('in_consultation', 'completed'))
            ELSE                (p_from, p_to) IN (('held', 'confirmed'), ('held', 'expired'), ('held', 'cancelled_patient'), ('confirmed', 'no_show'))
          END) THEN
    RAISE EXCEPTION 'illegal appointment transition' USING ERRCODE = 'PS001';
  END IF;
  IF v_aud = 'staff' AND kernel.setting('app.realm') <> 'google' THEN
    RAISE EXCEPTION 'set_status: not available to this caller' USING ERRCODE = '42501';
  END IF;

  -- BE11-F01: an update that keeps the row in the exclusion constraints' predicate (held -> confirmed, checked_in, ...) writes a new
  -- index entry and so waits for any concurrent inserter of the same doctor's or room's time, who in turn waits for it: a deadlock.
  -- The same doctor and room locks as scheduling.occupy, same order (sorted keys), taken before the row lock. A move out of the
  -- predicate (cancel, expire, no-show, rescheduled) writes no index entry and needs none.
  IF p_to IN ('held', 'confirmed', 'checked_in', 'in_consultation', 'completed') THEN
    SELECT 'dr:' || o.clinician_principal_id::text, CASE WHEN o.room_id IS NULL THEN NULL ELSE 'rm:' || o.room_id::text END
      INTO v_lk1, v_lk2 FROM scheduling.slot_occupancy o WHERE o.id = p_id AND o.organisation_id = v_org;
    IF v_lk1 IS NOT NULL THEN
      IF v_lk2 IS NOT NULL AND v_lk2 < v_lk1 THEN
        PERFORM pg_advisory_xact_lock(hashtext(v_lk2));
        PERFORM pg_advisory_xact_lock(hashtext(v_lk1));
      ELSE
        PERFORM pg_advisory_xact_lock(hashtext(v_lk1));
        IF v_lk2 IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtext(v_lk2)); END IF;
      END IF;
    END IF;
  END IF;

  SELECT o.status, o.expires_at INTO v_status, v_expires FROM scheduling.slot_occupancy o
   WHERE o.id = p_id AND o.organisation_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'occupancy not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> p_from THEN
    RAISE EXCEPTION 'illegal appointment transition' USING ERRCODE = 'PS001';
  END IF;
  IF p_from = 'held' AND p_to = 'confirmed' AND v_expires <= now() THEN
    UPDATE scheduling.slot_occupancy SET status = 'expired', expires_at = NULL WHERE id = p_id;
    RETURN 'hold_expired';
  END IF;
  UPDATE scheduling.slot_occupancy SET status = p_to, expires_at = NULL WHERE id = p_id;
  RETURN 'ok';
END
$$;

-- scheduling.expire_holds (25.1 expiry sweep): the cleanup job's single statement. Not needed for correctness (the inserting
-- transaction expires what is in its way); it frees rows, triggers the waitlist and keeps the table small. Organisation-wide
-- system job only. Returns the freed IDs (at most p_limit, 500 by default).
CREATE FUNCTION scheduling.expire_holds(p_limit integer DEFAULT 500) RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
BEGIN
  IF v_org IS NULL OR kernel.setting('app.audience') <> 'system' OR kernel.setting('app.job_scope') <> 'org' THEN
    RAISE EXCEPTION 'expire_holds: only an organisation-wide job may call this' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'expire_holds: bad argument' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  UPDATE scheduling.slot_occupancy o SET status = 'expired', expires_at = NULL
   WHERE o.id IN (SELECT x.id FROM scheduling.slot_occupancy x
                   WHERE x.organisation_id = v_org AND x.status = 'held' AND x.expires_at < now()
                   ORDER BY x.id LIMIT p_limit FOR UPDATE SKIP LOCKED)
  RETURNING o.id;
END
$$;

REVOKE ALL ON FUNCTION scheduling.occupy(uuid, uuid, uuid, uuid, tstzrange, integer, boolean, text, integer),
  scheduling.set_status(uuid, text, text), scheduling.expire_holds(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scheduling.occupy(uuid, uuid, uuid, uuid, tstzrange, integer, boolean, text, integer),
  scheduling.set_status(uuid, text, text) TO app_api, app_worker;
GRANT EXECUTE ON FUNCTION scheduling.expire_holds(integer) TO app_worker;

ALTER FUNCTION scheduling.occupy(uuid, uuid, uuid, uuid, tstzrange, integer, boolean, text, integer) OWNER TO scheduling_booking_owner;
ALTER FUNCTION scheduling.set_status(uuid, text, text) OWNER TO scheduling_booking_owner;
ALTER FUNCTION scheduling.expire_holds(integer) OWNER TO scheduling_booking_owner;
ALTER FUNCTION scheduling.guard_open_patient() OWNER TO scheduling_booking_owner;

-- The CREATE right on the schema was needed only to move the ownership above.
REVOKE CREATE ON SCHEMA scheduling FROM scheduling_booking_owner;
