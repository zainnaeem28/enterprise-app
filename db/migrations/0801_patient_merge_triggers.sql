-- migration-class: expand
-- Triggers of the merge tables (ARCHITECTURE 21.5, 22.16; ticket BE-09). Invoker rights, search_path pinned to pg_catalog.
-- SQLSTATE PS001 (illegal state transition) as in 0701.


CREATE TRIGGER merge_request_bump_row_version BEFORE UPDATE ON patient.merge_request FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- merge_request: requested -> approved | rejected | cancelled; approved -> executing | failed | cancelled; executing -> completed |
-- failed. completed, rejected, failed and cancelled are K (kept) states: no route or job updates them, for any role. What the
-- request is about (patients, requester, reason) never changes.
CREATE FUNCTION patient.guard_merge_request() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status IN ('completed', 'rejected', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'a % merge request accepts no change', OLD.status USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.survivor_id IS DISTINCT FROM OLD.survivor_id OR NEW.merged_id IS DISTINCT FROM OLD.merged_id
     OR NEW.requester_person_id IS DISTINCT FROM OLD.requester_person_id
     OR NEW.requester_principal_id IS DISTINCT FROM OLD.requester_principal_id
     OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'a merge request keeps its patients, requester and reason' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'approved'  AND NEW.status IN ('executing', 'failed', 'cancelled'))
    OR (OLD.status = 'executing' AND NEW.status IN ('completed', 'failed'))) THEN
    RAISE EXCEPTION 'illegal merge request transition' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.approver_person_id IS NOT NULL AND (NEW.approver_person_id IS DISTINCT FROM OLD.approver_person_id
     OR NEW.approver_principal_id IS DISTINCT FROM OLD.approver_principal_id OR NEW.decided_at IS DISTINCT FROM OLD.decided_at) THEN
    RAISE EXCEPTION 'a decision is final' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION patient.guard_merge_request() FROM PUBLIC;
CREATE TRIGGER merge_request_guard BEFORE UPDATE ON patient.merge_request FOR EACH ROW EXECUTE FUNCTION patient.guard_merge_request();

-- merge_residue is append-only (22.16: K for every row).
CREATE FUNCTION patient.refuse_residue_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'merge residue is append-only' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION patient.refuse_residue_change() FROM PUBLIC;
CREATE TRIGGER merge_residue_append_only BEFORE UPDATE OR DELETE ON patient.merge_residue FOR EACH ROW EXECUTE FUNCTION patient.refuse_residue_change();

-- The two update guards of 0701 that pin patient_id (consent, insurance_coverage) forbid the re-pointing that 22.16 requires of an R
-- row. They are replaced here with one allowance: a system job whose job_patient_ids hold BOTH the row's old patient and the new
-- one (the merge job runs with exactly the two patients and their closures, SBR-03) may change patient_id and nothing else about
-- what the row is. The new patient is still checked by the write guard (guard_open_patient), so a merged ID cannot be the target.
CREATE OR REPLACE FUNCTION patient.guard_consent() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_repoint boolean := NEW.patient_id IS DISTINCT FROM OLD.patient_id
    AND kernel.setting('app.audience') = 'system' AND kernel.setting('app.job_scope') = 'patients'
    AND OLD.patient_id = ANY (kernel.uuids('app.job_patient_ids')) AND NEW.patient_id = ANY (kernel.uuids('app.job_patient_ids'));
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR (NEW.patient_id IS DISTINCT FROM OLD.patient_id AND NOT v_repoint) OR NEW.template_key IS DISTINCT FROM OLD.template_key
     OR NEW.template_version IS DISTINCT FROM OLD.template_version THEN
    RAISE EXCEPTION 'a consent keeps its patient and template version' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status IN ('superseded', 'withdrawn') THEN
    RAISE EXCEPTION 'a % consent accepts no change', OLD.status USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'signed', 'withdrawn') THEN
    RAISE EXCEPTION 'illegal consent transition' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status = 'signed' THEN
    IF NEW.status NOT IN ('signed', 'superseded', 'withdrawn') THEN
      RAISE EXCEPTION 'illegal consent transition' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.signed_at IS DISTINCT FROM OLD.signed_at OR NEW.signer_principal_id IS DISTINCT FROM OLD.signer_principal_id
       OR NEW.signer_relationship IS DISTINCT FROM OLD.signer_relationship OR NEW.signed_name IS DISTINCT FROM OLD.signed_name
       OR NEW.signature_document_id IS DISTINCT FROM OLD.signature_document_id THEN
      RAISE EXCEPTION 'a signed consent keeps its signature' USING ERRCODE = 'PS001';
    END IF;
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'signed' THEN
    NEW.signed_at := now();
  END IF;
  IF NEW.status = 'withdrawn' AND OLD.status <> 'withdrawn' THEN
    NEW.withdrawn_at := now();
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION patient.guard_insurance() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_changed_result boolean := NEW.eligibility_status IS DISTINCT FROM OLD.eligibility_status
    OR NEW.verified_at IS DISTINCT FROM OLD.verified_at OR NEW.verified_by IS DISTINCT FROM OLD.verified_by;
  v_repoint boolean := NEW.patient_id IS DISTINCT FROM OLD.patient_id
    AND kernel.setting('app.audience') = 'system' AND kernel.setting('app.job_scope') = 'patients'
    AND OLD.patient_id = ANY (kernel.uuids('app.job_patient_ids')) AND NEW.patient_id = ANY (kernel.uuids('app.job_patient_ids'));
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR (NEW.patient_id IS DISTINCT FROM OLD.patient_id AND NOT v_repoint) THEN
    RAISE EXCEPTION 'a coverage keeps its patient' USING ERRCODE = 'PS001';
  END IF;
  IF v_changed_result AND coalesce(kernel.setting('app.audience'), '') NOT IN ('staff', 'system') THEN
    RAISE EXCEPTION 'only staff record an eligibility result' USING ERRCODE = '42501';
  END IF;
  IF NOT v_changed_result AND (NEW.payer_name IS DISTINCT FROM OLD.payer_name OR NEW.member_id IS DISTINCT FROM OLD.member_id
       OR NEW.group_number IS DISTINCT FROM OLD.group_number) AND OLD.eligibility_status <> 'unknown' THEN
    NEW.eligibility_status := 'unknown';
    NEW.verified_at := NULL;
    NEW.verified_by := NULL;
  END IF;
  RETURN NEW;
END
$$;
