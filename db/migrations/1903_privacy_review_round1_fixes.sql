-- migration-class: expand
-- Corrections after backend review round 1 (ticket BE-20).
--   BE20-F2: refusing an export or access request fails its assembling package in the same transaction (compliance may take
--            that one step, only with the code privacy.request_refused and only once the request is refused).
--   BE20-F1: a closed incident is final for its patient links too: no link is added to or changed on a closed incident.

CREATE OR REPLACE FUNCTION privacy.guard_export_package() RETURNS trigger
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
  -- BE20-F2: refusing a request closes its live assembly. Compliance (admin realm) may fail an assembling package, with this code
  -- only and only once the request itself is refused; nothing else in the row changes.
  IF OLD.status = 'assembling' AND NEW.status = 'failed' AND NOT v_sys THEN
    IF kernel.setting('app.audience') = 'staff' AND kernel.setting('app.realm') = 'admin_pool'
       AND NEW.failure_code = 'privacy.request_refused'
       AND (v_old - 'status' - 'failure_code') IS NOT DISTINCT FROM (v_new - 'status' - 'failure_code')
       AND EXISTS (SELECT 1 FROM privacy.request r WHERE r.id = NEW.request_id AND r.organisation_id = NEW.organisation_id AND r.status = 'refused') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'only the worker finishes an assembly' USING ERRCODE = 'PS001';
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

GRANT UPDATE (failure_code) ON privacy.export_package TO app_api;
CREATE POLICY package_slice_update ON privacy.export_package
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'privacy_requests' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')) AND status = 'assembling')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited' AND 'privacy_requests' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')) AND status = 'failed');

CREATE OR REPLACE FUNCTION privacy.guard_incident_patient() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.incident_id <> OLD.incident_id OR NEW.patient_id <> OLD.patient_id OR NEW.organisation_id <> OLD.organisation_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'a link keeps its incident and patient' USING ERRCODE = 'PS001';
    END IF;
    IF NOT (NEW.audit_event_ids @> OLD.audit_event_ids) THEN
      RAISE EXCEPTION 'audit events are only added to a link' USING ERRCODE = 'PS001';
    END IF;
  END IF;
  SELECT i.status INTO v_status FROM privacy.incident i WHERE i.id = NEW.incident_id FOR SHARE;
  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'a closed incident is final' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION privacy.guard_incident_patient() FROM PUBLIC;
DROP TRIGGER incident_patient_guard ON privacy.incident_patient;
CREATE TRIGGER incident_patient_guard BEFORE INSERT OR UPDATE ON privacy.incident_patient FOR EACH ROW EXECUTE FUNCTION privacy.guard_incident_patient();
