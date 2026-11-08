-- migration-class: expand
-- Triggers of the clinical chart tables (ARCHITECTURE 21.5, 22.11, 22.16; SHARED-BOUNDARIES 9.2; ticket BE-16).
-- Invoker rights, search_path pinned to pg_catalog, schema-qualified names only, except clinical.guard_open_patient (below).
-- SQLSTATE PS001: illegal change (a write to a kept or fixed column, a bad correction, a range that does not match its value);
-- PM001 / PM008: the merge write guard.
--
-- The database, not the route, decides what can change: a coded list entry keeps its code and display; an entry marked
-- entered_in_error can only move with a merge; a vital sign is never updated or deleted (a correction is a new row); the range
-- status of a vital sign must agree with the value and the range row it names; a retired reference range is final.

CREATE TRIGGER problem_bump_row_version BEFORE UPDATE ON clinical.problem FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER allergy_bump_row_version BEFORE UPDATE ON clinical.allergy FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER medication_bump_row_version BEFORE UPDATE ON clinical.medication_statement FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER vital_range_bump_row_version BEFORE UPDATE ON clinical.vital_range FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- The merge write guard (SBR-12, 9.2). Same refusal, same name as patient.guard_open_patient (the M-5 check looks for the name): a
-- copy, because that function is owned by patient_scope_owner with EXECUTE revoked from PUBLIC and app_owner cannot attach it
-- (the BE-10/BE-11 departure D1). 1603 moves this copy to patient_scope_owner, so it reads the root whatever the caller's scope is,
-- and it takes the same FOR KEY SHARE lock, which conflicts with the merge's FOR UPDATE on the root.
CREATE FUNCTION clinical.guard_open_patient() RETURNS trigger
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
REVOKE ALL ON FUNCTION clinical.guard_open_patient() FROM PUBLIC;
CREATE TRIGGER problem_guard_open BEFORE INSERT OR UPDATE ON clinical.problem FOR EACH ROW EXECUTE FUNCTION clinical.guard_open_patient();
CREATE TRIGGER allergy_guard_open BEFORE INSERT OR UPDATE ON clinical.allergy FOR EACH ROW EXECUTE FUNCTION clinical.guard_open_patient();
CREATE TRIGGER medication_guard_open BEFORE INSERT OR UPDATE ON clinical.medication_statement FOR EACH ROW EXECUTE FUNCTION clinical.guard_open_patient();
CREATE TRIGGER vital_sign_guard_open BEFORE INSERT ON clinical.vital_sign FOR EACH ROW EXECUTE FUNCTION clinical.guard_open_patient();

-- Problems, allergies, medications: what may change (R in every status, 22.16) -------------------------------------------------
-- TG_ARGV[0]: columns that never change after the insert. TG_ARGV[1]: columns that stay fixed once the entry is coded (a coded
-- entry keeps its code and display; an uncoded one can be coded, or its text corrected). An entered_in_error entry changes only its
-- patient (the merge re-points it, 22.16). The patient changes only for a system job, which is the merge.
CREATE FUNCTION clinical.guard_list_row() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_old   jsonb := to_jsonb(OLD);
  v_new   jsonb := to_jsonb(NEW);
  v_col   text;
BEGIN
  FOREACH v_col IN ARRAY string_to_array(TG_ARGV[0], ',') LOOP
    IF v_old -> v_col IS DISTINCT FROM v_new -> v_col THEN
      RAISE EXCEPTION 'a chart entry keeps its identity and author' USING ERRCODE = 'PS001';
    END IF;
  END LOOP;
  IF OLD.coded THEN
    FOREACH v_col IN ARRAY string_to_array(TG_ARGV[1], ',') LOOP
      IF v_old -> v_col IS DISTINCT FROM v_new -> v_col THEN
        RAISE EXCEPTION 'a coded entry keeps its code and display' USING ERRCODE = 'PS001';
      END IF;
    END LOOP;
  END IF;
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id
     AND NOT (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system') THEN
    RAISE EXCEPTION 'only a merge moves an entry to another patient' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status = 'entered_in_error' AND (v_old - 'patient_id' - 'row_version' - 'updated_at') IS DISTINCT FROM (v_new - 'patient_id' - 'row_version' - 'updated_at') THEN
    RAISE EXCEPTION 'an entry marked entered in error accepts no change' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION clinical.guard_list_row() FROM PUBLIC;
CREATE TRIGGER problem_guard BEFORE UPDATE ON clinical.problem FOR EACH ROW
  EXECUTE FUNCTION clinical.guard_list_row('id,organisation_id,recorded_by,created_at,created_by', 'coded,code_system,code,display');
CREATE TRIGGER allergy_guard BEFORE UPDATE ON clinical.allergy FOR EACH ROW
  EXECUTE FUNCTION clinical.guard_list_row('id,organisation_id,recorded_by,created_at,created_by,category', 'coded,code_system,code,display');
CREATE TRIGGER medication_guard BEFORE UPDATE ON clinical.medication_statement FOR EACH ROW
  EXECUTE FUNCTION clinical.guard_list_row('id,organisation_id,recorded_by,created_at,created_by', 'coded,rxnorm_code,display');

-- A new entry starts active, written by its recorder (the policy also pins this; the trigger holds for any writer).
CREATE FUNCTION clinical.check_list_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF to_jsonb(NEW) ->> 'status' <> 'active' THEN
    RAISE EXCEPTION 'a chart entry starts active' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION clinical.check_list_insert() FROM PUBLIC;
CREATE TRIGGER problem_insert_check BEFORE INSERT ON clinical.problem FOR EACH ROW EXECUTE FUNCTION clinical.check_list_insert();
CREATE TRIGGER allergy_insert_check BEFORE INSERT ON clinical.allergy FOR EACH ROW EXECUTE FUNCTION clinical.check_list_insert();
CREATE TRIGGER medication_insert_check BEFORE INSERT ON clinical.medication_statement FOR EACH ROW EXECUTE FUNCTION clinical.check_list_insert();

-- clinical.vital_sign: append-only ------------------------------------------------------------------------------------------
CREATE FUNCTION clinical.refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'append-only: a later change is a new row' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION clinical.refuse_change() FROM PUBLIC;
CREATE TRIGGER vital_sign_append_only BEFORE UPDATE OR DELETE ON clinical.vital_sign FOR EACH ROW EXECUTE FUNCTION clinical.refuse_change();

-- A vital sign's range status must agree with its value and the range row it names (AL-02: the status and the bounds used are
-- stored on the row). A correction names a row of the same code that is not itself entered in error and is not corrected yet (the
-- unique index), for the same patient or for the survivor of a patient merged into this one (22.11: a correction of a merged ID's row
-- is a new row on the survivor).
CREATE FUNCTION clinical.check_vital_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_range clinical.vital_range%ROWTYPE;
  v_old   clinical.vital_sign%ROWTYPE;
  v_out   boolean;
BEGIN
  IF NEW.range_status IN ('in_range', 'out_of_range') THEN
    SELECT * INTO v_range FROM clinical.vital_range r WHERE r.id = NEW.range_id AND r.organisation_id = NEW.organisation_id;
    IF NOT FOUND OR v_range.loinc_code <> NEW.loinc_code OR v_range.unit IS DISTINCT FROM NEW.unit
       OR v_range.low IS DISTINCT FROM NEW.range_low OR v_range.high IS DISTINCT FROM NEW.range_high THEN
      RAISE EXCEPTION 'the range applied must be the range row named, for the same code and unit' USING ERRCODE = 'PS001';
    END IF;
    -- Bounds are inclusive: a value equal to a bound is in range.
    v_out := (NEW.range_low IS NOT NULL AND NEW.value < NEW.range_low) OR (NEW.range_high IS NOT NULL AND NEW.value > NEW.range_high);
    IF v_out <> (NEW.range_status = 'out_of_range') THEN
      RAISE EXCEPTION 'the range status must agree with the value and the bounds' USING ERRCODE = 'PS001';
    END IF;
  END IF;
  IF NEW.corrects_id IS NOT NULL THEN
    SELECT * INTO v_old FROM clinical.vital_sign v WHERE v.id = NEW.corrects_id AND v.organisation_id = NEW.organisation_id;
    IF NOT FOUND OR v_old.loinc_code <> NEW.loinc_code OR v_old.entered_in_error THEN
      RAISE EXCEPTION 'a correction names a vital of the same code that is not entered in error' USING ERRCODE = 'PS001';
    END IF;
    IF v_old.patient_id <> NEW.patient_id
       AND NOT EXISTS (SELECT 1 FROM patient.patient_merge m WHERE m.merged_id = v_old.patient_id AND m.final_survivor_id = NEW.patient_id) THEN
      RAISE EXCEPTION 'a correction belongs to the same patient or the survivor of a merge' USING ERRCODE = 'PS001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION clinical.check_vital_insert() FROM PUBLIC;
CREATE TRIGGER vital_sign_insert_check BEFORE INSERT ON clinical.vital_sign FOR EACH ROW EXECUTE FUNCTION clinical.check_vital_insert();

-- clinical.vital_range: a retired range is final; the only change is retiring ---------------------------------------------------
CREATE FUNCTION clinical.guard_vital_range() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.retired_at IS NOT NULL OR NEW.retired_by IS NOT NULL THEN
      RAISE EXCEPTION 'a range starts active' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'a retired range is final' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.loinc_code IS DISTINCT FROM OLD.loinc_code
     OR NEW.unit IS DISTINCT FROM OLD.unit OR NEW.sex IS DISTINCT FROM OLD.sex OR NEW.age_years IS DISTINCT FROM OLD.age_years
     OR NEW.low IS DISTINCT FROM OLD.low OR NEW.high IS DISTINCT FROM OLD.high OR NEW.approved_by_note IS DISTINCT FROM OLD.approved_by_note
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a range is not edited: a change is a new range and the old one retired' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status <> 'retired' OR NEW.retired_by IS NULL THEN
    RAISE EXCEPTION 'the only change to a range is retiring it, by name' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION clinical.guard_vital_range() FROM PUBLIC;
CREATE TRIGGER vital_range_guard BEFORE INSERT OR UPDATE ON clinical.vital_range FOR EACH ROW EXECUTE FUNCTION clinical.guard_vital_range();
CREATE FUNCTION clinical.refuse_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'a range is retired, never deleted' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION clinical.refuse_delete() FROM PUBLIC;
CREATE TRIGGER vital_range_no_delete BEFORE DELETE ON clinical.vital_range FOR EACH ROW EXECUTE FUNCTION clinical.refuse_delete();
