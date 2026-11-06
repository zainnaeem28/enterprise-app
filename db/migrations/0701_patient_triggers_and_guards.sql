-- migration-class: expand
-- Triggers of the patient tables and the merge write guard (ARCHITECTURE 21.5, 22.6, SHARED-BOUNDARIES 9.2; ticket BE-08).
-- Invoker-rights, search_path pinned to pg_catalog, schema-qualified names only, except guard_open_patient, which is the
-- inventory's one trigger-shaped definer function (6.2). SQLSTATEs: PM001 merged patient, PS001 illegal state transition.

-- row_version / updated_at (21.5) on every mutable patient table.
CREATE TRIGGER patient_bump_row_version BEFORE UPDATE ON patient.patient FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER patient_contact_bump_row_version BEFORE UPDATE ON patient.patient_contact FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER insurance_coverage_bump_row_version BEFORE UPDATE ON patient.insurance_coverage FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER consent_bump_row_version BEFORE UPDATE ON patient.consent FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER communication_preference_bump_row_version BEFORE UPDATE ON patient.communication_preference FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER care_relationship_bump_row_version BEFORE UPDATE ON patient.care_relationship FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER care_team_member_bump_row_version BEFORE UPDATE ON patient.care_team_member FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER duplicate_flag_bump_row_version BEFORE UPDATE ON patient.duplicate_flag FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- The merge write guard (SBR-12; 9.2). Reads the root row of NEW.patient_id with FOR KEY SHARE and refuses the write when
-- that patient is merged. The lock conflicts with the merge's FOR UPDATE, so a writer racing a merge waits and is then
-- refused. The function runs as its owner (patient_scope_owner, set in 0702) so that it sees the root whatever the caller's
-- scope is: a stale session cannot hide the merged state from it. It returns nothing about the patient: not found is
-- a root it cannot read refuses the write (below).
CREATE FUNCTION patient.guard_open_patient() RETURNS trigger
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
  -- A transaction with no organisation, an organisation other than the row's, or an audience that may not touch patient data is
  -- refused as a privilege failure before any lookup, the same refusal the row-level policies of the written table would give.
  IF (SELECT kernel.setting('app.audience')) IS NULL
     OR (SELECT kernel.setting('app.audience')) NOT IN ('patient', 'staff', 'system')
     OR (SELECT kernel.uuid1('app.org_id')) IS DISTINCT FROM NEW.organisation_id THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  SELECT p.status INTO v_status FROM patient.patient p WHERE p.id = NEW.patient_id FOR KEY SHARE;
  IF NOT FOUND THEN
    -- The root does not exist in this organisation (the context above is already allowed to read it). A guard that cannot find
    -- the root cannot say the patient is open, so the write is refused.
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  IF v_status = 'merged' THEN
    RAISE EXCEPTION 'patient.merged' USING ERRCODE = 'PM001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION patient.guard_open_patient() FROM PUBLIC;

-- Every table with a patient_id column except the exempt ones (audit tables, staff_scope, patient_merge, the root itself).
-- patient.match_check has no patient_id column. The tables of identity and notifications were created before this guard
-- existed; their owners recorded that this ticket attaches it (identity 0502, notifications README NOT-N4).
CREATE TRIGGER patient_contact_guard_open BEFORE INSERT OR UPDATE ON patient.patient_contact FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER insurance_coverage_guard_open BEFORE INSERT OR UPDATE ON patient.insurance_coverage FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER consent_guard_open BEFORE INSERT OR UPDATE ON patient.consent FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER communication_preference_guard_open BEFORE INSERT OR UPDATE ON patient.communication_preference FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER care_relationship_guard_open BEFORE INSERT OR UPDATE ON patient.care_relationship FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER care_team_member_guard_open BEFORE INSERT OR UPDATE ON patient.care_team_member FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER duplicate_flag_guard_open BEFORE INSERT OR UPDATE ON patient.duplicate_flag FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER patient_link_guard_open BEFORE INSERT OR UPDATE ON identity.patient_link FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER proxy_grant_guard_open BEFORE INSERT OR UPDATE ON identity.proxy_grant FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER notification_guard_open BEFORE INSERT OR UPDATE ON notifications.notification FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER delivery_receipt_guard_open BEFORE INSERT OR UPDATE ON notifications.delivery_receipt FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();
CREATE TRIGGER in_app_read_guard_open BEFORE INSERT OR UPDATE ON notifications.in_app_read FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();

-- patient.guard_merged_root (21.5): any update of a merged root is refused. complete_merge sets status as its last write,
-- so OLD.status is still 'active' for that update. The identifying columns never change; status and merged_into change
-- once, together, from active to merged (the column grants also confine that to patient_scope_owner).
CREATE FUNCTION patient.guard_merged_root() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status = 'merged' THEN
    RAISE EXCEPTION 'patient.merged' USING ERRCODE = 'PM001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.mrn IS DISTINCT FROM OLD.mrn OR NEW.created_via IS DISTINCT FROM OLD.created_via
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a patient keeps its id, organisation, record number and origin' USING ERRCODE = 'PS001';
  END IF;
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.merged_into IS DISTINCT FROM OLD.merged_into)
     AND NOT (OLD.status = 'active' AND NEW.status = 'merged' AND NEW.merged_into IS NOT NULL) THEN
    RAISE EXCEPTION 'merged is terminal and is set only by complete_merge' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION patient.guard_merged_root() FROM PUBLIC;
CREATE TRIGGER patient_guard_merged_root BEFORE UPDATE ON patient.patient FOR EACH ROW EXECUTE FUNCTION patient.guard_merged_root();

-- consent (22.6): pending -> signed | withdrawn; signed -> superseded | withdrawn; superseded and withdrawn are terminal.
-- What the consent is about never changes. The signing time is the database's, not the caller's.
CREATE FUNCTION patient.guard_consent() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.template_key IS DISTINCT FROM OLD.template_key
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
REVOKE ALL ON FUNCTION patient.guard_consent() FROM PUBLIC;
CREATE TRIGGER consent_guard BEFORE UPDATE ON patient.consent FOR EACH ROW EXECUTE FUNCTION patient.guard_consent();

-- insurance_coverage: the patient edits the card details; only staff set an eligibility result (RA-R1-29). Changing the
-- card details clears an earlier result, because the result belonged to the old details.
CREATE FUNCTION patient.guard_insurance() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_changed_result boolean := NEW.eligibility_status IS DISTINCT FROM OLD.eligibility_status
    OR NEW.verified_at IS DISTINCT FROM OLD.verified_at OR NEW.verified_by IS DISTINCT FROM OLD.verified_by;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
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
REVOKE ALL ON FUNCTION patient.guard_insurance() FROM PUBLIC;
CREATE TRIGGER insurance_coverage_guard BEFORE UPDATE ON patient.insurance_coverage FOR EACH ROW EXECUTE FUNCTION patient.guard_insurance();

-- Terminal rows (kernel.refuse_update_when_terminal of 21.5 does not exist yet; this is the patient-local equivalent for
-- the three R/K tables of this ticket). K states: care_team ended (to_date set), duplicate_flag not_duplicate and resolved,
-- care_relationship ended. The rows an ended state came from keep their identity columns too.
CREATE FUNCTION patient.refuse_update_when_terminal() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  -- Nested on purpose: plpgsql evaluates a field of OLD only when the branch is taken, and the three tables have different columns.
  IF TG_TABLE_NAME = 'care_team_member' THEN
    IF OLD.to_date IS NOT NULL THEN
      RAISE EXCEPTION 'an ended care-team entry accepts no change' USING ERRCODE = 'PS001';
    END IF;
  ELSIF TG_TABLE_NAME = 'care_relationship' THEN
    IF OLD.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'an ended care relationship accepts no change' USING ERRCODE = 'PS001';
    END IF;
  ELSIF TG_TABLE_NAME = 'duplicate_flag' THEN
    IF OLD.status IN ('not_duplicate', 'resolved') THEN
      RAISE EXCEPTION 'a decided duplicate flag accepts no change' USING ERRCODE = 'PS001';
    END IF;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id THEN
    RAISE EXCEPTION 'a row keeps its id and organisation' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION patient.refuse_update_when_terminal() FROM PUBLIC;
CREATE TRIGGER care_team_member_terminal BEFORE UPDATE ON patient.care_team_member FOR EACH ROW EXECUTE FUNCTION patient.refuse_update_when_terminal();
CREATE TRIGGER care_relationship_terminal BEFORE UPDATE ON patient.care_relationship FOR EACH ROW EXECUTE FUNCTION patient.refuse_update_when_terminal();
CREATE TRIGGER duplicate_flag_terminal BEFORE UPDATE ON patient.duplicate_flag FOR EACH ROW EXECUTE FUNCTION patient.refuse_update_when_terminal();

-- A match check is used once.
CREATE FUNCTION patient.guard_match_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'a used match check accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.values_hash IS DISTINCT FROM OLD.values_hash
     OR NEW.candidate_refs IS DISTINCT FROM OLD.candidate_refs
     OR NEW.candidate_patient_ids IS DISTINCT FROM OLD.candidate_patient_ids
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a match check changes only when it is used' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION patient.guard_match_check() FROM PUBLIC;
CREATE TRIGGER match_check_guard BEFORE UPDATE ON patient.match_check FOR EACH ROW EXECUTE FUNCTION patient.guard_match_check();
