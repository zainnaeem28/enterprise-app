-- migration-class: expand
-- HEAAA-657 (QS-03 F10b; ARCHITECTURE 21.6 DF-10 / amendment A-2.4; HEAAA-650). patient.get_merge_request and patient.decide_merge
-- return a fixed column list, never the patient.merge_request row type:
--   id, status, created_at, decided_at, failure_code, counts (only when completed), caller_is_requester;
--   survivor_id and merged_id each only when patient.caller_sees is true for that ID, else NULL;
--   reason only when the caller is the requester or sees both patients, else NULL.
-- The requester and approver person and principal IDs are never returned. The approver need not see the patients (BQ-3), so a
-- non-requester who sees neither patient gets the status and the counts and nothing that identifies a patient or the reason.
-- The decision logic of decide_merge is that of 0803, unchanged; only what it returns changed. 0803 is not edited.

-- The ownership transfer needs CREATE on the schema (21.2 point 1, as 0803); withdrawn at the end of this file.
GRANT CREATE ON SCHEMA patient TO patient_scope_owner;

-- The one place the narrowing is written (internal, invoker: runs as the definer that calls it, with the caller's settings).
CREATE FUNCTION patient.merge_request_view(p_row patient.merge_request)
  RETURNS TABLE (id uuid, status text, created_at timestamptz, decided_at timestamptz, failure_code text, counts jsonb,
                 caller_is_requester boolean, survivor_id uuid, merged_id uuid, reason text)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
  AS $$
  SELECT p_row.id, p_row.status, p_row.created_at, p_row.decided_at, p_row.failure_code,
         CASE WHEN p_row.status = 'completed' THEN p_row.counts END,
         x.is_requester,
         CASE WHEN x.sees_survivor THEN p_row.survivor_id END,
         CASE WHEN x.sees_merged THEN p_row.merged_id END,
         CASE WHEN x.is_requester OR (x.sees_survivor AND x.sees_merged) THEN p_row.reason END
    FROM (SELECT coalesce(p_row.requester_person_id = kernel.uuid1('app.person_id')
                          OR p_row.requester_principal_id = kernel.uuid1('app.principal_id'), false) AS is_requester,
                 patient.caller_sees(p_row.survivor_id) AS sees_survivor,
                 patient.caller_sees(p_row.merged_id) AS sees_merged) x
$$;
REVOKE ALL ON FUNCTION patient.merge_request_view(patient.merge_request) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient.merge_request_view(patient.merge_request) TO patient_scope_owner;

-- patient.get_merge_request: the request's narrowed view for a staff caller. The API guard has checked the permission; approval
-- does not need to see the patients (BQ-3), so this does not test visibility of the request itself.
CREATE FUNCTION patient.get_merge_request(p_id uuid)
  RETURNS TABLE (id uuid, status text, created_at timestamptz, decided_at timestamptz, failure_code text, counts jsonb,
                 caller_is_requester boolean, survivor_id uuid, merged_id uuid, reason text)
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
  RETURN QUERY SELECT v.* FROM patient.merge_request m, patient.merge_request_view(m) v
                WHERE m.id = p_id AND m.organisation_id = v_org;
END
$$;

-- patient.decide_merge: a second staff member approves or rejects (BQ-3 default). The approver need not see the patients.
-- An approval re-checks that both are still active, so a request is never approved against a record that has been merged.
CREATE FUNCTION patient.decide_merge(p_request_id uuid, p_id uuid, p_decision text)
  RETURNS TABLE (id uuid, status text, created_at timestamptz, decided_at timestamptz, failure_code text, counts jsonb,
                 caller_is_requester boolean, survivor_id uuid, merged_id uuid, reason text)
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
  UPDATE patient.merge_request m
     SET status = CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
         approver_person_id = v_person, approver_principal_id = v_principal, decided_at = now()
   WHERE m.id = p_id
  RETURNING * INTO v_row;
  PERFORM patient.write_audit(p_request_id, NULL, 'update', 'patient.merge_request', p_id, v_row.survivor_id, NULL, NULL,
                              jsonb_build_object('decision', p_decision, 'survivorId', v_row.survivor_id, 'mergedId', v_row.merged_id));
  RETURN QUERY SELECT v.* FROM patient.merge_request_view(v_row) v;
END
$$;

REVOKE ALL ON FUNCTION patient.get_merge_request(uuid), patient.decide_merge(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient.get_merge_request(uuid), patient.decide_merge(uuid, uuid, text) TO app_api;
ALTER FUNCTION patient.get_merge_request(uuid) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.decide_merge(uuid, uuid, text) OWNER TO patient_scope_owner;

-- DF-13 (ARCHITECTURE 21.6, A-2.4; SEC03-F13 item 5): patient.caller_sees equals "the patient root is visible under RLS" for every
-- audience and realm. The parity test (rls-matrix.dbtest.ts, DF-13) found three places where the hand-written predicate was wider than
-- the policies of 0702, and this replaces it with the policies' conditions (same signature, same owner, same grants):
--   * no organisation test (staff or a patient of another organisation with a matching location or patient ID was "seen");
--   * a break-glass grant counted for any staff realm (the policies allow it for google and admin_pool only);
--   * a patient root that does not exist in the caller's organisation counted (there is nothing to see).
-- One difference stays on purpose: a proxy (patient_ids and proxy_patient_ids both list the patient) is "seen" here, although the
-- proxy never reads the root row itself (T-PAT-OWN excludes proxy_patient_ids). The booking and referral functions act for the proxied
-- patient through this predicate (D-7, TC-BK-11); narrowing it broke them. The parity test pins that single exception by name.
-- Two-valued: NULL settings give false. The system branch cannot test current_user (it runs as the definer); the system audience
-- reaches the definer functions only through app_worker's EXECUTE grants.
CREATE OR REPLACE FUNCTION patient.caller_sees(p_id uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_aud   text := kernel.setting('app.audience');
  v_realm text := kernel.setting('app.realm');
  v_org   uuid := kernel.uuid1('app.org_id');
BEGIN
  IF p_id IS NULL OR v_org IS NULL OR v_aud IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM patient.patient p WHERE p.id = p_id AND p.organisation_id = v_org) THEN
    RETURN false;
  END IF;
  IF v_aud = 'patient' THEN
    RETURN p_id = ANY (kernel.uuids('app.patient_ids'));
  ELSIF v_aud = 'staff' THEN
    IF v_realm = 'google' THEN
      RETURN p_id = ANY (kernel.uuids('app.btg_patient_ids'))
          OR EXISTS (SELECT 1 FROM patient.staff_scope s
                      WHERE s.patient_id = p_id AND s.location_id = ANY (kernel.uuids('app.location_ids')));
    ELSIF v_realm = 'admin_pool' THEN
      RETURN p_id = ANY (kernel.uuids('app.btg_patient_ids'));
    END IF;
    RETURN false;
  ELSIF v_aud = 'system' THEN
    RETURN kernel.setting('app.job_scope') = 'org'
        OR (kernel.setting('app.job_scope') = 'patients' AND p_id = ANY (kernel.uuids('app.job_patient_ids')));
  END IF;
  RETURN false;
END
$$;

REVOKE CREATE ON SCHEMA patient FROM patient_scope_owner;
