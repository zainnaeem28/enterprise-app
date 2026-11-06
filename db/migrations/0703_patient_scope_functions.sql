-- migration-class: expand
-- The patient_scope_owner functions (SHARED-BOUNDARIES 6.2 inventory, 6.6; ARCHITECTURE 21.6, 25.2, 25.3; ticket BE-08):
-- lock_patients, register, ensure_care_relationship, attach, end_care_relationship, verify_staff_scope, and the guard
-- function of 0701 (ownership moves here). Each definer function is owned by a NOLOGIN function-owner role, has a fixed
-- search_path = pg_catalog, schema-qualified names only, REVOKE ALL FROM PUBLIC and a narrow EXECUTE list (DF-1, DF-8).
--
-- Every function checks the caller's scope settings itself before acting (6.2 rule 3). The database cannot see the caller's
-- permission (it is not a transaction setting); the API guard checks the permission (BD-07) and the settings decide here.
-- Custom SQLSTATEs (class P, 21.5): PM001 merged patient, PM002 match check required, PM003 match check stale, PM004 duplicate
-- not acknowledged, PM005 attach not allowed, PM006 already linked, PM008 patient not found or not visible.
--
-- The staff_scope derivation (6.6 scope invariant) is recompute_scope: every function that can change the derivation ends
-- with it, in the caller's transaction. Nothing else writes staff_scope or care_relationship.

-- Does the caller see this patient? The same predicate as the policies (T-PAT-*, T-STAFF, BTG, T-SYS), written once for the
-- definer functions below, which run as the function-owner role and cannot rely on the caller's policies (M-3). Internal:
-- not granted to any application role.
CREATE FUNCTION patient.caller_sees(p_id uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_aud text := kernel.setting('app.audience');
BEGIN
  IF v_aud = 'patient' THEN
    RETURN p_id = ANY (kernel.uuids('app.patient_ids'));
  ELSIF v_aud = 'staff' THEN
    IF p_id = ANY (kernel.uuids('app.btg_patient_ids')) THEN
      RETURN true;
    END IF;
    RETURN kernel.setting('app.realm') = 'google'
       AND EXISTS (SELECT 1 FROM patient.staff_scope s
                    WHERE s.patient_id = p_id AND s.location_id = ANY (kernel.uuids('app.location_ids')));
  ELSIF v_aud = 'system' THEN
    RETURN kernel.setting('app.job_scope') = 'org'
        OR (kernel.setting('app.job_scope') = 'patients' AND p_id = ANY (kernel.uuids('app.job_patient_ids')));
  END IF;
  RETURN false;
END
$$;
REVOKE ALL ON FUNCTION patient.caller_sees(uuid) FROM PUBLIC;

-- The audit row of a function that acts across scope (6.2: "Audit: yes"). Actor, realm and audience come from the settings,
-- never from an argument. The request id (or a job id) is the one thing the settings do not carry.
CREATE FUNCTION patient.write_audit(
  p_request_id uuid, p_job_id text, p_action text, p_resource_type text, p_resource_id uuid,
  p_patient_id uuid, p_location_id uuid, p_reason text, p_change jsonb
) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  INSERT INTO audit.event (event_id, organisation_id, request_id, job_id, actor_principal_id, actor_person_id, realm, audience,
                           action, resource_type, resource_id, patient_id, location_id, reason, change, outcome)
  VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), p_request_id, CASE WHEN p_request_id IS NULL THEN p_job_id END,
          kernel.uuid1('app.principal_id'), kernel.uuid1('app.person_id'),
          coalesce(kernel.setting('app.realm'), 'none'), coalesce(kernel.setting('app.audience'), 'anonymous'),
          p_action, p_resource_type, p_resource_id, p_patient_id, p_location_id, p_reason, p_change, 'allowed');
END
$$;
REVOKE ALL ON FUNCTION patient.write_audit(uuid, text, text, text, uuid, uuid, uuid, text, jsonb) FROM PUBLIC;

-- closure(S) and the derived rows (6.6): staff_scope holds (P, L) iff a survivor S that is not merged has an open care
-- relationship at L and P is in closure(S) = S plus every patient whose final survivor is S. One set-based delete and one
-- set-based insert; the sets are small (closure size x locations). Resolves a merged argument to its final survivor first.
CREATE FUNCTION patient.recompute_scope(p_patient uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_final uuid;
  v_org   uuid;
BEGIN
  SELECT coalesce(m.final_survivor_id, p.id), p.organisation_id INTO v_final, v_org
    FROM patient.patient p LEFT JOIN patient.patient_merge m ON m.merged_id = p.id
   WHERE p.id = p_patient;
  IF v_final IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM patient.staff_scope s
   WHERE s.patient_id IN (SELECT v_final UNION SELECT merged_id FROM patient.patient_merge WHERE final_survivor_id = v_final)
     AND NOT EXISTS (SELECT 1 FROM patient.care_relationship r JOIN patient.patient sp ON sp.id = r.patient_id AND sp.status = 'active'
                      WHERE r.patient_id = v_final AND r.ended_at IS NULL AND r.location_id = s.location_id);
  INSERT INTO patient.staff_scope (patient_id, location_id, organisation_id)
  SELECT c.id, r.location_id, v_org
    FROM (SELECT v_final AS id UNION SELECT merged_id FROM patient.patient_merge WHERE final_survivor_id = v_final) c
    JOIN patient.care_relationship r ON r.patient_id = v_final AND r.ended_at IS NULL
    JOIN patient.patient sp ON sp.id = v_final AND sp.status = 'active'
  ON CONFLICT DO NOTHING;
END
$$;
REVOKE ALL ON FUNCTION patient.recompute_scope(uuid) FROM PUBLIC;

-- patient.lock_patients(ids, mode) (21.6 conditions DF-5..DF-9). Locks the roots in ascending ID order with the strongest
-- mode the transaction needs. An invisible ID and a missing ID raise the same error, so it cannot probe for a patient.
CREATE FUNCTION patient.lock_patients(p_ids uuid[], p_mode text) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  SET lock_timeout = '5s'
  AS $$
DECLARE
  v_aud   text := kernel.setting('app.audience');
  v_org   uuid := kernel.uuid1('app.org_id');
  v_ids   uuid[];
  v_found integer := 0;
  r       record;
BEGIN
  IF v_org IS NULL OR v_aud IS NULL OR v_aud NOT IN ('patient', 'staff', 'system') THEN
    RAISE EXCEPTION 'lock_patients: not available to this audience' USING ERRCODE = '42501';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 10
     OR EXISTS (SELECT 1 FROM unnest(p_ids) AS x(v) WHERE x.v IS NULL)
     OR (CASE p_mode WHEN 'key_share' THEN false WHEN 'no_key_update' THEN false ELSE true END) THEN
    RAISE EXCEPTION 'lock_patients: bad argument' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT x.v ORDER BY x.v) INTO v_ids FROM unnest(p_ids) AS x(v);
  IF p_mode = 'no_key_update' THEN
    FOR r IN SELECT p.id FROM patient.patient p
              WHERE p.id = ANY (v_ids) AND p.organisation_id = v_org AND patient.caller_sees(p.id)
              ORDER BY p.id FOR NO KEY UPDATE OF p LOOP
      v_found := v_found + 1;
    END LOOP;
  ELSE
    FOR r IN SELECT p.id FROM patient.patient p
              WHERE p.id = ANY (v_ids) AND p.organisation_id = v_org AND patient.caller_sees(p.id)
              ORDER BY p.id FOR KEY SHARE OF p LOOP
      v_found := v_found + 1;
    END LOOP;
  END IF;
  IF v_found <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
END
$$;

-- patient.ensure_care_relationship(patient, location, reason): booking confirmed at L, referral accepted by L. Idempotent
-- (an open relationship is returned as it is). A staff caller must hold the location; a patient caller (booking for self or
-- as a proxy) needs only the patient. A merged patient is refused by the guard trigger on the insert.
CREATE FUNCTION patient.ensure_care_relationship(p_request_id uuid, p_patient uuid, p_location uuid, p_reason text) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_aud  text := kernel.setting('app.audience');
  v_org  uuid := kernel.uuid1('app.org_id');
  v_id   uuid;
  v_status text;
BEGIN
  IF v_org IS NULL OR v_aud NOT IN ('patient', 'staff') OR p_reason NOT IN ('booking', 'referral') THEN
    RAISE EXCEPTION 'ensure_care_relationship: not available to this caller' USING ERRCODE = '42501';
  END IF;
  IF v_aud = 'staff' AND (kernel.setting('app.realm') <> 'google' OR NOT p_location = ANY (kernel.uuids('app.location_ids'))) THEN
    RAISE EXCEPTION 'ensure_care_relationship: the location is not the caller''s' USING ERRCODE = '42501';
  END IF;
  IF NOT patient.caller_sees(p_patient) THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  SELECT p.status INTO v_status FROM patient.patient p WHERE p.id = p_patient AND p.organisation_id = v_org FOR NO KEY UPDATE OF p;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  ELSIF v_status = 'merged' THEN
    RAISE EXCEPTION 'patient.merged' USING ERRCODE = 'PM001';
  END IF;
  SELECT r.id INTO v_id FROM patient.care_relationship r
   WHERE r.patient_id = p_patient AND r.location_id = p_location AND r.ended_at IS NULL;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  v_id := gen_random_uuid();
  INSERT INTO patient.care_relationship (id, organisation_id, patient_id, location_id, reason, created_by)
  VALUES (v_id, v_org, p_patient, p_location, p_reason, kernel.uuid1('app.principal_id'));
  PERFORM patient.recompute_scope(p_patient);
  PERFORM patient.write_audit(p_request_id, NULL, 'update', 'patient.care_relationship', v_id, p_patient, p_location, NULL,
                              jsonb_build_object('reason', p_reason, 'started', true));
  RETURN v_id;
END
$$;

-- patient.end_care_relationship(patient, location, why): staff of the location only. R1 has no automatic ending (6.6).
CREATE FUNCTION patient.end_care_relationship(p_request_id uuid, p_patient uuid, p_location uuid, p_reason text) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  v_id  uuid;
  v_status text;
BEGIN
  IF v_org IS NULL OR kernel.setting('app.audience') <> 'staff' OR kernel.setting('app.realm') <> 'google'
     OR NOT p_location = ANY (kernel.uuids('app.location_ids')) THEN
    RAISE EXCEPTION 'end_care_relationship: not available to this caller' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'end_care_relationship: bad argument' USING ERRCODE = '22023';
  END IF;
  IF NOT patient.caller_sees(p_patient) THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  SELECT p.status INTO v_status FROM patient.patient p WHERE p.id = p_patient AND p.organisation_id = v_org FOR NO KEY UPDATE OF p;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  ELSIF v_status = 'merged' THEN
    RAISE EXCEPTION 'patient.merged' USING ERRCODE = 'PM001';
  END IF;
  UPDATE patient.care_relationship SET ended_at = now(), ended_reason = btrim(p_reason)
   WHERE patient_id = p_patient AND location_id = p_location AND ended_at IS NULL
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  PERFORM patient.recompute_scope(p_patient);
  PERFORM patient.write_audit(p_request_id, NULL, 'update', 'patient.care_relationship', v_id, p_patient, p_location, NULL,
                              jsonb_build_object('ended', true));
  RETURN true;
END
$$;

-- The derivation of 6.6 for one organisation, as a set: (P, L) for every closure member P of every active survivor with an
-- open relationship at L. Internal (invoker); the drift check compares it with the table and repairs from it.
CREATE FUNCTION patient.derived_scope(p_org uuid) RETURNS TABLE (patient_id uuid, location_id uuid, organisation_id uuid)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
  AS $$
  SELECT c.id, r.location_id, sp.organisation_id
    FROM patient.patient sp
    JOIN patient.care_relationship r ON r.patient_id = sp.id AND r.ended_at IS NULL
    JOIN LATERAL (SELECT sp.id AS id UNION SELECT m.merged_id FROM patient.patient_merge m WHERE m.final_survivor_id = sp.id) c ON true
   WHERE sp.status = 'active' AND sp.organisation_id = p_org
$$;
REVOKE ALL ON FUNCTION patient.derived_scope(uuid) FROM PUBLIC;

-- patient.verify_staff_scope(): the organisation-wide drift check (6.6). Recomputes the whole derivation, compares it with the
-- table, repairs through the same derivation and returns the two counts. No identifiers leave the function: a missing row
-- hides history from the staff who care for the patient (safety), an extra row exposes a patient to a location that does not
-- (privacy), and the caller raises the matching alert. The job writes the summary audit row (the audit insert policy of
-- patient_scope_owner does not cover audience system, and the summary is the job's, not the function's).
CREATE FUNCTION patient.verify_staff_scope() RETURNS TABLE (missing_rows bigint, extra_rows bigint)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org     uuid := kernel.uuid1('app.org_id');
  v_missing bigint;
  v_extra   bigint;
BEGIN
  IF v_org IS NULL OR kernel.setting('app.audience') <> 'system' OR kernel.setting('app.job_scope') <> 'org' THEN
    RAISE EXCEPTION 'verify_staff_scope: only an organisation-wide job may call this' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_missing FROM patient.derived_scope(v_org) w
   WHERE NOT EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = w.patient_id AND s.location_id = w.location_id);
  SELECT count(*) INTO v_extra FROM patient.staff_scope s
   WHERE s.organisation_id = v_org
     AND NOT EXISTS (SELECT 1 FROM patient.derived_scope(v_org) w WHERE w.patient_id = s.patient_id AND w.location_id = s.location_id);
  IF v_extra > 0 THEN
    DELETE FROM patient.staff_scope s
     WHERE s.organisation_id = v_org
       AND NOT EXISTS (SELECT 1 FROM patient.derived_scope(v_org) w WHERE w.patient_id = s.patient_id AND w.location_id = s.location_id);
  END IF;
  IF v_missing > 0 THEN
    INSERT INTO patient.staff_scope (patient_id, location_id, organisation_id)
    SELECT w.patient_id, w.location_id, w.organisation_id FROM patient.derived_scope(v_org) w ON CONFLICT DO NOTHING;
  END IF;
  RETURN QUERY SELECT v_missing, v_extra;
END
$$;
