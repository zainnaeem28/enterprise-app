-- migration-class: expand
-- SEC03-F11 (docs/security/SEC03-F11-worker-merge-grants-hardening-spec.md; SEC-03 section F11, proof P7; HEAAA-687). The merge
-- re-pointing of the patient module's six participant tables and of scheduling.slot_reservation moves out of app_worker and into
-- SECURITY DEFINER functions. Before this file every patients-scope system job (reminder, export, waitlist) held UPDATE on
-- patient_id (and status, reason, to_date, end_reason, candidate_patient_id, resolved_reason) and DELETE on communication_preference
-- for its own patients, so a non-merge job could withdraw a signed consent and commit (P7). After it app_worker holds SELECT only on
-- these tables and a write happens only inside one of the functions below, which refuse unless the call is the executing merge.
--
-- patient.merge_job_check(request) is the one gate: audience system, job_scope patients, the request exists in the caller's
-- organisation, status = executing, and both survivor_id and merged_id are in app.job_patient_ids (what begin_merge checks, plus the
-- executing state). Every function calls it first and moves rows only from the request's merged_id to its survivor_id. The
-- function-owner roles (patient_scope_owner; scheduling_booking_owner for slot_reservation) carry the table rights and policies; their
-- policies repeat the audience/scope/job-ID conditions as defence in depth. The row locks the participants took with FOR UPDATE
-- (a right app_worker no longer has) are taken inside the functions. No job-class setting is introduced (21.7).
--
-- Down-note (forward-only): to go back, restore the grants and policies of 0802 lines 60-114 and 0902 lines 73-76 and 91, and drop
-- the seven merge_repoint_* functions and merge_job_check. The TypeScript participants of this change must be reverted with them.
--
-- Custom SQLSTATEs: 42501 for a caller or a request that is not the executing merge for these patients, PM012 (as in begin_merge)
-- for a request that exists but is not executing.

GRANT CREATE ON SCHEMA patient TO patient_scope_owner;
GRANT CREATE ON SCHEMA scheduling TO scheduling_booking_owner;
GRANT USAGE ON SCHEMA patient TO scheduling_booking_owner;

-- The gate ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION patient.merge_job_check(p_request uuid) RETURNS TABLE (survivor_id uuid, merged_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  v_row record;
BEGIN
  IF v_org IS NULL OR p_request IS NULL
     OR kernel.setting('app.audience') IS DISTINCT FROM 'system' OR kernel.setting('app.job_scope') IS DISTINCT FROM 'patients' THEN
    RAISE EXCEPTION 'merge write: only the patients-scope job of an executing merge may call this' USING ERRCODE = '42501';
  END IF;
  SELECT m.survivor_id, m.merged_id, m.status INTO v_row
    FROM patient.merge_request m WHERE m.id = p_request AND m.organisation_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge write: no such merge request for this job' USING ERRCODE = '42501';
  END IF;
  IF NOT (v_row.survivor_id = ANY (kernel.uuids('app.job_patient_ids')) AND v_row.merged_id = ANY (kernel.uuids('app.job_patient_ids'))) THEN
    RAISE EXCEPTION 'merge write: the job was not started for these patients' USING ERRCODE = '42501';
  END IF;
  IF v_row.status <> 'executing' THEN
    RAISE EXCEPTION 'merge write: the merge request is not executing' USING ERRCODE = 'PM012';
  END IF;
  survivor_id := v_row.survivor_id;
  merged_id := v_row.merged_id;
  RETURN NEXT;
END
$$;

-- Rights of the owner role on the participant tables (select to read, the narrow update each merge write needs) -------------
GRANT SELECT ON patient.patient_contact, patient.insurance_coverage, patient.consent, patient.communication_preference,
                patient.care_team_member TO patient_scope_owner;
GRANT UPDATE (patient_id) ON patient.patient_contact, patient.insurance_coverage, patient.communication_preference TO patient_scope_owner;
GRANT DELETE ON patient.communication_preference TO patient_scope_owner;
GRANT UPDATE (patient_id, status, reason) ON patient.consent TO patient_scope_owner;
GRANT UPDATE (patient_id, to_date, end_reason) ON patient.care_team_member TO patient_scope_owner;
GRANT UPDATE (patient_id, candidate_patient_id, status, resolved_reason) ON patient.duplicate_flag TO patient_scope_owner;
GRANT UPDATE (patient_id) ON scheduling.slot_reservation TO scheduling_booking_owner;

-- Owner policies. Reads are limited to a patients-scope system job's exact IDs; writes repeat that, and the consent write is pinned to
-- the status values the merge produces (superseded, or withdrawn with reason merged_duplicate) on rows that are still pending/signed.
CREATE POLICY contact_scope_owner_select ON patient.patient_contact FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY contact_scope_owner_merge_update ON patient.patient_contact FOR UPDATE TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));

CREATE POLICY coverage_scope_owner_select ON patient.insurance_coverage FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY coverage_scope_owner_merge_update ON patient.insurance_coverage FOR UPDATE TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));

CREATE POLICY consent_scope_owner_select ON patient.consent FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY consent_scope_owner_merge_update ON patient.consent FOR UPDATE TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids'))
     AND status IN ('pending', 'signed'))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids'))
     AND (status IN ('pending', 'signed', 'superseded') OR (status = 'withdrawn' AND reason = 'merged_duplicate')));

CREATE POLICY preference_scope_owner_select ON patient.communication_preference FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY preference_scope_owner_merge_update ON patient.communication_preference FOR UPDATE TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY preference_scope_owner_merge_delete ON patient.communication_preference FOR DELETE TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));

CREATE POLICY careteam_scope_owner_select ON patient.care_team_member FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));
CREATE POLICY careteam_scope_owner_merge_update ON patient.care_team_member FOR UPDATE TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));

-- duplicate_flag already has flag_scope_owner_select (0702). A flag of another patient that names the merged patient as candidate is
-- reachable too (22.16), as for the worker policy this replaces.
CREATE POLICY flag_scope_owner_merge_update ON patient.duplicate_flag FOR UPDATE TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND (patient_id = ANY (kernel.uuids('app.job_patient_ids')) OR candidate_patient_id = ANY (kernel.uuids('app.job_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients');

CREATE POLICY reservation_booking_owner_merge_update ON scheduling.slot_reservation FOR UPDATE TO scheduling_booking_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND patient_id = ANY (kernel.uuids('app.job_patient_ids')));

-- The re-pointing functions ----------------------------------------------------------------------------------------------
CREATE FUNCTION patient.merge_repoint_patient_contact(p_request uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_s uuid;
  v_m uuid;
  v_n integer;
BEGIN
  SELECT c.survivor_id, c.merged_id INTO v_s, v_m FROM patient.merge_job_check(p_request) c;
  UPDATE patient.patient_contact t SET patient_id = v_s WHERE t.patient_id = v_m AND t.organisation_id = kernel.uuid1('app.org_id');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

CREATE FUNCTION patient.merge_repoint_insurance_coverage(p_request uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_s uuid;
  v_m uuid;
  v_n integer;
BEGIN
  SELECT c.survivor_id, c.merged_id INTO v_s, v_m FROM patient.merge_job_check(p_request) c;
  UPDATE patient.insurance_coverage t SET patient_id = v_s WHERE t.patient_id = v_m AND t.organisation_id = kernel.uuid1('app.org_id');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

-- Consent: signed on both for one template -> the higher version wins, then the later signing time, ties to the survivor; the loser is
-- superseded. Pending on both for one template version -> the merged one is withdrawn (merged_duplicate). Pending and signed rows of the
-- merged patient move. Nothing else is ever written: a signed consent is never withdrawn.
CREATE FUNCTION patient.merge_repoint_consent(p_request uuid, OUT repointed integer, OUT resolved integer) RETURNS record
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  v_s uuid;
  v_m uuid;
  v_n integer;
  r record;
BEGIN
  SELECT c.survivor_id, c.merged_id INTO v_s, v_m FROM patient.merge_job_check(p_request) c;
  resolved := 0;
  FOR r IN SELECT m.id AS m_id, s.id AS s_id,
                  (m.template_version, m.signed_at) > (s.template_version, s.signed_at) AS merged_wins
             FROM patient.consent m JOIN patient.consent s
               ON s.patient_id = v_s AND s.template_key = m.template_key AND s.status = 'signed' AND s.organisation_id = v_org
            WHERE m.patient_id = v_m AND m.status = 'signed' AND m.organisation_id = v_org
            ORDER BY m.id FOR UPDATE OF m, s LOOP
    UPDATE patient.consent t SET status = 'superseded'
     WHERE t.id = CASE WHEN r.merged_wins IS TRUE THEN r.s_id ELSE r.m_id END;
    IF r.merged_wins IS NOT TRUE THEN resolved := resolved + 1; END IF; -- a loser on the merged ID stays there as K
  END LOOP;
  UPDATE patient.consent m SET status = 'withdrawn', reason = 'merged_duplicate'
   WHERE m.patient_id = v_m AND m.status = 'pending' AND m.organisation_id = v_org
     AND EXISTS (SELECT 1 FROM patient.consent s WHERE s.patient_id = v_s AND s.status = 'pending' AND s.organisation_id = v_org
                    AND s.template_key = m.template_key AND s.template_version = m.template_version);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  resolved := resolved + v_n;
  UPDATE patient.consent t SET patient_id = v_s
   WHERE t.patient_id = v_m AND t.status IN ('pending', 'signed') AND t.organisation_id = v_org;
  GET DIAGNOSTICS repointed = ROW_COUNT;
END
$$;

-- Communication preference: PK (patient). If the survivor has a row the merged row is deleted and returned (residue); else it moves.
CREATE FUNCTION patient.merge_repoint_communication_preference(p_request uuid, OUT repointed integer, OUT deleted jsonb) RETURNS record
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  v_s uuid;
  v_m uuid;
BEGIN
  SELECT c.survivor_id, c.merged_id INTO v_s, v_m FROM patient.merge_job_check(p_request) c;
  WITH d AS (
    DELETE FROM patient.communication_preference m
     WHERE m.patient_id = v_m AND m.organisation_id = v_org
       AND EXISTS (SELECT 1 FROM patient.communication_preference s WHERE s.patient_id = v_s AND s.organisation_id = v_org)
    RETURNING to_jsonb(m) AS j)
  SELECT coalesce(jsonb_agg(d.j), '[]'::jsonb) INTO deleted FROM d;
  UPDATE patient.communication_preference t SET patient_id = v_s WHERE t.patient_id = v_m AND t.organisation_id = v_org;
  GET DIAGNOSTICS repointed = ROW_COUNT;
END
$$;

-- Care team: UQ active (patient, principal, role). The survivor's active entry wins; the merged one is ended; the rest of the merged
-- patient's active entries move.
CREATE FUNCTION patient.merge_repoint_care_team_member(p_request uuid, OUT repointed integer, OUT ended integer) RETURNS record
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  v_s uuid;
  v_m uuid;
BEGIN
  SELECT c.survivor_id, c.merged_id INTO v_s, v_m FROM patient.merge_job_check(p_request) c;
  UPDATE patient.care_team_member m SET to_date = greatest(current_date, m.from_date), end_reason = 'merged_duplicate'
   WHERE m.patient_id = v_m AND m.to_date IS NULL AND m.organisation_id = v_org
     AND EXISTS (SELECT 1 FROM patient.care_team_member s WHERE s.patient_id = v_s AND s.to_date IS NULL AND s.organisation_id = v_org
                    AND s.principal_id = m.principal_id AND s.role = m.role);
  GET DIAGNOSTICS ended = ROW_COUNT;
  UPDATE patient.care_team_member t SET patient_id = v_s WHERE t.patient_id = v_m AND t.to_date IS NULL AND t.organisation_id = v_org;
  GET DIAGNOSTICS repointed = ROW_COUNT;
END
$$;

-- Duplicate flags: open flags between the two are resolved (merged); the others get the survivor in place of the merged ID, oldest first,
-- and of a doubled pair the older flag stays open (the newer is resolved, merged_duplicate).
CREATE FUNCTION patient.merge_repoint_duplicate_flag(p_request uuid, OUT repointed integer, OUT resolved integer) RETURNS record
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  v_s uuid;
  v_m uuid;
  v_other uuid;
  v_n integer;
  f record;
  e record;
BEGIN
  SELECT c.survivor_id, c.merged_id INTO v_s, v_m FROM patient.merge_job_check(p_request) c;
  repointed := 0;
  UPDATE patient.duplicate_flag t SET status = 'resolved', resolved_reason = 'merged'
   WHERE t.status IN ('open', 'merge_requested') AND t.organisation_id = v_org
     AND ((t.patient_id = v_m AND t.candidate_patient_id = v_s) OR (t.patient_id = v_s AND t.candidate_patient_id = v_m));
  GET DIAGNOSTICS resolved = ROW_COUNT;
  FOR f IN SELECT d.id, d.patient_id, d.candidate_patient_id, d.created_at FROM patient.duplicate_flag d
            WHERE d.status IN ('open', 'merge_requested') AND d.organisation_id = v_org
              AND (d.patient_id = v_m OR d.candidate_patient_id = v_m)
            ORDER BY d.created_at, d.id FOR UPDATE LOOP
    v_other := CASE WHEN f.patient_id = v_m THEN f.candidate_patient_id ELSE f.patient_id END;
    SELECT d.id, d.created_at INTO e FROM patient.duplicate_flag d
     WHERE d.status IN ('open', 'merge_requested') AND d.id <> f.id AND d.organisation_id = v_org
       AND ((d.patient_id = v_s AND d.candidate_patient_id = v_other) OR (d.patient_id = v_other AND d.candidate_patient_id = v_s))
     FOR UPDATE;
    IF FOUND THEN
      IF f.created_at > e.created_at OR (f.created_at = e.created_at AND f.id > e.id) THEN
        UPDATE patient.duplicate_flag t SET status = 'resolved', resolved_reason = 'merged_duplicate' WHERE t.id = f.id;
        resolved := resolved + 1;
        CONTINUE;
      END IF;
      UPDATE patient.duplicate_flag t SET status = 'resolved', resolved_reason = 'merged_duplicate' WHERE t.id = e.id;
    END IF;
    UPDATE patient.duplicate_flag t
       SET patient_id = CASE WHEN t.patient_id = v_m THEN v_s ELSE t.patient_id END,
           candidate_patient_id = CASE WHEN t.candidate_patient_id = v_m THEN v_s ELSE t.candidate_patient_id END
     WHERE t.id = f.id;
    repointed := repointed + 1;
  END LOOP;
END
$$;

-- Scheduling: R = held, confirmed, checked_in occupancy (moved); every other status is K (kept; the trigger of 0901 refuses its update).
-- The rows are locked in id order first, then counted and moved under that lock, so found = repointed + kept holds.
CREATE FUNCTION scheduling.merge_repoint_slot_reservation(p_request uuid, OUT n_found integer, OUT n_kept integer, OUT n_repointed integer) RETURNS record
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  v_s uuid;
  v_m uuid;
  v_r text[] := ARRAY['held', 'confirmed', 'checked_in'];
BEGIN
  SELECT c.survivor_id, c.merged_id INTO v_s, v_m FROM patient.merge_job_check(p_request) c;
  PERFORM r.id FROM scheduling.slot_reservation r WHERE r.patient_id = v_m AND r.organisation_id = v_org ORDER BY r.id FOR UPDATE;
  SELECT count(*)::integer INTO n_found FROM scheduling.slot_reservation r WHERE r.patient_id = v_m AND r.organisation_id = v_org;
  SELECT count(*)::integer INTO n_kept FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
   WHERE r.patient_id = v_m AND r.organisation_id = v_org AND o.status <> ALL (v_r);
  UPDATE scheduling.slot_reservation r SET patient_id = v_s
    FROM scheduling.slot_occupancy o
   WHERE o.id = r.id AND r.patient_id = v_m AND r.organisation_id = v_org AND o.status = ANY (v_r);
  GET DIAGNOSTICS n_repointed = ROW_COUNT;
END
$$;

-- Ownership and execute rights ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION patient.merge_job_check(uuid), patient.merge_repoint_patient_contact(uuid),
  patient.merge_repoint_insurance_coverage(uuid), patient.merge_repoint_consent(uuid),
  patient.merge_repoint_communication_preference(uuid), patient.merge_repoint_care_team_member(uuid),
  patient.merge_repoint_duplicate_flag(uuid), scheduling.merge_repoint_slot_reservation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient.merge_repoint_patient_contact(uuid), patient.merge_repoint_insurance_coverage(uuid),
  patient.merge_repoint_consent(uuid), patient.merge_repoint_communication_preference(uuid),
  patient.merge_repoint_care_team_member(uuid), patient.merge_repoint_duplicate_flag(uuid),
  scheduling.merge_repoint_slot_reservation(uuid) TO app_worker;
GRANT EXECUTE ON FUNCTION patient.merge_job_check(uuid) TO scheduling_booking_owner;
ALTER FUNCTION patient.merge_job_check(uuid) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.merge_repoint_patient_contact(uuid) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.merge_repoint_insurance_coverage(uuid) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.merge_repoint_consent(uuid) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.merge_repoint_communication_preference(uuid) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.merge_repoint_care_team_member(uuid) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.merge_repoint_duplicate_flag(uuid) OWNER TO patient_scope_owner;
ALTER FUNCTION scheduling.merge_repoint_slot_reservation(uuid) OWNER TO scheduling_booking_owner;
REVOKE CREATE ON SCHEMA patient FROM patient_scope_owner;
REVOKE CREATE ON SCHEMA scheduling FROM scheduling_booking_owner;

-- Take the writes away from app_worker (SELECT policies stay: the executor counts) -------------------------------------------
DROP POLICY contact_system_merge_update ON patient.patient_contact;
DROP POLICY coverage_system_merge_update ON patient.insurance_coverage;
DROP POLICY consent_system_merge_update ON patient.consent;
DROP POLICY preference_system_merge_update ON patient.communication_preference;
DROP POLICY preference_system_merge_delete ON patient.communication_preference;
DROP POLICY careteam_system_merge_update ON patient.care_team_member;
DROP POLICY flag_system_merge_update ON patient.duplicate_flag;
DROP POLICY reservation_system_merge_update ON scheduling.slot_reservation;

REVOKE UPDATE (patient_id) ON patient.patient_contact, patient.insurance_coverage, patient.communication_preference FROM app_worker;
REVOKE UPDATE (patient_id, status, reason) ON patient.consent FROM app_worker;
REVOKE DELETE ON patient.communication_preference FROM app_worker;
REVOKE UPDATE (patient_id, to_date, end_reason) ON patient.care_team_member FROM app_worker;
REVOKE UPDATE (patient_id, candidate_patient_id, status, resolved_reason) ON patient.duplicate_flag FROM app_worker;
REVOKE UPDATE (patient_id) ON scheduling.slot_reservation FROM app_worker;
