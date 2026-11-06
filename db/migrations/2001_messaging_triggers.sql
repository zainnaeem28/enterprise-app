-- migration-class: expand
-- Triggers of the messaging tables (ARCHITECTURE 21.5, 22.12, 22.16; SHARED-BOUNDARIES 9.2; ticket BE-19).
-- Invoker rights, search_path pinned to pg_catalog, schema-qualified names only, except messaging.guard_open_patient (below).
-- SQLSTATE PS001: an illegal change (a step the state machine does not allow, a write to a fixed column, a participant or assignee
-- who may not be one); PM001 / PM008: the merge write guard.
--
-- The database, not the route, decides what can change (the policies in 2002 decide who reaches a row; these decide what a row may become):
--   * a patient thread exists only while the organisation flag `patient_messaging` is on (D-5 default: off);
--   * a participant is an active principal of the SAME organisation (invisible principals of another organisation are refused),
--     a staff (google) principal on a staff thread, and on a patient thread a staff principal or the patient's own account that created it;
--   * a message is written by its author, a participant, into an open thread, under the thread's patient; it is never changed;
--   * a thread only closes (open -> closed), by one of its owners; closed is final;
--   * a task is assigned to an active staff principal of the same organisation or to a role at a location of it; it only moves
--     open -> done / cancelled, by its creator or its assignee (or a staff member at the assigned location), once.

CREATE TRIGGER thread_bump_row_version BEFORE UPDATE ON messaging.thread FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER task_bump_row_version BEFORE UPDATE ON messaging.task FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- The merge write guard (SBR-12, 9.2): a copy of patient.guard_open_patient (see privacy.guard_open_patient), moved to
-- patient_scope_owner at the end of this file so it reads the root whatever the caller's scope is. FOR KEY SHARE conflicts with the
-- merge's FOR UPDATE on the root.
CREATE FUNCTION messaging.guard_open_patient() RETURNS trigger
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
REVOKE ALL ON FUNCTION messaging.guard_open_patient() FROM PUBLIC;
CREATE TRIGGER thread_guard_open BEFORE INSERT OR UPDATE ON messaging.thread FOR EACH ROW EXECUTE FUNCTION messaging.guard_open_patient();
CREATE TRIGGER message_guard_open BEFORE INSERT OR UPDATE ON messaging.message FOR EACH ROW EXECUTE FUNCTION messaging.guard_open_patient();
CREATE TRIGGER task_guard_open BEFORE INSERT OR UPDATE ON messaging.task FOR EACH ROW EXECUTE FUNCTION messaging.guard_open_patient();

-- A message is never changed or removed; nothing in this schema is deleted except a participant row (22.12 policy).
CREATE FUNCTION messaging.refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'a message, thread or task is never changed this way' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION messaging.refuse_change() FROM PUBLIC;
CREATE TRIGGER message_append_only BEFORE UPDATE OR DELETE ON messaging.message FOR EACH ROW EXECUTE FUNCTION messaging.refuse_change();
CREATE TRIGGER thread_no_delete BEFORE DELETE ON messaging.thread FOR EACH ROW EXECUTE FUNCTION messaging.refuse_change();
CREATE TRIGGER task_no_delete BEFORE DELETE ON messaging.task FOR EACH ROW EXECUTE FUNCTION messaging.refuse_change();

-- messaging.thread ------------------------------------------------------------------------------------------------------------
CREATE FUNCTION messaging.guard_thread() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_who  uuid := kernel.uuid1('app.principal_id');
  v_sys  boolean := (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system');
  v_col  text;
  v_old  jsonb;
  v_new  jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'a thread starts open' USING ERRCODE = 'PS001';
    END IF;
    IF v_who IS NULL OR NEW.created_by IS DISTINCT FROM v_who THEN
      RAISE EXCEPTION 'a thread is created by the caller' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.kind = 'patient' AND NOT EXISTS (
         SELECT 1 FROM organisation.feature_flag f
          WHERE f.key = 'patient_messaging' AND f.location_id IS NULL AND f.enabled AND f.organisation_id = NEW.organisation_id) THEN
      RAISE EXCEPTION 'patient messaging is off' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'a closed thread is final' USING ERRCODE = 'PS001';
  END IF;
  FOREACH v_col IN ARRAY ARRAY['id', 'organisation_id', 'kind', 'subject', 'location_id', 'created_at', 'created_by'] LOOP
    IF to_jsonb(OLD) -> v_col IS DISTINCT FROM to_jsonb(NEW) -> v_col THEN
      RAISE EXCEPTION 'a thread keeps its kind, subject, location and creator' USING ERRCODE = 'PS001';
    END IF;
  END LOOP;
  v_old := to_jsonb(OLD) - 'row_version' - 'updated_at';
  v_new := to_jsonb(NEW) - 'row_version' - 'updated_at';

  -- The merge moves an open thread to the survivor and changes nothing else (22.16).
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    IF NOT v_sys THEN
      RAISE EXCEPTION 'only a merge moves a thread to another patient' USING ERRCODE = 'PS001';
    END IF;
    IF (v_old - 'patient_id') IS DISTINCT FROM (v_new - 'patient_id') THEN
      RAISE EXCEPTION 'a merge changes nothing but the patient' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'closed' THEN
    IF NOT EXISTS (SELECT 1 FROM messaging.thread_participant p
                    WHERE p.thread_id = OLD.id AND p.principal_id = v_who AND p.role = 'owner') THEN
      RAISE EXCEPTION 'a thread is closed by one of its owners' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal thread step' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION messaging.guard_thread() FROM PUBLIC;
CREATE TRIGGER thread_guard BEFORE INSERT OR UPDATE ON messaging.thread FOR EACH ROW EXECUTE FUNCTION messaging.guard_thread();

-- messaging.thread_participant -------------------------------------------------------------------------------------------------
-- The policy (2002) decides WHO may add a row (the thread's creator for the first owner row, owners for any other). This trigger
-- decides WHOM: the principal must be visible to the caller (the caller's organisation only: RLS on identity.principal hides another
-- organisation's staff, TC-MSG-02), active, and of the right realm. It runs under the caller's rights on purpose.
CREATE FUNCTION messaging.guard_participant() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_who    uuid := kernel.uuid1('app.principal_id');
  v_kind   text;
  v_creator uuid;
  v_realm  text;
  v_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.thread_id <> OLD.thread_id OR NEW.principal_id <> OLD.principal_id OR NEW.organisation_id <> OLD.organisation_id
       OR NEW.role <> OLD.role OR NEW.added_by <> OLD.added_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'a participant row changes only its read mark' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- The last owner stays: a thread nobody can administer is not allowed.
    IF OLD.role = 'owner' AND NOT EXISTS (
         SELECT 1 FROM messaging.thread_participant p
          WHERE p.thread_id = OLD.thread_id AND p.role = 'owner' AND p.principal_id <> OLD.principal_id) THEN
      RAISE EXCEPTION 'the last owner of a thread cannot be removed' USING ERRCODE = 'PS001';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.added_by IS DISTINCT FROM v_who THEN
    RAISE EXCEPTION 'a participant is added by the caller' USING ERRCODE = 'PS001';
  END IF;
  SELECT t.kind, t.created_by INTO v_kind, v_creator FROM messaging.thread t
   WHERE t.id = NEW.thread_id AND t.organisation_id = NEW.organisation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'thread not found' USING ERRCODE = '42501';
  END IF;
  IF kernel.setting('app.audience') = 'patient' THEN
    -- A patient sees no principal table (RLS): the patient is the thread's creator, and the recipients are the directory's listed, active
    -- clinicians of the organisation (identity.public_clinician, the same C0 view the patient's own screens read, 22.5.1).
    IF NOT (v_kind = 'patient' AND NEW.principal_id = v_creator)
       AND NOT EXISTS (SELECT 1 FROM identity.public_clinician c WHERE c.principal_id = NEW.principal_id AND c.organisation_id = NEW.organisation_id) THEN
      RAISE EXCEPTION 'the participant is not eligible: not an active listed clinician of this organisation' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.realm, p.status INTO v_realm, v_status FROM identity.principal p
   WHERE p.id = NEW.principal_id AND p.organisation_id = NEW.organisation_id;
  IF NOT FOUND OR v_status <> 'active' THEN
    RAISE EXCEPTION 'the participant is not an active principal of this organisation' USING ERRCODE = 'PS001';
  END IF;
  IF v_realm <> 'google' THEN
    RAISE EXCEPTION 'the participant is not eligible for this thread' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION messaging.guard_participant() FROM PUBLIC;
CREATE TRIGGER thread_participant_guard BEFORE INSERT OR UPDATE OR DELETE ON messaging.thread_participant FOR EACH ROW EXECUTE FUNCTION messaging.guard_participant();

-- messaging.message --------------------------------------------------------------------------------------------------------------
CREATE FUNCTION messaging.guard_message() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_who     uuid := kernel.uuid1('app.principal_id');
  v_status  text;
  v_patient uuid;
BEGIN
  IF NEW.author_principal_id IS DISTINCT FROM v_who THEN
    RAISE EXCEPTION 'a message is written by its author' USING ERRCODE = 'PS001';
  END IF;
  SELECT t.status, t.patient_id INTO v_status, v_patient FROM messaging.thread t
   WHERE t.id = NEW.thread_id AND t.organisation_id = NEW.organisation_id;
  IF NOT FOUND OR v_status <> 'open' THEN
    RAISE EXCEPTION 'messages are posted into an open thread' USING ERRCODE = 'PS001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM messaging.thread_participant p WHERE p.thread_id = NEW.thread_id AND p.principal_id = v_who) THEN
    RAISE EXCEPTION 'only a participant posts' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.patient_id IS DISTINCT FROM v_patient THEN
    RAISE EXCEPTION 'a message carries its thread''s patient' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION messaging.guard_message() FROM PUBLIC;
CREATE TRIGGER message_guard BEFORE INSERT ON messaging.message FOR EACH ROW EXECUTE FUNCTION messaging.guard_message();

-- messaging.task --------------------------------------------------------------------------------------------------------------
CREATE FUNCTION messaging.guard_task() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_who    uuid := kernel.uuid1('app.principal_id');
  v_sys    boolean := (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system');
  v_realm  text;
  v_status text;
  v_col    text;
  v_old    jsonb;
  v_new    jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'a task starts open' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.completed_at IS NOT NULL OR NEW.completed_by IS NOT NULL THEN
      RAISE EXCEPTION 'a new task is not completed' USING ERRCODE = 'PS001';
    END IF;
    IF v_sys THEN
      IF NEW.created_by IS NOT NULL OR NEW.created_by_job IS NULL OR NEW.source = 'manual' THEN
        RAISE EXCEPTION 'a job creates a task for its own source, under its job' USING ERRCODE = 'PS001';
      END IF;
    ELSE
      IF NEW.created_by IS DISTINCT FROM v_who OR NEW.source <> 'manual' OR NEW.created_by_job IS NOT NULL THEN
        RAISE EXCEPTION 'a staff member creates a manual task under their own name' USING ERRCODE = 'PS001';
      END IF;
    END IF;
    IF v_sys THEN
      NULL; -- a patients-scope job reads no principal (RLS); it assigns a care-team member of the patient, whom the care team already vouches for
    ELSIF NEW.assignee_kind = 'principal' THEN
      SELECT p.realm, p.status INTO v_realm, v_status FROM identity.principal p
       WHERE p.id = NEW.assignee_principal_id AND p.organisation_id = NEW.organisation_id;
      IF NOT FOUND OR v_status <> 'active' OR v_realm <> 'google' THEN
        RAISE EXCEPTION 'the assignee is not an active staff principal of this organisation' USING ERRCODE = 'PS001';
      END IF;
    ELSE
      -- A job's location comes from the patient's own care relationship and its role is a constant of the job, and the job's scope reads neither
      -- table, so only a staff member's choice is checked here.
      IF NOT v_sys AND (NOT EXISTS (SELECT 1 FROM organisation.location l WHERE l.id = NEW.assignee_location_id AND l.organisation_id = NEW.organisation_id)
         OR NOT EXISTS (SELECT 1 FROM identity.role r WHERE r.key = NEW.assignee_role_key AND r.realm = 'google' AND r.organisation_id = NEW.organisation_id)) THEN
        RAISE EXCEPTION 'the assignee role or location is not of this organisation' USING ERRCODE = 'PS001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'a done or cancelled task is final' USING ERRCODE = 'PS001';
  END IF;
  FOREACH v_col IN ARRAY ARRAY['id', 'organisation_id', 'source', 'source_ref', 'assignee_kind', 'assignee_principal_id', 'assignee_role_key', 'assignee_location_id', 'created_at', 'created_by', 'created_by_job'] LOOP
    IF to_jsonb(OLD) -> v_col IS DISTINCT FROM to_jsonb(NEW) -> v_col THEN
      RAISE EXCEPTION 'a task keeps its assignee, source and creator' USING ERRCODE = 'PS001';
    END IF;
  END LOOP;
  v_old := to_jsonb(OLD) - 'row_version' - 'updated_at';
  v_new := to_jsonb(NEW) - 'row_version' - 'updated_at';

  -- The merge moves an open task to the survivor and changes nothing else (22.16).
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    IF NOT v_sys THEN
      RAISE EXCEPTION 'only a merge moves a task to another patient' USING ERRCODE = 'PS001';
    END IF;
    IF (v_old - 'patient_id') IS DISTINCT FROM (v_new - 'patient_id') THEN
      RAISE EXCEPTION 'a merge changes nothing but the patient' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  -- Completion or cancellation: once, by the caller, recorded.
  IF NEW.status IN ('done', 'cancelled') THEN
    IF NEW.completed_by IS DISTINCT FROM v_who OR NEW.completed_at IS NULL THEN
      RAISE EXCEPTION 'a task is completed by the caller, with the time' USING ERRCODE = 'PS001';
    END IF;
    IF (v_old - 'status' - 'completed_at' - 'completed_by') IS DISTINCT FROM (v_new - 'status' - 'completed_at' - 'completed_by') THEN
      RAISE EXCEPTION 'completing a task changes nothing else' USING ERRCODE = 'PS001';
    END IF;
    -- Cancelling is the creator's; completing is the assignee's or the creator's.
    IF NEW.status = 'cancelled' AND OLD.created_by IS DISTINCT FROM v_who THEN
      RAISE EXCEPTION 'a task is cancelled by its creator' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  -- Editing an open task: title, detail and due date, by its creator only.
  IF OLD.created_by IS DISTINCT FROM v_who THEN
    RAISE EXCEPTION 'a task is edited by its creator' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status <> 'open' OR (v_old - 'title' - 'detail' - 'due_at') IS DISTINCT FROM (v_new - 'title' - 'detail' - 'due_at') THEN
    RAISE EXCEPTION 'illegal task step' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION messaging.guard_task() FROM PUBLIC;
CREATE TRIGGER task_guard BEFORE INSERT OR UPDATE ON messaging.task FOR EACH ROW EXECUTE FUNCTION messaging.guard_task();

-- The merge write guard runs as the function-owner role (see above); the CREATE right is withdrawn again.
ALTER FUNCTION messaging.guard_open_patient() OWNER TO patient_scope_owner;
REVOKE CREATE ON SCHEMA messaging FROM patient_scope_owner;
