-- migration-class: expand
-- The patient_scope_owner merge functions (SHARED-BOUNDARIES 6.2 inventory and 9.2, ARCHITECTURE 25.2, 25.4; ticket BE-09):
-- request_merge, get_merge_request, decide_merge (staff, from the API) and load_merge_job, begin_merge, complete_merge, fail_merge
-- (system, from the execute job). Each is SECURITY DEFINER, owned by patient_scope_owner, has a fixed search_path = pg_catalog,
-- schema-qualified names only, REVOKE ALL FROM PUBLIC and a narrow EXECUTE list (DF-1, DF-8). Each checks the caller's scope
-- settings itself, never an argument (6.2 rule 3); the permission (patient.merge.request, patient.merge.approve) is the API
-- guard's, because the database cannot see it.
--
-- Custom SQLSTATEs (class P, 21.5; continuing 0703): PM009 patient.already_merged, PM010 patient.merge_pending, PM011
-- patient.merge_self_approval, PM012 the request is not in the state the step needs, PM013 participant counts do not add up.
--
-- Lock order (25.2, 9.2): every function locks the patient roots first, in ascending ID order, and the request row afterwards.
-- begin_merge takes FOR UPDATE on the roots; every other writer holds FOR KEY SHARE (the guard of 0701, lock_patients), so a
-- writer in progress commits first and the merge counts its rows, and a later writer waits and is then refused (merged ID) or
-- proceeds (survivor). Locking the request row after the roots means an approval and a merge of the same request cannot deadlock.

GRANT CREATE ON SCHEMA patient TO patient_scope_owner;

-- patient.request_merge: both patients visible to the requester (a missing and an invisible ID raise the same error), both active.
CREATE FUNCTION patient.request_merge(p_request_id uuid, p_survivor uuid, p_merged uuid, p_reason text) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org       uuid := kernel.uuid1('app.org_id');
  v_person    uuid := kernel.uuid1('app.person_id');
  v_principal uuid := kernel.uuid1('app.principal_id');
  v_id        uuid;
  v_n         integer := 0;
  r           record;
BEGIN
  IF v_org IS NULL OR v_person IS NULL OR v_principal IS NULL
     OR kernel.setting('app.audience') IS DISTINCT FROM 'staff' OR kernel.setting('app.realm') IS DISTINCT FROM 'google' THEN
    RAISE EXCEPTION 'request_merge: not available to this caller' USING ERRCODE = '42501';
  END IF;
  IF p_survivor IS NULL OR p_merged IS NULL OR p_survivor = p_merged OR p_reason IS NULL
     OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'request_merge: bad argument' USING ERRCODE = '22023';
  END IF;
  IF NOT patient.caller_sees(p_survivor) OR NOT patient.caller_sees(p_merged) THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  FOR r IN SELECT p.id, p.status FROM patient.patient p
            WHERE p.id IN (p_survivor, p_merged) AND p.organisation_id = v_org ORDER BY p.id FOR KEY SHARE OF p LOOP
    v_n := v_n + 1;
    IF r.status = 'merged' THEN
      RAISE EXCEPTION 'patient.already_merged' USING ERRCODE = 'PM009';
    END IF;
  END LOOP;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  v_id := gen_random_uuid();
  BEGIN
    INSERT INTO patient.merge_request (id, organisation_id, survivor_id, merged_id, requester_person_id, requester_principal_id, reason)
    VALUES (v_id, v_org, p_survivor, p_merged, v_person, v_principal, btrim(p_reason));
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'patient.merge_pending' USING ERRCODE = 'PM010';
  END;
  -- The reason is free text and stays out of the audit row.
  PERFORM patient.write_audit(p_request_id, NULL, 'create', 'patient.merge_request', v_id, p_survivor, NULL, NULL,
                              jsonb_build_object('survivorId', p_survivor, 'mergedId', p_merged));
  RETURN v_id;
END
$$;

-- patient.get_merge_request: the request's metadata for a staff caller. The API guard has checked the permission; approval does
-- not need to see the patients (BQ-3), so this does not test visibility. Nothing about either patient is returned.
CREATE FUNCTION patient.get_merge_request(p_id uuid) RETURNS SETOF patient.merge_request
  LANGUAGE plpgsql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
BEGIN
  IF v_org IS NULL OR kernel.setting('app.audience') IS DISTINCT FROM 'staff' OR kernel.setting('app.realm') IS DISTINCT FROM 'google' THEN
    RAISE EXCEPTION 'get_merge_request: not available to this caller' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM patient.merge_request m WHERE m.id = p_id AND m.organisation_id = v_org;
END
$$;

-- patient.decide_merge: a second staff member approves or rejects (BQ-3 default). The approver need not see the patients.
-- An approval re-checks that both are still active, so a request is never approved against a record that has been merged.
CREATE FUNCTION patient.decide_merge(p_request_id uuid, p_id uuid, p_decision text) RETURNS patient.merge_request
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org       uuid := kernel.uuid1('app.org_id');
  v_person    uuid := kernel.uuid1('app.person_id');
  v_principal uuid := kernel.uuid1('app.principal_id');
  v_row       patient.merge_request;
  v_n         integer := 0;
  r           record;
BEGIN
  IF v_org IS NULL OR v_person IS NULL OR v_principal IS NULL
     OR kernel.setting('app.audience') IS DISTINCT FROM 'staff' OR kernel.setting('app.realm') IS DISTINCT FROM 'google' THEN
    RAISE EXCEPTION 'decide_merge: not available to this caller' USING ERRCODE = '42501';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decide_merge: bad argument' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM patient.merge_request m WHERE m.id = p_id AND m.organisation_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge request not found' USING ERRCODE = 'PM008';
  END IF;
  IF v_row.requester_person_id = v_person OR v_row.requester_principal_id = v_principal THEN
    RAISE EXCEPTION 'patient.merge_self_approval' USING ERRCODE = 'PM011';
  END IF;
  IF v_row.status <> 'requested' THEN
    RAISE EXCEPTION 'merge request is not awaiting a decision' USING ERRCODE = 'PM012';
  END IF;
  -- Roots first (ascending), then the request row (the status is read again under the lock).
  FOR r IN SELECT p.id, p.status FROM patient.patient p
            WHERE p.id IN (v_row.survivor_id, v_row.merged_id) AND p.organisation_id = v_org ORDER BY p.id FOR KEY SHARE OF p LOOP
    v_n := v_n + 1;
    IF r.status = 'merged' AND p_decision = 'approve' THEN
      RAISE EXCEPTION 'patient.already_merged' USING ERRCODE = 'PM009';
    END IF;
  END LOOP;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  SELECT * INTO v_row FROM patient.merge_request m WHERE m.id = p_id AND m.organisation_id = v_org FOR UPDATE;
  IF v_row.status <> 'requested' THEN
    RAISE EXCEPTION 'merge request is not awaiting a decision' USING ERRCODE = 'PM012';
  END IF;
  UPDATE patient.merge_request
     SET status = CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
         approver_person_id = v_person, approver_principal_id = v_principal, decided_at = now()
   WHERE id = p_id
  RETURNING * INTO v_row;
  PERFORM patient.write_audit(p_request_id, NULL, 'update', 'patient.merge_request', p_id, v_row.survivor_id, NULL, NULL,
                              jsonb_build_object('decision', p_decision, 'survivorId', v_row.survivor_id, 'mergedId', v_row.merged_id));
  RETURN v_row;
END
$$;

-- patient.load_merge_job: the execute job starts here (organisation-wide system job). Returns the two IDs, the status and the
-- exact patient IDs the merge job will run with: both, and every ID already merged into either (9.2 "Execution scope").
CREATE FUNCTION patient.load_merge_job(p_id uuid) RETURNS TABLE (survivor_id uuid, merged_id uuid, status text, patient_ids uuid[])
  LANGUAGE plpgsql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
BEGIN
  IF v_org IS NULL OR kernel.setting('app.audience') IS DISTINCT FROM 'system' OR kernel.setting('app.job_scope') IS DISTINCT FROM 'org' THEN
    RAISE EXCEPTION 'load_merge_job: only an organisation-wide job may call this' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT m.survivor_id, m.merged_id, m.status,
           ARRAY(SELECT x.id FROM (SELECT m.survivor_id AS id UNION SELECT m.merged_id
                                   UNION SELECT pm.merged_id FROM patient.patient_merge pm
                                          WHERE pm.final_survivor_id IN (m.survivor_id, m.merged_id)) x ORDER BY x.id)
      FROM patient.merge_request m WHERE m.id = p_id AND m.organisation_id = v_org;
END
$$;

-- patient.begin_merge (9.2 step 1): locks both roots FOR UPDATE, lower ID first; both must be active, else patient.already_merged
-- (never redirected to a survivor: the approval named those records). Moves the request to `executing`.
CREATE FUNCTION patient.begin_merge(p_id uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org   uuid := kernel.uuid1('app.org_id');
  v_row   patient.merge_request;
  v_n     integer := 0;
  r       record;
BEGIN
  IF v_org IS NULL OR kernel.setting('app.audience') IS DISTINCT FROM 'system' OR kernel.setting('app.job_scope') IS DISTINCT FROM 'patients' THEN
    RAISE EXCEPTION 'begin_merge: only a patients-scope job may call this' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM patient.merge_request m WHERE m.id = p_id AND m.organisation_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge request not found' USING ERRCODE = 'PM008';
  END IF;
  IF NOT (v_row.survivor_id = ANY (kernel.uuids('app.job_patient_ids')) AND v_row.merged_id = ANY (kernel.uuids('app.job_patient_ids'))) THEN
    RAISE EXCEPTION 'begin_merge: the job was not started for these patients' USING ERRCODE = '42501';
  END IF;
  FOR r IN SELECT p.id, p.status FROM patient.patient p
            WHERE p.id IN (v_row.survivor_id, v_row.merged_id) AND p.organisation_id = v_org ORDER BY p.id FOR UPDATE OF p LOOP
    v_n := v_n + 1;
    IF r.status <> 'active' THEN
      RAISE EXCEPTION 'patient.already_merged' USING ERRCODE = 'PM009';
    END IF;
  END LOOP;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  SELECT * INTO v_row FROM patient.merge_request m WHERE m.id = p_id FOR UPDATE;
  IF v_row.status <> 'approved' THEN
    RAISE EXCEPTION 'merge request is not approved' USING ERRCODE = 'PM012';
  END IF;
  UPDATE patient.merge_request SET status = 'executing' WHERE id = p_id;
END
$$;

-- patient.complete_merge (9.2 step 3, 25.4): runs after the participants, in the same transaction. Checks the equation
-- found = re-pointed + resolved + kept for every table reported, stores the residue, moves the merged patient's open care
-- relationships to the survivor and ends the merged patient's own, writes the map entry and the final survivor of every row
-- that pointed at the merged patient, cancels every other open request that names the merged patient on either side, and, as the
-- last write to the merged patient, sets status = merged and merged_into. Ends by recomputing the survivor's staff_scope rows (6.6).
-- The merge audit row is the job's (audience system is not covered by the audit insert policy of this role).
CREATE FUNCTION patient.complete_merge(p_id uuid, p_counts jsonb, p_residue jsonb) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org   uuid := kernel.uuid1('app.org_id');
  v_row   patient.merge_request;
  v_t     record;
  v_f     bigint;
  v_sum   bigint;
  r       record;
BEGIN
  IF v_org IS NULL OR kernel.setting('app.audience') IS DISTINCT FROM 'system' OR kernel.setting('app.job_scope') IS DISTINCT FROM 'patients' THEN
    RAISE EXCEPTION 'complete_merge: only a patients-scope job may call this' USING ERRCODE = '42501';
  END IF;
  IF p_counts IS NULL OR jsonb_typeof(p_counts) <> 'object' OR p_residue IS NULL OR jsonb_typeof(p_residue) <> 'array' THEN
    RAISE EXCEPTION 'complete_merge: bad argument' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM patient.merge_request m WHERE m.id = p_id AND m.organisation_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge request not found' USING ERRCODE = 'PM008';
  END IF;
  IF NOT (v_row.survivor_id = ANY (kernel.uuids('app.job_patient_ids')) AND v_row.merged_id = ANY (kernel.uuids('app.job_patient_ids'))) THEN
    RAISE EXCEPTION 'complete_merge: the job was not started for these patients' USING ERRCODE = '42501';
  END IF;
  -- The roots are already locked by begin_merge in this transaction; this takes no new lock on them.
  SELECT * INTO v_row FROM patient.merge_request m WHERE m.id = p_id FOR UPDATE;
  IF v_row.status <> 'executing' THEN
    RAISE EXCEPTION 'merge request is not executing' USING ERRCODE = 'PM012';
  END IF;

  FOR v_t IN SELECT key, value FROM jsonb_each(p_counts) LOOP
    IF jsonb_typeof(v_t.value) <> 'object' OR v_t.key !~ '^[a-z][a-z_0-9]*\.[a-z][a-z_0-9]*$'
       OR jsonb_typeof(v_t.value -> 'found') <> 'number' OR jsonb_typeof(v_t.value -> 'repointed') <> 'number'
       OR jsonb_typeof(v_t.value -> 'resolved') <> 'number' OR jsonb_typeof(v_t.value -> 'kept') <> 'number' THEN
      RAISE EXCEPTION 'complete_merge: bad counts' USING ERRCODE = '22023';
    END IF;
    v_f := (v_t.value ->> 'found')::bigint;
    v_sum := (v_t.value ->> 'repointed')::bigint + (v_t.value ->> 'resolved')::bigint + (v_t.value ->> 'kept')::bigint;
    IF v_f < 0 OR v_f <> v_sum THEN
      RAISE EXCEPTION 'complete_merge: counts do not add up' USING ERRCODE = 'PM013';
    END IF;
  END LOOP;

  INSERT INTO patient.merge_residue (id, organisation_id, merge_request_id, survivor_id, merged_id, source_table, rule, source_row)
  SELECT gen_random_uuid(), v_org, p_id, v_row.survivor_id, v_row.merged_id, x ->> 'table', x ->> 'rule', x -> 'row'
    FROM jsonb_array_elements(p_residue) x;

  FOR r IN SELECT c.id, c.location_id FROM patient.care_relationship c
            WHERE c.patient_id = v_row.merged_id AND c.ended_at IS NULL ORDER BY c.id FOR UPDATE LOOP
    IF NOT EXISTS (SELECT 1 FROM patient.care_relationship s
                    WHERE s.patient_id = v_row.survivor_id AND s.location_id = r.location_id AND s.ended_at IS NULL) THEN
      INSERT INTO patient.care_relationship (id, organisation_id, patient_id, location_id, reason, created_by_job)
      VALUES (gen_random_uuid(), v_org, v_row.survivor_id, r.location_id, 'merge', NULL);
    END IF;
    UPDATE patient.care_relationship SET ended_at = now(), ended_reason = 'merged' WHERE id = r.id;
  END LOOP;

  -- The survivor is active (begin_merge), so it is its own final survivor. Rows that named the merged patient as final survivor
  -- now resolve to the survivor in one lookup (9.2).
  INSERT INTO patient.patient_merge (merged_id, organisation_id, direct_survivor_id, final_survivor_id, merge_request_id)
  VALUES (v_row.merged_id, v_org, v_row.survivor_id, v_row.survivor_id, p_id);
  UPDATE patient.patient_merge SET final_survivor_id = v_row.survivor_id WHERE final_survivor_id = v_row.merged_id;

  UPDATE patient.merge_request
     SET status = 'cancelled', failure_code = 'patient.already_merged'
   WHERE id <> p_id AND organisation_id = v_org AND status IN ('requested', 'approved')
     AND (merged_id = v_row.merged_id OR survivor_id = v_row.merged_id);

  -- Last write to the merged patient.
  UPDATE patient.patient SET status = 'merged', merged_into = v_row.survivor_id WHERE id = v_row.merged_id;
  PERFORM patient.recompute_scope(v_row.survivor_id);

  UPDATE patient.merge_request SET status = 'completed', counts = p_counts WHERE id = p_id;
END
$$;

-- patient.fail_merge: after a rollback, a separate transaction records the failure (25.4). Organisation-wide system job.
CREATE FUNCTION patient.fail_merge(p_id uuid, p_code text) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  v_row patient.merge_request;
BEGIN
  IF v_org IS NULL OR kernel.setting('app.audience') IS DISTINCT FROM 'system' OR kernel.setting('app.job_scope') IS DISTINCT FROM 'org' THEN
    RAISE EXCEPTION 'fail_merge: only an organisation-wide job may call this' USING ERRCODE = '42501';
  END IF;
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z_]*\.[a-z][a-z_]*$' THEN
    RAISE EXCEPTION 'fail_merge: bad argument' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM patient.merge_request m WHERE m.id = p_id AND m.organisation_id = v_org FOR UPDATE;
  IF NOT FOUND OR v_row.status NOT IN ('approved', 'executing') THEN
    RETURN false;
  END IF;
  UPDATE patient.merge_request SET status = 'failed', failure_code = p_code WHERE id = p_id;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION patient.request_merge(uuid, uuid, uuid, text), patient.get_merge_request(uuid),
  patient.decide_merge(uuid, uuid, text), patient.load_merge_job(uuid), patient.begin_merge(uuid),
  patient.complete_merge(uuid, jsonb, jsonb), patient.fail_merge(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient.request_merge(uuid, uuid, uuid, text), patient.get_merge_request(uuid),
  patient.decide_merge(uuid, uuid, text) TO app_api;
GRANT EXECUTE ON FUNCTION patient.load_merge_job(uuid), patient.begin_merge(uuid),
  patient.complete_merge(uuid, jsonb, jsonb), patient.fail_merge(uuid, text) TO app_worker;

ALTER FUNCTION patient.request_merge(uuid, uuid, uuid, text) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.get_merge_request(uuid) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.decide_merge(uuid, uuid, text) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.load_merge_job(uuid) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.begin_merge(uuid) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.complete_merge(uuid, jsonb, jsonb) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.fail_merge(uuid, text) OWNER TO patient_scope_owner;

-- The CREATE right on the schema was needed only to move the ownership above.
REVOKE CREATE ON SCHEMA patient FROM patient_scope_owner;
