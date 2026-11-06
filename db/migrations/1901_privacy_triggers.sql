-- migration-class: expand
-- Triggers of the privacy tables (ARCHITECTURE 21.5, 22.14, 22.16, 23.1 ST-06; SHARED-BOUNDARIES 6.7, 9.2; ticket BE-20).
-- Invoker rights, search_path pinned to pg_catalog, schema-qualified names only, except privacy.guard_open_patient (below).
-- SQLSTATE PS001: an illegal change (a step the state machine does not allow, a write to a fixed column, a step by someone who may
-- not take it); PM001 / PM008: the merge write guard.
--
-- The database, not the route, decides what can change:
--   * a request is verified once, by a compliance user (admin realm), and only then can it be approved; a decision is taken by a compliance
--     user (admin realm); the worker alone completes an export request (fulfilled) and alone writes the legal-hold check;
--   * a `fulfilled` or `refused` request is final; a deletion request never leaves `blocked_d8` except to `refused` (D-8, and the CHECK in 1900);
--   * a package is created `assembling`; only the worker makes it `ready` or `failed`; only the patient it belongs to releases it, and only
--     while it has not expired; `failed` and `expired` are final;
--   * an incident only moves forward and is final once closed; the patients of an incident only ever gain audit events.

CREATE TRIGGER request_bump_row_version BEFORE UPDATE ON privacy.request FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER export_package_bump_row_version BEFORE UPDATE ON privacy.export_package FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER incident_bump_row_version BEFORE UPDATE ON privacy.incident FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- The merge write guard (SBR-12, 9.2): a copy of patient.guard_open_patient (see documents.guard_open_patient), moved to
-- patient_scope_owner at the end of this file so it reads the root whatever the caller's scope is. FOR KEY SHARE conflicts with the
-- merge's FOR UPDATE on the root. privacy.incident_patient is exempt (it records history).
CREATE FUNCTION privacy.guard_open_patient() RETURNS trigger
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
REVOKE ALL ON FUNCTION privacy.guard_open_patient() FROM PUBLIC;
CREATE TRIGGER request_guard_open BEFORE INSERT OR UPDATE ON privacy.request FOR EACH ROW EXECUTE FUNCTION privacy.guard_open_patient();
CREATE TRIGGER export_package_guard_open BEFORE INSERT OR UPDATE ON privacy.export_package FOR EACH ROW EXECUTE FUNCTION privacy.guard_open_patient();

-- Nothing in this schema is ever deleted: the register and the requests are records.
CREATE FUNCTION privacy.refuse_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'a privacy record is never deleted' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION privacy.refuse_delete() FROM PUBLIC;
CREATE TRIGGER request_no_delete BEFORE DELETE ON privacy.request FOR EACH ROW EXECUTE FUNCTION privacy.refuse_delete();
CREATE TRIGGER export_package_no_delete BEFORE DELETE ON privacy.export_package FOR EACH ROW EXECUTE FUNCTION privacy.refuse_delete();
CREATE TRIGGER incident_no_delete BEFORE DELETE ON privacy.incident FOR EACH ROW EXECUTE FUNCTION privacy.refuse_delete();
CREATE TRIGGER incident_patient_no_delete BEFORE DELETE ON privacy.incident_patient FOR EACH ROW EXECUTE FUNCTION privacy.refuse_delete();

-- privacy.request -------------------------------------------------------------------------------------------------------------
CREATE FUNCTION privacy.guard_request() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_who     uuid := kernel.uuid1('app.principal_id');
  v_person  uuid := kernel.uuid1('app.person_id');
  v_aud     text := kernel.setting('app.audience');
  v_admin   boolean := (kernel.setting('app.audience') = 'staff' AND kernel.setting('app.realm') = 'admin_pool');
  v_sys     boolean := (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system');
  v_col     text;
  v_old     jsonb;
  v_new     jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> (CASE WHEN NEW.kind = 'deletion' THEN 'blocked_d8' ELSE 'received' END) THEN
      RAISE EXCEPTION 'a request starts received (a deletion request starts blocked_d8)' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.verification_method IS NOT NULL OR NEW.decided_by_person_id IS NOT NULL OR NEW.legal_hold_checked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new request has no verification, decision or hold check' USING ERRCODE = 'PS001';
    END IF;
    IF v_who IS NOT NULL AND NEW.requested_by_principal_id <> v_who THEN
      RAISE EXCEPTION 'a request is recorded under the caller' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('fulfilled', 'refused') THEN
    RAISE EXCEPTION 'a fulfilled or refused request is final' USING ERRCODE = 'PS001';
  END IF;
  FOREACH v_col IN ARRAY ARRAY['id', 'organisation_id', 'kind', 'requested_by_principal_id', 'channel', 'detail', 'due_at', 'created_at', 'created_by'] LOOP
    IF to_jsonb(OLD) -> v_col IS DISTINCT FROM to_jsonb(NEW) -> v_col THEN
      RAISE EXCEPTION 'a request keeps its kind, requester, channel and due date' USING ERRCODE = 'PS001';
    END IF;
  END LOOP;
  v_old := to_jsonb(OLD) - 'row_version' - 'updated_at';
  v_new := to_jsonb(NEW) - 'row_version' - 'updated_at';

  -- The merge moves a request that is not final to the survivor and changes nothing else (22.16).
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    IF NOT v_sys THEN
      RAISE EXCEPTION 'only a merge moves a request to another patient' USING ERRCODE = 'PS001';
    END IF;
    IF (v_old - 'patient_id') IS DISTINCT FROM (v_new - 'patient_id') THEN
      RAISE EXCEPTION 'a merge changes nothing but the patient' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  -- The legal-hold check: the worker writes these two columns and nothing else in the same statement.
  IF NEW.legal_hold_documents IS DISTINCT FROM OLD.legal_hold_documents OR NEW.legal_hold_checked_at IS DISTINCT FROM OLD.legal_hold_checked_at THEN
    IF NOT v_sys THEN
      RAISE EXCEPTION 'only the system records the legal-hold check' USING ERRCODE = 'PS001';
    END IF;
    IF (v_old - 'legal_hold_documents' - 'legal_hold_checked_at') IS DISTINCT FROM (v_new - 'legal_hold_documents' - 'legal_hold_checked_at') THEN
      RAISE EXCEPTION 'a hold check changes nothing else' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  -- Identity verification: once, by compliance (admin realm), for the caller's own person. A deletion request keeps blocked_d8.
  IF OLD.verified_at IS NULL AND NEW.verified_at IS NOT NULL THEN
    IF NOT v_admin OR NEW.verified_by_person_id IS DISTINCT FROM v_person THEN
      RAISE EXCEPTION 'identity is verified by compliance, under the caller' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.decided_by_person_id IS NOT NULL OR NEW.decision_reason IS NOT NULL THEN
      RAISE EXCEPTION 'verifying identity decides nothing' USING ERRCODE = 'PS001';
    END IF;
    IF NOT ((OLD.status = 'received' AND NEW.status = 'identity_verified' AND OLD.kind <> 'deletion')
         OR (OLD.status = 'blocked_d8' AND NEW.status = 'blocked_d8')) THEN
      RAISE EXCEPTION 'illegal verification step' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.verified_at IS DISTINCT FROM OLD.verified_at OR NEW.verification_method IS DISTINCT FROM OLD.verification_method
     OR NEW.verified_by_person_id IS DISTINCT FROM OLD.verified_by_person_id THEN
    RAISE EXCEPTION 'identity is verified once' USING ERRCODE = 'PS001';
  END IF;

  -- Decisions: refuse (any live request, with a reason), approve (identity_verified -> in_progress), complete (in_progress -> fulfilled).
  IF NEW.status = 'refused' THEN
    IF NOT v_admin OR NEW.decided_by_person_id IS DISTINCT FROM v_person THEN
      RAISE EXCEPTION 'a request is refused by compliance, under the caller' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'identity_verified' AND NEW.status = 'in_progress' THEN
    IF NOT v_admin OR NEW.decided_by_person_id IS DISTINCT FROM v_person OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason THEN
      RAISE EXCEPTION 'a request is approved by compliance, under the caller' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'in_progress' AND NEW.status = 'fulfilled' THEN
    IF NOT (v_sys OR v_admin) THEN
      RAISE EXCEPTION 'a request is completed by the system or by compliance' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.decided_by_person_id IS DISTINCT FROM OLD.decided_by_person_id OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'completing a request keeps its decision' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal request step' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION privacy.guard_request() FROM PUBLIC;
CREATE TRIGGER request_guard BEFORE INSERT OR UPDATE ON privacy.request FOR EACH ROW EXECUTE FUNCTION privacy.guard_request();

-- privacy.export_package ------------------------------------------------------------------------------------------------------
CREATE FUNCTION privacy.guard_export_package() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_sys   boolean := (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system');
  v_pat   boolean := (kernel.setting('app.audience') = 'patient');
  v_col   text;
  v_old   jsonb;
  v_new   jsonb;
  v_req   privacy.request%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'assembling' THEN
      RAISE EXCEPTION 'a package starts assembling' USING ERRCODE = 'PS001';
    END IF;
    SELECT * INTO v_req FROM privacy.request r WHERE r.id = NEW.request_id AND r.organisation_id = NEW.organisation_id;
    IF NOT FOUND OR v_req.status <> 'in_progress' OR v_req.kind NOT IN ('access', 'export') OR v_req.patient_id <> NEW.patient_id THEN
      RAISE EXCEPTION 'a package belongs to an approved export or access request of the same patient' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('failed', 'expired') THEN
    RAISE EXCEPTION 'a failed or expired package is final' USING ERRCODE = 'PS001';
  END IF;
  FOREACH v_col IN ARRAY ARRAY['id', 'organisation_id', 'request_id', 'created_at', 'created_by'] LOOP
    IF to_jsonb(OLD) -> v_col IS DISTINCT FROM to_jsonb(NEW) -> v_col THEN
      RAISE EXCEPTION 'a package keeps its identity and request' USING ERRCODE = 'PS001';
    END IF;
  END LOOP;
  v_old := to_jsonb(OLD) - 'row_version' - 'updated_at';
  v_new := to_jsonb(NEW) - 'row_version' - 'updated_at';

  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    IF NOT v_sys THEN
      RAISE EXCEPTION 'only a merge moves a package to another patient' USING ERRCODE = 'PS001';
    END IF;
    IF (v_old - 'patient_id') IS DISTINCT FROM (v_new - 'patient_id') THEN
      RAISE EXCEPTION 'a merge changes nothing but the patient' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  -- Progress while assembling: the counts only.
  IF OLD.status = 'assembling' AND NEW.status = 'assembling' THEN
    IF NOT v_sys OR (v_old - 'part_counts') IS DISTINCT FROM (v_new - 'part_counts') THEN
      RAISE EXCEPTION 'assembly progress is the worker''s, and only the counts' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'assembling' AND NEW.status IN ('ready', 'failed') THEN
    IF NOT v_sys THEN
      RAISE EXCEPTION 'only the worker finishes an assembly' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  -- The patient takes the package once (released), before it expires; it stays released for further downloads until it expires.
  IF OLD.status = 'ready' AND NEW.status = 'released' THEN
    IF NOT v_pat OR OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'a package is released to its patient while it is live' USING ERRCODE = 'PS001';
    END IF;
    IF (v_old - 'status' - 'released_at') IS DISTINCT FROM (v_new - 'status' - 'released_at') THEN
      RAISE EXCEPTION 'releasing a package changes nothing else' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('ready', 'released') AND NEW.status = 'expired' THEN
    IF NOT v_sys THEN
      RAISE EXCEPTION 'only the expiry job expires a package' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal package step' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION privacy.guard_export_package() FROM PUBLIC;
CREATE TRIGGER export_package_guard BEFORE INSERT OR UPDATE ON privacy.export_package FOR EACH ROW EXECUTE FUNCTION privacy.guard_export_package();

-- privacy.incident ------------------------------------------------------------------------------------------------------------
CREATE FUNCTION privacy.guard_incident() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_rank_old int;
  v_rank_new int;
  v_col text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'an incident starts open' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'a closed incident is final' USING ERRCODE = 'PS001';
  END IF;
  FOREACH v_col IN ARRAY ARRAY['id', 'organisation_id', 'discovered_at', 'created_at', 'created_by'] LOOP
    IF to_jsonb(OLD) -> v_col IS DISTINCT FROM to_jsonb(NEW) -> v_col THEN
      RAISE EXCEPTION 'an incident keeps its identity and discovery time' USING ERRCODE = 'PS001';
    END IF;
  END LOOP;
  v_rank_old := array_position(ARRAY['open', 'investigating', 'notified', 'closed'], OLD.status);
  v_rank_new := array_position(ARRAY['open', 'investigating', 'notified', 'closed'], NEW.status);
  IF v_rank_new < v_rank_old THEN
    RAISE EXCEPTION 'an incident only moves forward' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION privacy.guard_incident() FROM PUBLIC;
CREATE TRIGGER incident_guard BEFORE INSERT OR UPDATE ON privacy.incident FOR EACH ROW EXECUTE FUNCTION privacy.guard_incident();

-- privacy.incident_patient: the patient and the incident are fixed; events are only added ----------------------------------------
CREATE FUNCTION privacy.guard_incident_patient() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.incident_id <> OLD.incident_id OR NEW.patient_id <> OLD.patient_id OR NEW.organisation_id <> OLD.organisation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a link keeps its incident and patient' USING ERRCODE = 'PS001';
  END IF;
  IF NOT (NEW.audit_event_ids @> OLD.audit_event_ids) THEN
    RAISE EXCEPTION 'audit events are only added to a link' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION privacy.guard_incident_patient() FROM PUBLIC;
CREATE TRIGGER incident_patient_guard BEFORE UPDATE ON privacy.incident_patient FOR EACH ROW EXECUTE FUNCTION privacy.guard_incident_patient();

-- The merge write guard runs as the function-owner role (see above); the CREATE right is withdrawn again.
ALTER FUNCTION privacy.guard_open_patient() OWNER TO patient_scope_owner;
REVOKE CREATE ON SCHEMA privacy FROM patient_scope_owner;
