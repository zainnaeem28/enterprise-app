-- migration-class: expand
-- Triggers of the clinical front-door tables (ARCHITECTURE 21.5, 22.11, 22.16, 25.5; SHARED-BOUNDARIES 9.2; ticket BE-18).
-- Invoker rights, search_path pinned to pg_catalog, schema-qualified names only, except clinical.frontdoor_guard_open_patient (below).
-- SQLSTATE PS001: an illegal change (a write to a kept or fixed column, a step the state machine does not allow, a write by the
-- wrong side of a referral); PM001 / PM008: the merge write guard.
--
-- The database, not the route, decides what can change: a submitted questionnaire response is final; a triage assessment and a
-- consent exception are never updated or deleted; a referral moves only draft -> sent -> accepted | declined -> completed (or is
-- cancelled before it is decided), by the side that owns the step; a follow-up moves only open -> booked -> done | cancelled.

-- Needed only to move the merge write guard's ownership to the function-owner role (end of this file); withdrawn again there.
GRANT CREATE ON SCHEMA clinical TO patient_scope_owner;

CREATE TRIGGER questionnaire_response_bump_row_version BEFORE UPDATE ON clinical.questionnaire_response FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER referral_bump_row_version BEFORE UPDATE ON clinical.referral FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER referral_inbox_bump_row_version BEFORE UPDATE ON clinical.referral_inbox FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER follow_up_bump_row_version BEFORE UPDATE ON clinical.follow_up FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- The merge write guard (SBR-12, 9.2). Same refusal as patient.guard_open_patient and clinical.guard_open_patient (a copy: those are
-- owned by patient_scope_owner with EXECUTE revoked from PUBLIC, so the migration role cannot attach them; BE-11 departure D1). It
-- is moved to patient_scope_owner at the end of this file, so it reads the root whatever the caller's scope is, and it takes FOR KEY
-- SHARE, which conflicts with the merge's FOR UPDATE on the root.
CREATE FUNCTION clinical.frontdoor_guard_open_patient() RETURNS trigger
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
REVOKE ALL ON FUNCTION clinical.frontdoor_guard_open_patient() FROM PUBLIC;
CREATE TRIGGER questionnaire_response_guard_open BEFORE INSERT OR UPDATE ON clinical.questionnaire_response FOR EACH ROW EXECUTE FUNCTION clinical.frontdoor_guard_open_patient();
CREATE TRIGGER triage_assessment_guard_open BEFORE INSERT OR UPDATE ON clinical.triage_assessment FOR EACH ROW EXECUTE FUNCTION clinical.frontdoor_guard_open_patient();
CREATE TRIGGER referral_guard_open BEFORE INSERT OR UPDATE ON clinical.referral FOR EACH ROW EXECUTE FUNCTION clinical.frontdoor_guard_open_patient();
CREATE TRIGGER consent_exception_guard_open BEFORE INSERT OR UPDATE ON clinical.consent_exception FOR EACH ROW EXECUTE FUNCTION clinical.frontdoor_guard_open_patient();
CREATE TRIGGER follow_up_guard_open BEFORE INSERT OR UPDATE ON clinical.follow_up FOR EACH ROW EXECUTE FUNCTION clinical.frontdoor_guard_open_patient();

-- Append-only tables: a later change is a new row ----------------------------------------------------------------------------
CREATE FUNCTION clinical.frontdoor_refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'append-only: a later change is a new row' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION clinical.frontdoor_refuse_change() FROM PUBLIC;
CREATE TRIGGER triage_assessment_append_only BEFORE UPDATE OR DELETE ON clinical.triage_assessment FOR EACH ROW EXECUTE FUNCTION clinical.frontdoor_refuse_change();
CREATE TRIGGER consent_exception_append_only BEFORE UPDATE OR DELETE ON clinical.consent_exception FOR EACH ROW EXECUTE FUNCTION clinical.frontdoor_refuse_change();

-- No row of these tables is ever deleted: the record stays (SHARED-BOUNDARIES: no hard delete of clinical data).
CREATE FUNCTION clinical.frontdoor_refuse_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'a clinical front-door record is never deleted' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION clinical.frontdoor_refuse_delete() FROM PUBLIC;
CREATE TRIGGER questionnaire_response_no_delete BEFORE DELETE ON clinical.questionnaire_response FOR EACH ROW EXECUTE FUNCTION clinical.frontdoor_refuse_delete();
CREATE TRIGGER referral_no_delete BEFORE DELETE ON clinical.referral FOR EACH ROW EXECUTE FUNCTION clinical.frontdoor_refuse_delete();
CREATE TRIGGER referral_inbox_no_delete BEFORE DELETE ON clinical.referral_inbox FOR EACH ROW EXECUTE FUNCTION clinical.frontdoor_refuse_delete();
CREATE TRIGGER follow_up_no_delete BEFORE DELETE ON clinical.follow_up FOR EACH ROW EXECUTE FUNCTION clinical.frontdoor_refuse_delete();

-- questionnaire_response -----------------------------------------------------------------------------------------------------
-- A response starts in progress with no red flag; it changes only while in progress (answers, then the submit that stamps the time
-- and the red flag computed from the template's rules); a submitted response is final (22.11 refuse_update_when_terminal('submitted'),
-- merge class K). Only a system job (the merge) moves a response to another patient.
CREATE FUNCTION clinical.guard_questionnaire_response() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'in_progress' OR NEW.red_flag OR NEW.submitted_at IS NOT NULL THEN
      RAISE EXCEPTION 'a response starts in progress' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'submitted' THEN
    RAISE EXCEPTION 'a submitted response is final' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id OR NEW.template_key IS DISTINCT FROM OLD.template_key
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a response keeps its identity, visit and template' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id
     AND NOT (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system') THEN
    RAISE EXCEPTION 'only a merge moves a response to another patient' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status = 'in_progress' AND (NEW.red_flag OR NEW.submitted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'only a submitted response carries a red flag' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION clinical.guard_questionnaire_response() FROM PUBLIC;
CREATE TRIGGER questionnaire_response_guard BEFORE INSERT OR UPDATE ON clinical.questionnaire_response FOR EACH ROW EXECUTE FUNCTION clinical.guard_questionnaire_response();

-- triage_assessment: the chain of a check-in --------------------------------------------------------------------------------
-- A re-triage names the assessment it supersedes: same check-in, same patient, same place. The unique indexes make the chain
-- linear (one first triage per check-in; an assessment is superseded at most once). A red flag names its alert.
CREATE FUNCTION clinical.check_triage_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_prev clinical.triage_assessment%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO v_prev FROM clinical.triage_assessment t WHERE t.id = NEW.supersedes_id AND t.organisation_id = NEW.organisation_id;
    IF NOT FOUND OR v_prev.check_in_id <> NEW.check_in_id OR v_prev.patient_id <> NEW.patient_id OR v_prev.location_id <> NEW.location_id THEN
      RAISE EXCEPTION 'a re-triage supersedes an assessment of the same check-in' USING ERRCODE = 'PS001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION clinical.check_triage_insert() FROM PUBLIC;
CREATE TRIGGER triage_assessment_insert_check BEFORE INSERT ON clinical.triage_assessment FOR EACH ROW EXECUTE FUNCTION clinical.check_triage_insert();

-- referral: the state machine and the side that owns each step ------------------------------------------------------------
--   draft     -> draft (edit), sent, cancelled          the sending side: staff of from_location_id
--   sent      -> accepted, declined                     the receiving side: staff of target_location_id (internal only)
--   sent      -> cancelled                              the sending side
--   accepted  -> completed                              the receiving side
--   an external referral has no receiving side in this system: draft -> sent -> completed | cancelled, all by the sending side.
-- declined, completed and cancelled are final (K). Once sent, the target, the reason and the sender are fixed (22.11: a sent
-- referral's target columns cannot change). A system job (the merge) changes only the patient, and only in R states.
CREATE FUNCTION clinical.guard_referral() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_system boolean;
  v_from   boolean;
  v_to     boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a referral starts as a draft' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  v_system := (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system');
  v_from := OLD.from_location_id = ANY (kernel.uuids('app.location_ids'));
  v_to := OLD.target_location_id IS NOT NULL AND OLD.target_location_id = ANY (kernel.uuids('app.location_ids'));
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.from_location_id IS DISTINCT FROM OLD.from_location_id OR NEW.from_principal_id IS DISTINCT FROM OLD.from_principal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a referral keeps its identity and referrer' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status IN ('declined', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'a decided or closed referral is final' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    IF NOT v_system THEN
      RAISE EXCEPTION 'only a merge moves a referral to another patient' USING ERRCODE = 'PS001';
    END IF;
    IF (to_jsonb(NEW) - 'patient_id' - 'row_version' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'patient_id' - 'row_version' - 'updated_at') THEN
      RAISE EXCEPTION 'a merge changes only the patient' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF v_system THEN
    RAISE EXCEPTION 'a job changes a referral only to merge it' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    RAISE EXCEPTION 'a referral keeps its patient' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.target_kind IS DISTINCT FROM OLD.target_kind OR NEW.target_location_id IS DISTINCT FROM OLD.target_location_id
     OR NEW.target_service_id IS DISTINCT FROM OLD.target_service_id OR NEW.target_external_text IS DISTINCT FROM OLD.target_external_text
     OR NEW.reason IS DISTINCT FROM OLD.reason) THEN
    RAISE EXCEPTION 'a sent referral keeps its target and reason' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NOT v_from THEN
      RAISE EXCEPTION 'a draft referral is changed by the sending location' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.status NOT IN ('draft', 'sent', 'cancelled') OR NEW.decided_by IS NOT NULL OR NEW.decline_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a draft is sent or cancelled' USING ERRCODE = 'PS001';
    END IF;
  ELSIF OLD.status = 'sent' THEN
    IF NEW.status = 'cancelled' THEN
      IF NOT v_from THEN RAISE EXCEPTION 'a sent referral is cancelled by the sending location' USING ERRCODE = 'PS001'; END IF;
    ELSIF NEW.status IN ('accepted', 'declined') THEN
      IF OLD.target_kind = 'external' OR NOT v_to THEN
        RAISE EXCEPTION 'a sent referral is decided by the receiving location' USING ERRCODE = 'PS001';
      END IF;
    ELSIF NEW.status = 'completed' THEN
      IF OLD.target_kind <> 'external' OR NOT v_from THEN
        RAISE EXCEPTION 'only an external referral is completed from sent, by the sending location' USING ERRCODE = 'PS001';
      END IF;
    ELSE
      RAISE EXCEPTION 'a sent referral is accepted, declined, completed or cancelled' USING ERRCODE = 'PS001';
    END IF;
  ELSIF OLD.status = 'accepted' THEN
    IF NEW.status <> 'completed' OR NOT v_to THEN
      RAISE EXCEPTION 'an accepted referral is completed by the receiving location' USING ERRCODE = 'PS001';
    END IF;
  END IF;
  IF NEW.status IN ('accepted', 'declined') AND NEW.decided_by IS DISTINCT FROM (SELECT kernel.uuid1('app.principal_id')) THEN
    RAISE EXCEPTION 'the decision names the caller' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION clinical.guard_referral() FROM PUBLIC;
CREATE TRIGGER referral_guard BEFORE INSERT OR UPDATE ON clinical.referral FOR EACH ROW EXECUTE FUNCTION clinical.guard_referral();

-- A sent referral to a location of this organisation needs that location to exist and offer the service (the route checks the
-- service through organisation, 422 clinical.referral_target_invalid; the foreign keys of 1700 hold the rest).

-- referral_inbox: pending -> accepted | declined, by the receiving location; nothing else changes ------------------------
CREATE FUNCTION clinical.guard_referral_inbox() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'an inbox row starts pending' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a decided inbox row is final' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status NOT IN ('accepted', 'declined') OR NEW.decided_at IS NULL
     OR NEW.referral_id IS DISTINCT FROM OLD.referral_id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.target_location_id IS DISTINCT FROM OLD.target_location_id OR NEW.patient_label_ref IS DISTINCT FROM OLD.patient_label_ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'an inbox row is only accepted or declined' USING ERRCODE = 'PS001';
  END IF;
  IF NOT (OLD.target_location_id = ANY (kernel.uuids('app.location_ids'))) THEN
    RAISE EXCEPTION 'an inbox row is decided by the receiving location' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION clinical.guard_referral_inbox() FROM PUBLIC;
CREATE TRIGGER referral_inbox_guard BEFORE INSERT OR UPDATE ON clinical.referral_inbox FOR EACH ROW EXECUTE FUNCTION clinical.guard_referral_inbox();

-- follow_up: open -> booked -> done | cancelled; a booked follow-up whose visit was cancelled returns to open --------------
CREATE FUNCTION clinical.guard_follow_up() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_system boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.booked_reservation_id IS NOT NULL OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a follow-up starts open' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  v_system := (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system');
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a follow-up keeps its identity, place and requester' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status IN ('done', 'cancelled') THEN
    RAISE EXCEPTION 'a closed follow-up is final' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    IF NOT v_system THEN
      RAISE EXCEPTION 'only a merge moves a follow-up to another patient' USING ERRCODE = 'PS001';
    END IF;
    IF (to_jsonb(NEW) - 'patient_id' - 'row_version' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'patient_id' - 'row_version' - 'updated_at') THEN
      RAISE EXCEPTION 'a merge changes only the patient' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF v_system THEN
    RAISE EXCEPTION 'a job changes a follow-up only to merge it' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status = 'open' AND NEW.status NOT IN ('open', 'booked', 'done', 'cancelled') THEN
    RAISE EXCEPTION 'illegal follow-up step' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status = 'booked' AND NEW.status NOT IN ('booked', 'open', 'done', 'cancelled') THEN
    RAISE EXCEPTION 'illegal follow-up step' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION clinical.guard_follow_up() FROM PUBLIC;
CREATE TRIGGER follow_up_guard BEFORE INSERT OR UPDATE ON clinical.follow_up FOR EACH ROW EXECUTE FUNCTION clinical.guard_follow_up();

-- The merge write guard runs as the function-owner role (see above); the CREATE right is withdrawn again.
ALTER FUNCTION clinical.frontdoor_guard_open_patient() OWNER TO patient_scope_owner;
REVOKE CREATE ON SCHEMA clinical FROM patient_scope_owner;
