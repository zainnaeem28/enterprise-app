-- migration-class: expand
-- Triggers of the encounter and note tables (ARCHITECTURE 21.5, 22.11, 22.16, 23.2; SHARED-BOUNDARIES 9.2; PRD BR-11, BR-12; ticket BE-17).
-- Invoker rights, search_path pinned to pg_catalog, schema-qualified names only, except clinical.notes_guard_open_patient (below).
-- SQLSTATE PS001: an illegal change (a write to a locked or fixed column, a step the state machine does not allow, a signature by
-- someone who may not give it); PM001 / PM008: the merge write guard.
--
-- The database, not the route, decides what can change: a signed note is locked for every writer (23.2: refuse_update_when_terminal
-- 'signed'); a note's content changes only while it is a draft and only by its author; a note reaches `signed` only by its author or
-- the encounter's clinician (no co-signature needed) or, for a note submitted for co-signature, only after the supervisor's
-- note_cosign row exists and by that supervisor; a co-signature and an addendum are never updated or deleted; an encounter completes
-- only with a note signed or submitted, or with a recorded deferral (ST-01 / 23.1).

-- Needed only to move the merge write guard's ownership to the function-owner role (end of this file); withdrawn again there.
GRANT CREATE ON SCHEMA clinical TO patient_scope_owner;

CREATE TRIGGER encounter_bump_row_version BEFORE UPDATE ON clinical.encounter FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER note_bump_row_version BEFORE UPDATE ON clinical.note FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- The merge write guard (SBR-12, 9.2). Same refusal as patient.guard_open_patient and the guards of the chart and the front door (a
-- copy: those are owned by patient_scope_owner with EXECUTE revoked from PUBLIC, so the migration role cannot attach them). It is
-- moved to patient_scope_owner at the end of this file, so it reads the root whatever the caller's scope is, and it takes FOR KEY
-- SHARE, which conflicts with the merge's FOR UPDATE on the root.
CREATE FUNCTION clinical.notes_guard_open_patient() RETURNS trigger
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
REVOKE ALL ON FUNCTION clinical.notes_guard_open_patient() FROM PUBLIC;
CREATE TRIGGER encounter_guard_open BEFORE INSERT OR UPDATE ON clinical.encounter FOR EACH ROW EXECUTE FUNCTION clinical.notes_guard_open_patient();
CREATE TRIGGER note_guard_open BEFORE INSERT OR UPDATE ON clinical.note FOR EACH ROW EXECUTE FUNCTION clinical.notes_guard_open_patient();
CREATE TRIGGER note_cosign_guard_open BEFORE INSERT OR UPDATE ON clinical.note_cosign FOR EACH ROW EXECUTE FUNCTION clinical.notes_guard_open_patient();
CREATE TRIGGER note_addendum_guard_open BEFORE INSERT OR UPDATE ON clinical.note_addendum FOR EACH ROW EXECUTE FUNCTION clinical.notes_guard_open_patient();

-- Append-only: a co-signature and an addendum are never changed or removed ----------------------------------------------------
CREATE FUNCTION clinical.notes_refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'append-only: a later change is a new row' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION clinical.notes_refuse_change() FROM PUBLIC;
CREATE TRIGGER note_cosign_append_only BEFORE UPDATE OR DELETE ON clinical.note_cosign FOR EACH ROW EXECUTE FUNCTION clinical.notes_refuse_change();
CREATE TRIGGER note_addendum_append_only BEFORE UPDATE OR DELETE ON clinical.note_addendum FOR EACH ROW EXECUTE FUNCTION clinical.notes_refuse_change();

-- No encounter and no note is ever deleted: the record stays (SHARED-BOUNDARIES: no hard delete of clinical data).
CREATE FUNCTION clinical.notes_refuse_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'an encounter and a note are never deleted' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION clinical.notes_refuse_delete() FROM PUBLIC;
CREATE TRIGGER encounter_no_delete BEFORE DELETE ON clinical.encounter FOR EACH ROW EXECUTE FUNCTION clinical.notes_refuse_delete();
CREATE TRIGGER note_no_delete BEFORE DELETE ON clinical.note FOR EACH ROW EXECUTE FUNCTION clinical.notes_refuse_delete();

-- clinical.encounter ---------------------------------------------------------------------------------------------------------
-- open -> in_consultation -> completed; open -> cancelled (23.2). completed and cancelled are final (K). The patient changes only
-- for a system job (the merge) and only while the encounter is open or in consultation (R).
CREATE FUNCTION clinical.guard_encounter() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_who  uuid := kernel.uuid1('app.principal_id');
  v_col  text;
  v_old  jsonb;
  v_new  jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('open', 'in_consultation') OR NEW.note_deferred_reason IS NOT NULL THEN
      RAISE EXCEPTION 'an encounter starts open or in consultation' USING ERRCODE = 'PS001';
    END IF;
    IF v_who IS NOT NULL AND NEW.clinician_principal_id <> v_who THEN
      RAISE EXCEPTION 'an encounter is started by its clinician' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'a completed or cancelled encounter is final' USING ERRCODE = 'PS001';
  END IF;
  FOREACH v_col IN ARRAY ARRAY['id', 'organisation_id', 'location_id', 'reservation_id', 'clinician_principal_id', 'mode', 'created_at', 'created_by'] LOOP
    IF to_jsonb(OLD) -> v_col IS DISTINCT FROM to_jsonb(NEW) -> v_col THEN
      RAISE EXCEPTION 'an encounter keeps its identity, place and clinician' USING ERRCODE = 'PS001';
    END IF;
  END LOOP;
  v_old := to_jsonb(OLD) - 'row_version' - 'updated_at';
  v_new := to_jsonb(NEW) - 'row_version' - 'updated_at';
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    IF NOT (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system') THEN
      RAISE EXCEPTION 'only a merge moves an encounter to another patient' USING ERRCODE = 'PS001';
    END IF;
    IF (v_old - 'patient_id') IS DISTINCT FROM (v_new - 'patient_id') THEN
      RAISE EXCEPTION 'a merge changes nothing but the patient' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'open' AND NEW.status IN ('in_consultation', 'cancelled'))
       OR (OLD.status = 'in_consultation' AND NEW.status = 'completed')) THEN
    RAISE EXCEPTION 'illegal encounter step' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status = 'completed'
     AND NEW.note_deferred_reason IS NULL
     AND NOT EXISTS (SELECT 1 FROM clinical.note n WHERE n.encounter_id = OLD.id AND n.status IN ('signed', 'pending_cosign')) THEN
    RAISE EXCEPTION 'an encounter completes with a note signed or submitted, or with the deferral recorded' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION clinical.guard_encounter() FROM PUBLIC;
CREATE TRIGGER encounter_guard BEFORE INSERT OR UPDATE ON clinical.encounter FOR EACH ROW EXECUTE FUNCTION clinical.guard_encounter();

-- clinical.note --------------------------------------------------------------------------------------------------------------
-- draft -> signed; draft -> pending_cosign -> signed (trainee). Signed is final for every writer. See the header for the rules.
CREATE FUNCTION clinical.guard_note() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_who      uuid := kernel.uuid1('app.principal_id');
  v_sys      boolean := (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system');
  v_col      text;
  v_old      jsonb;
  v_new      jsonb;
  v_clin     uuid;
  v_super    uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a note starts as a draft' USING ERRCODE = 'PS001';
    END IF;
    IF v_who IS NOT NULL AND NEW.author_principal_id <> v_who THEN
      RAISE EXCEPTION 'a note is written by its author' USING ERRCODE = 'PS001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM clinical.encounter e
                    WHERE e.id = NEW.encounter_id AND e.patient_id = NEW.patient_id AND e.status IN ('in_consultation', 'completed')) THEN
      RAISE EXCEPTION 'a note belongs to a started encounter of the same patient' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION 'a signed note is locked' USING ERRCODE = 'PS001';
  END IF;
  FOREACH v_col IN ARRAY ARRAY['id', 'organisation_id', 'encounter_id', 'author_principal_id', 'template_id', 'created_at', 'created_by'] LOOP
    IF to_jsonb(OLD) -> v_col IS DISTINCT FROM to_jsonb(NEW) -> v_col THEN
      RAISE EXCEPTION 'a note keeps its identity, encounter, author and template' USING ERRCODE = 'PS001';
    END IF;
  END LOOP;
  v_old := to_jsonb(OLD) - 'row_version' - 'updated_at';
  v_new := to_jsonb(NEW) - 'row_version' - 'updated_at';

  -- The merge moves a draft or a note waiting for co-signature to the survivor and changes nothing else (22.16).
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    IF NOT v_sys THEN
      RAISE EXCEPTION 'only a merge moves a note to another patient' USING ERRCODE = 'PS001';
    END IF;
    IF (v_old - 'patient_id') IS DISTINCT FROM (v_new - 'patient_id') THEN
      RAISE EXCEPTION 'a merge changes nothing but the patient' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    -- An autosave: the content only, by the author.
    IF (v_old - 'body') IS DISTINCT FROM (v_new - 'body') THEN
      RAISE EXCEPTION 'a draft save changes the content only' USING ERRCODE = 'PS001';
    END IF;
    IF v_who IS DISTINCT FROM OLD.author_principal_id THEN
      RAISE EXCEPTION 'only the author edits a draft' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  -- Every other step leaves the content alone: signing never changes what was written.
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    RAISE EXCEPTION 'signing does not change the content' USING ERRCODE = 'PS001';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'signed' THEN
    SELECT e.clinician_principal_id INTO v_clin FROM clinical.encounter e WHERE e.id = OLD.encounter_id;
    IF NEW.submitted_for_cosign_at IS NOT NULL OR NEW.cosign_required_from IS NOT NULL THEN
      RAISE EXCEPTION 'a note signed directly has no co-signature step' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.signed_by IS DISTINCT FROM v_who OR NEW.signed_by NOT IN (OLD.author_principal_id, v_clin) THEN
      RAISE EXCEPTION 'a note is signed by its author or the encounter clinician, in their own name' USING ERRCODE = 'PS001';
    END IF;
    -- Only a holder of clinical.note.sign at the encounter's place signs (an assistant prepares, a trainee submits: 27.3, BR-12).
    IF NOT EXISTS (SELECT 1 FROM identity.role_assignment ra
                     JOIN identity.role_permission rp ON rp.role_id = ra.role_id
                     JOIN clinical.encounter e ON e.id = OLD.encounter_id
                    WHERE ra.principal_id = NEW.signed_by AND ra.revoked_at IS NULL AND rp.permission_key = 'clinical.note.sign'
                      AND (ra.location_id IS NULL OR ra.location_id = e.location_id)) THEN
      RAISE EXCEPTION 'the signer does not hold clinical.note.sign' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'pending_cosign' THEN
    IF v_who IS DISTINCT FROM OLD.author_principal_id THEN
      RAISE EXCEPTION 'only the author submits a note for co-signature' USING ERRCODE = 'PS001';
    END IF;
    SELECT sp.supervisor_principal_id INTO v_super FROM identity.staff_profile sp WHERE sp.principal_id = OLD.author_principal_id;
    IF v_super IS NULL OR NEW.cosign_required_from IS DISTINCT FROM v_super THEN
      RAISE EXCEPTION 'the co-signature is required from the author''s supervisor' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.signed_at IS NOT NULL OR NEW.signed_by IS NOT NULL THEN
      RAISE EXCEPTION 'a note waiting for co-signature is not yet signed' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending_cosign' AND NEW.status = 'signed' THEN
    IF NEW.cosign_required_from IS DISTINCT FROM OLD.cosign_required_from
       OR NEW.submitted_for_cosign_at IS DISTINCT FROM OLD.submitted_for_cosign_at THEN
      RAISE EXCEPTION 'the co-signature step is not changed' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.signed_by IS DISTINCT FROM OLD.cosign_required_from OR v_who IS DISTINCT FROM OLD.cosign_required_from THEN
      RAISE EXCEPTION 'a note waiting for co-signature is signed by the supervisor named' USING ERRCODE = 'PS001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM clinical.note_cosign c WHERE c.note_id = OLD.id AND c.supervisor_principal_id = OLD.cosign_required_from) THEN
      RAISE EXCEPTION 'a trainee note is released only after the co-signature is recorded' USING ERRCODE = 'PS001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM identity.role_assignment ra
                     JOIN identity.role_permission rp ON rp.role_id = ra.role_id
                     JOIN clinical.encounter e ON e.id = OLD.encounter_id
                    WHERE ra.principal_id = NEW.signed_by AND ra.revoked_at IS NULL AND rp.permission_key = 'clinical.note.cosign'
                      AND (ra.location_id IS NULL OR ra.location_id = e.location_id)) THEN
      RAISE EXCEPTION 'the co-signer does not hold clinical.note.cosign' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'illegal note step' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION clinical.guard_note() FROM PUBLIC;
CREATE TRIGGER note_guard BEFORE INSERT OR UPDATE ON clinical.note FOR EACH ROW EXECUTE FUNCTION clinical.guard_note();

-- clinical.note_cosign: only for a note waiting for exactly this supervisor's co-signature (BR-12) ----------------------------
CREATE FUNCTION clinical.check_cosign_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_who  uuid := kernel.uuid1('app.principal_id');
  v_note clinical.note%ROWTYPE;
BEGIN
  SELECT * INTO v_note FROM clinical.note n WHERE n.id = NEW.note_id AND n.organisation_id = NEW.organisation_id;
  IF NOT FOUND OR v_note.status <> 'pending_cosign' THEN
    RAISE EXCEPTION 'only a note waiting for co-signature is co-signed' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.supervisor_principal_id IS DISTINCT FROM v_note.cosign_required_from
     OR NEW.supervisor_principal_id = v_note.author_principal_id
     OR (v_who IS NOT NULL AND v_who <> NEW.supervisor_principal_id) THEN
    RAISE EXCEPTION 'the co-signature is given by the supervisor named, never the author' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.patient_id <> v_note.patient_id THEN
    RAISE EXCEPTION 'a co-signature carries the note''s patient' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION clinical.check_cosign_insert() FROM PUBLIC;
CREATE TRIGGER note_cosign_insert_check BEFORE INSERT ON clinical.note_cosign FOR EACH ROW EXECUTE FUNCTION clinical.check_cosign_insert();

-- clinical.note_addendum: only to a signed note, by the caller, for the note's patient or the survivor of a merge (9.2, 22.11) ----
CREATE FUNCTION clinical.check_addendum_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_who  uuid := kernel.uuid1('app.principal_id');
  v_note clinical.note%ROWTYPE;
BEGIN
  SELECT * INTO v_note FROM clinical.note n WHERE n.id = NEW.note_id AND n.organisation_id = NEW.organisation_id;
  IF NOT FOUND OR v_note.status <> 'signed' THEN
    RAISE EXCEPTION 'an addendum is added to a signed note' USING ERRCODE = 'PS001';
  END IF;
  IF v_who IS NOT NULL AND NEW.author_principal_id <> v_who THEN
    RAISE EXCEPTION 'an addendum is written by its author' USING ERRCODE = 'PS001';
  END IF;
  -- A signed addendum is a signature: only a holder of clinical.note.sign at the encounter's place writes one (27.3, BR-11, BR-12).
  IF NOT EXISTS (SELECT 1 FROM identity.role_assignment ra
                   JOIN identity.role_permission rp ON rp.role_id = ra.role_id
                   JOIN clinical.encounter e ON e.id = v_note.encounter_id
                  WHERE ra.principal_id = NEW.author_principal_id AND ra.revoked_at IS NULL AND rp.permission_key = 'clinical.note.sign'
                    AND (ra.location_id IS NULL OR ra.location_id = e.location_id)) THEN
    RAISE EXCEPTION 'the author of an addendum does not hold clinical.note.sign' USING ERRCODE = 'PS001';
  END IF;
  IF v_note.patient_id <> NEW.patient_id
     AND NOT EXISTS (SELECT 1 FROM patient.patient_merge m WHERE m.merged_id = v_note.patient_id AND m.final_survivor_id = NEW.patient_id) THEN
    RAISE EXCEPTION 'an addendum belongs to the note''s patient or the survivor of a merge' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION clinical.check_addendum_insert() FROM PUBLIC;
CREATE TRIGGER note_addendum_insert_check BEFORE INSERT ON clinical.note_addendum FOR EACH ROW EXECUTE FUNCTION clinical.check_addendum_insert();

-- The merge write guard runs as the function-owner role (see above); the CREATE right is withdrawn again.
ALTER FUNCTION clinical.notes_guard_open_patient() OWNER TO patient_scope_owner;
REVOKE CREATE ON SCHEMA clinical FROM patient_scope_owner;
