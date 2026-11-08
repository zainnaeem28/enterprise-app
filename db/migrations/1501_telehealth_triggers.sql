-- migration-class: expand
-- Triggers of the telehealth tables (ARCHITECTURE 21.5, 22.10, 22.16, 23.1 ST-06; SHARED-BOUNDARIES 9.2; ticket BE-15).
-- Invoker rights, search_path pinned to pg_catalog, schema-qualified names only, except telehealth.guard_open_patient (below).
-- SQLSTATE PS001: illegal state transition or a write to a kept (K) row.
--
-- The database, not the route, decides which moves a session, a participant and a join token may make, that a K row is never written
-- again (so a row left on a merged ID can never be the target of a later write, 22.16), that the host of a session is the clinician
-- of its reservation, and that a join token exists only for an admitted participant of a live session.

CREATE TRIGGER video_session_bump_row_version BEFORE UPDATE ON telehealth.video_session FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER participant_bump_row_version BEFORE UPDATE ON telehealth.participant FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER join_token_bump_row_version BEFORE UPDATE ON telehealth.join_token FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- The merge write guard (SBR-12, 9.2) on the four tables with a patient_id. Same refusal as patient.guard_open_patient (a copy: that
-- function is owned by patient_scope_owner with EXECUTE revoked from PUBLIC, so the migration role cannot attach it; the same
-- departure as BE-11 D1 and BE-13). It is moved to patient_scope_owner at the end of this file, so it reads the root whatever the
-- caller's scope is, and it takes FOR KEY SHARE, which conflicts with the merge's FOR UPDATE on the root.
CREATE FUNCTION telehealth.guard_open_patient() RETURNS trigger
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
REVOKE ALL ON FUNCTION telehealth.guard_open_patient() FROM PUBLIC;
CREATE TRIGGER video_session_guard_open BEFORE INSERT OR UPDATE ON telehealth.video_session FOR EACH ROW EXECUTE FUNCTION telehealth.guard_open_patient();
CREATE TRIGGER participant_guard_open BEFORE INSERT OR UPDATE ON telehealth.participant FOR EACH ROW EXECUTE FUNCTION telehealth.guard_open_patient();
CREATE TRIGGER join_token_guard_open BEFORE INSERT OR UPDATE ON telehealth.join_token FOR EACH ROW EXECUTE FUNCTION telehealth.guard_open_patient();
CREATE TRIGGER location_confirmation_guard_open BEFORE INSERT OR UPDATE ON telehealth.location_confirmation FOR EACH ROW EXECUTE FUNCTION telehealth.guard_open_patient();

-- video_session ------------------------------------------------------------------------------------------------------
-- Insert: a session belongs to a VIDEO reservation: the same organisation, patient and clinician. Nobody can create one for somebody
-- else's reservation, or for an in-person visit.
CREATE FUNCTION telehealth.guard_session_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  r scheduling.slot_reservation%ROWTYPE;
BEGIN
  SELECT * INTO r FROM scheduling.slot_reservation WHERE id = NEW.reservation_id;
  IF NOT FOUND OR r.mode <> 'video' OR r.organisation_id <> NEW.organisation_id OR r.patient_id <> NEW.patient_id
     OR r.clinician_principal_id <> NEW.clinician_principal_id THEN
    RAISE EXCEPTION 'a session belongs to its video reservation' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status <> 'scheduled' OR NEW.vendor_meeting_id IS NOT NULL THEN
    RAISE EXCEPTION 'a session starts scheduled and without a meeting' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION telehealth.guard_session_insert() FROM PUBLIC;
CREATE TRIGGER video_session_insert_check BEFORE INSERT ON telehealth.video_session FOR EACH ROW EXECUTE FUNCTION telehealth.guard_session_insert();

-- Update: refuse_update_when_terminal('ended', 'failed') (22.10): an ended or failed session accepts no change at all, for any role.
-- scheduled -> open | ended | failed; open -> ended | failed. The vendor meeting is set once (NULL -> value). What a session is
-- (reservation, clinician, organisation) never changes; its patient changes only through the merge (patient_id).
CREATE FUNCTION telehealth.guard_session_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status IN ('ended', 'failed') THEN
    RAISE EXCEPTION 'a finished session accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
     OR NEW.clinician_principal_id IS DISTINCT FROM OLD.clinician_principal_id
     OR NEW.recording_enabled IS DISTINCT FROM OLD.recording_enabled
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a session keeps its reservation and its host' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.vendor_meeting_id IS NOT NULL AND (NEW.vendor_meeting_id IS DISTINCT FROM OLD.vendor_meeting_id OR NEW.vendor IS DISTINCT FROM OLD.vendor) THEN
    RAISE EXCEPTION 'a session keeps its meeting' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status, NEW.status) IN (('scheduled', 'open'), ('scheduled', 'ended'), ('scheduled', 'failed'), ('open', 'ended'), ('open', 'failed'))) THEN
      RAISE EXCEPTION 'illegal session transition' USING ERRCODE = 'PS001';
    END IF;
    -- A finished session holds no live token: the closing transaction revokes them first (ST-4, 22.10).
    IF NEW.status IN ('ended', 'failed') AND EXISTS (SELECT 1 FROM telehealth.join_token t WHERE t.session_id = OLD.id AND t.status = 'issued') THEN
      RAISE EXCEPTION 'revoke the join tokens before the session ends' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.status = 'open' AND NEW.opened_at IS NULL THEN
      NEW.opened_at := now();
    END IF;
    IF NEW.status IN ('ended', 'failed') AND NEW.ended_at IS NULL THEN
      NEW.ended_at := now();
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION telehealth.guard_session_update() FROM PUBLIC;
CREATE TRIGGER video_session_update_guard BEFORE UPDATE ON telehealth.video_session FOR EACH ROW EXECUTE FUNCTION telehealth.guard_session_update();

-- participant ---------------------------------------------------------------------------------------------------------
-- Insert: only into a live session, for that session's patient; the clinician role is the session's host and nobody else; a patient or
-- proxy never starts admitted (the host admits).
CREATE FUNCTION telehealth.guard_participant_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  s telehealth.video_session%ROWTYPE;
BEGIN
  SELECT * INTO s FROM telehealth.video_session WHERE id = NEW.session_id;
  IF NOT FOUND OR s.organisation_id <> NEW.organisation_id OR s.patient_id <> NEW.patient_id OR s.status NOT IN ('scheduled', 'open') THEN
    RAISE EXCEPTION 'a participant belongs to a live session of its patient' USING ERRCODE = 'PS001';
  END IF;
  IF (NEW.role = 'clinician') <> (NEW.principal_id = s.clinician_principal_id) THEN
    RAISE EXCEPTION 'the clinician role is the host of the session' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.role = 'clinician' AND NEW.admission <> 'admitted' THEN
    RAISE EXCEPTION 'the host is admitted' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.role <> 'clinician' AND NEW.admission <> 'waiting' THEN
    RAISE EXCEPTION 'a patient or proxy starts in the waiting room' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION telehealth.guard_participant_insert() FROM PUBLIC;
CREATE TRIGGER participant_insert_check BEFORE INSERT ON telehealth.participant FOR EACH ROW EXECUTE FUNCTION telehealth.guard_participant_insert();

-- Update: refuse_update_when_parent_terminal(video_session, 'ended', 'failed') (22.10). waiting -> admitted | removed;
-- admitted -> removed; removed -> admitted (the host lets somebody back in). Who and what never change.
CREATE FUNCTION telehealth.guard_participant_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_status text;
BEGIN
  SELECT s.status INTO v_status FROM telehealth.video_session s WHERE s.id = OLD.session_id;
  IF v_status IS NULL OR v_status IN ('ended', 'failed') THEN
    RAISE EXCEPTION 'a participant of a finished session accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a participant keeps its session, role and person' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.admission IS DISTINCT FROM OLD.admission AND NOT ((OLD.admission, NEW.admission) IN (
        ('waiting', 'admitted'), ('waiting', 'removed'), ('admitted', 'removed'), ('removed', 'admitted'))) THEN
    RAISE EXCEPTION 'illegal admission transition' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.role = 'clinician' AND NEW.admission <> 'admitted' THEN
    RAISE EXCEPTION 'the host stays admitted' USING ERRCODE = 'PS001';
  END IF;
  -- Only the host (staff) admits or removes. The column grant is per role (app_api), so the audience is checked here.
  IF (SELECT kernel.setting('app.audience')) = 'patient'
     AND (NEW.admission IS DISTINCT FROM OLD.admission OR NEW.admitted_at IS DISTINCT FROM OLD.admitted_at
          OR NEW.admitted_by IS DISTINCT FROM OLD.admitted_by) THEN
    RAISE EXCEPTION 'a patient cannot admit themselves' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION telehealth.guard_participant_update() FROM PUBLIC;
CREATE TRIGGER participant_update_guard BEFORE UPDATE ON telehealth.participant FOR EACH ROW EXECUTE FUNCTION telehealth.guard_participant_update();

-- join_token ------------------------------------------------------------------------------------------------------------
-- Insert: for an ADMITTED participant of a live session with a meeting, for that participant's own person. Nothing else can hold a token.
CREATE FUNCTION telehealth.guard_join_token_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  p telehealth.participant%ROWTYPE;
  v_status text;
  v_meeting text;
BEGIN
  SELECT * INTO p FROM telehealth.participant WHERE id = NEW.participant_id;
  SELECT s.status, s.vendor_meeting_id INTO v_status, v_meeting FROM telehealth.video_session s WHERE s.id = NEW.session_id;
  IF NOT FOUND OR p.id IS NULL OR p.session_id <> NEW.session_id OR p.principal_id <> NEW.principal_id
     OR p.patient_id <> NEW.patient_id OR p.organisation_id <> NEW.organisation_id THEN
    RAISE EXCEPTION 'a token belongs to its participant' USING ERRCODE = 'PS001';
  END IF;
  IF p.admission <> 'admitted' OR v_status NOT IN ('scheduled', 'open') OR v_meeting IS NULL THEN
    RAISE EXCEPTION 'a token needs an admitted participant of a live session with a meeting' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status <> 'issued' THEN
    RAISE EXCEPTION 'a token starts issued' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION telehealth.guard_join_token_insert() FROM PUBLIC;
CREATE TRIGGER join_token_insert_check BEFORE INSERT ON telehealth.join_token FOR EACH ROW EXECUTE FUNCTION telehealth.guard_join_token_insert();

-- Update: issued -> used | revoked, once. A used or revoked token is K. Only the status columns move; the merge changes patient_id.
-- (Revocation at the end of a session comes first, in the same transaction, so a finished session never has a live token.)
CREATE FUNCTION telehealth.guard_join_token_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status <> 'issued' THEN
    RAISE EXCEPTION 'a used or revoked token accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a token keeps its participant and its life' USING ERRCODE = 'PS001';
  END IF;
  -- A patient or proxy can only revoke their own token (a newer one supersedes it); `used` is the vendor event's.
  IF (SELECT kernel.setting('app.audience')) = 'patient' AND NEW.status <> 'revoked' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a patient can only revoke a token' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status = 'revoked' AND NEW.revoked_at IS NULL THEN
    NEW.revoked_at := now();
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION telehealth.guard_join_token_update() FROM PUBLIC;
CREATE TRIGGER join_token_update_guard BEFORE UPDATE ON telehealth.join_token FOR EACH ROW EXECUTE FUNCTION telehealth.guard_join_token_update();

-- location_confirmation: append-only and K for every row; it belongs to a VIDEO reservation of its patient.
CREATE FUNCTION telehealth.guard_location_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  r scheduling.slot_reservation%ROWTYPE;
BEGIN
  SELECT * INTO r FROM scheduling.slot_reservation WHERE id = NEW.reservation_id;
  IF NOT FOUND OR r.mode <> 'video' OR r.organisation_id <> NEW.organisation_id OR r.patient_id <> NEW.patient_id THEN
    RAISE EXCEPTION 'a location confirmation belongs to a video reservation of its patient' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION telehealth.guard_location_insert() FROM PUBLIC;
CREATE TRIGGER location_confirmation_insert_check BEFORE INSERT ON telehealth.location_confirmation FOR EACH ROW EXECUTE FUNCTION telehealth.guard_location_insert();

CREATE FUNCTION telehealth.refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'this table is insert-only' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION telehealth.refuse_change() FROM PUBLIC;
CREATE TRIGGER location_confirmation_insert_only BEFORE UPDATE OR DELETE ON telehealth.location_confirmation FOR EACH ROW EXECUTE FUNCTION telehealth.refuse_change();

ALTER FUNCTION telehealth.guard_open_patient() OWNER TO patient_scope_owner;
-- The CREATE right on the schema was needed only to move the ownership above (granted in 1500).
REVOKE CREATE ON SCHEMA telehealth FROM patient_scope_owner;
