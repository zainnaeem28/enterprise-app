-- migration-class: expand
-- Duplicate matching, registration, attach and the identity label (SHARED-BOUNDARIES 6.2, 6.6, 6.7; ARCHITECTURE 25.3; BR-37;
-- ticket BE-08), then function ownership, EXECUTE lists and the withdrawal of the temporary CREATE right on the schema.
--
--   patient.match_candidates   patient_match_owner   staff with a location; at most 5 candidates; audit `search`, no terms
--   patient.register           patient_scope_owner   front desk (staff) or self-registration (patient); one transaction
--   patient.attach             patient_scope_owner   BQ-4 default: exact match, patient present, candidate from a match check
--   patient.identity_label     patient_match_owner   admin_pool with the patient_label slice key; audit `view`
--
-- The matching rule itself (match_core) is an invoker function that both owner roles call under their own column grants, so
-- the self-registration path can find duplicates inside the register transaction without a second definer function.

-- match_core: the candidates for one set of searched values. Strength `exact`: given name, family name and date of birth equal
-- and the phone or the e-mail equal (the BQ-4 attach condition). `probable`: family name and date of birth equal; or given and
-- family name equal with the phone or e-mail; or date of birth equal with the phone or e-mail and one of the names. A merged
-- patient is never returned: its match resolves to the final survivor (SBR-12). At most 5, strongest first.
CREATE FUNCTION patient.match_core(
  p_org uuid, p_given text, p_family text, p_dob date, p_phone text, p_email text, p_exclude uuid
) RETURNS TABLE (patient_id uuid, strength text, matched text[])
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
  AS $$
  WITH cand AS (
    SELECT p.id,
           (lower(btrim(p.given_name)) = lower(btrim(p_given)))   AS g,
           (lower(btrim(p.family_name)) = lower(btrim(p_family))) AS f,
           (p.date_of_birth = p_dob)                              AS d,
           (p_phone IS NOT NULL AND p.phone_e164 = p_phone)       AS ph,
           (p_email IS NOT NULL AND p.email = lower(p_email))     AS em
      FROM patient.patient p
     WHERE p.organisation_id = p_org
       AND p.id IS DISTINCT FROM p_exclude
       AND ((lower(p.family_name) = lower(btrim(p_family)) AND p.date_of_birth = p_dob)
            OR (p_phone IS NOT NULL AND p.phone_e164 = p_phone)
            OR (p_email IS NOT NULL AND p.email = lower(p_email)))
  ), scored AS (
    SELECT c.*,
           CASE WHEN c.g AND c.f AND c.d AND (c.ph OR c.em) THEN 'exact'
                WHEN (c.f AND c.d) OR (c.g AND c.f AND (c.ph OR c.em)) OR (c.d AND (c.ph OR c.em) AND (c.g OR c.f)) THEN 'probable'
           END AS strength
      FROM cand c
  ), resolved AS (
    SELECT coalesce(m.final_survivor_id, s.id) AS rid, s.strength, s.g, s.f, s.d, s.ph, s.em
      FROM scored s LEFT JOIN patient.patient_merge m ON m.merged_id = s.id
     WHERE s.strength IS NOT NULL
  )
  SELECT r.rid,
         CASE WHEN bool_or(r.strength = 'exact') THEN 'exact' ELSE 'probable' END,
         array_remove(ARRAY[CASE WHEN bool_or(r.g) THEN 'given_name' END, CASE WHEN bool_or(r.f) THEN 'family_name' END,
                            CASE WHEN bool_or(r.d) THEN 'date_of_birth' END, CASE WHEN bool_or(r.ph) THEN 'phone' END,
                            CASE WHEN bool_or(r.em) THEN 'email' END], NULL)
    FROM resolved r
   WHERE r.rid IS DISTINCT FROM p_exclude
   GROUP BY r.rid
   ORDER BY (bool_or(r.strength = 'exact')) DESC,
            (bool_or(r.g)::int + bool_or(r.f)::int + bool_or(r.d)::int + bool_or(r.ph)::int + bool_or(r.em)::int) DESC,
            r.rid
   LIMIT 5
$$;
REVOKE ALL ON FUNCTION patient.match_core(uuid, text, text, date, text, text, uuid) FROM PUBLIC;

-- patient.match_candidates (6.6, 25.3): the staff search before a registration. Stores the match check (a keyed hash of the
-- values, never the values) and returns its ID with the candidates. In-scope candidates carry their patient ID so the API can
-- load display data under the caller's own RLS; out-of-scope candidates carry nothing but the strength and the matched fields.
CREATE FUNCTION patient.match_candidates(
  p_request_id uuid, p_given text, p_family text, p_dob date, p_phone text, p_email text, p_values_hash bytea, p_location uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org        uuid := kernel.uuid1('app.org_id');
  v_principal  uuid := kernel.uuid1('app.principal_id');
  v_check      uuid := gen_random_uuid();
  v_refs       uuid[] := '{}';
  v_ids        uuid[] := '{}';
  v_strengths  text[] := '{}';
  v_out        jsonb := '[]'::jsonb;
  v_ref        uuid;
  v_in         boolean;
  r            record;
BEGIN
  IF v_org IS NULL OR v_principal IS NULL OR kernel.setting('app.audience') <> 'staff' OR kernel.setting('app.realm') <> 'google'
     OR p_location IS NULL OR NOT p_location = ANY (kernel.uuids('app.location_ids')) THEN
    RAISE EXCEPTION 'match_candidates: not available to this caller' USING ERRCODE = '42501';
  END IF;
  IF p_given IS NULL OR char_length(btrim(p_given)) NOT BETWEEN 1 AND 100 OR p_family IS NULL OR char_length(btrim(p_family)) NOT BETWEEN 1 AND 100
     OR p_dob IS NULL OR p_values_hash IS NULL OR octet_length(p_values_hash) <> 32
     OR (p_phone IS NOT NULL AND p_phone !~ '^\+[1-9][0-9]{6,14}$')
     OR (p_email IS NOT NULL AND char_length(p_email) > 320) THEN
    RAISE EXCEPTION 'match_candidates: bad argument' USING ERRCODE = '22023';
  END IF;
  FOR r IN SELECT * FROM patient.match_core(v_org, p_given, p_family, p_dob, nullif(p_phone, ''), nullif(lower(p_email), ''), NULL) LOOP
    v_ref := gen_random_uuid();
    v_in := patient.caller_sees(r.patient_id);
    v_refs := v_refs || v_ref;
    v_ids := v_ids || r.patient_id;
    v_strengths := v_strengths || r.strength;
    v_out := v_out || jsonb_build_array(
      jsonb_build_object('candidateRef', v_ref, 'strength', r.strength, 'matchedFields', to_jsonb(r.matched), 'inScope', v_in)
      || CASE WHEN v_in THEN jsonb_build_object('patientId', r.patient_id) ELSE '{}'::jsonb END);
  END LOOP;
  INSERT INTO patient.match_check (id, organisation_id, principal_id, location_id, values_hash, candidate_refs, candidate_patient_ids,
                                   candidate_strengths, expires_at)
  VALUES (v_check, v_org, v_principal, p_location, p_values_hash, v_refs, v_ids, v_strengths, now() + interval '15 minutes');
  PERFORM patient.write_audit(p_request_id, NULL, 'search', 'patient.patient', NULL, NULL, p_location, NULL,
                              jsonb_build_object('candidates', cardinality(v_refs)));
  RETURN jsonb_build_object('matchCheckId', v_check, 'candidates', v_out);
END
$$;

-- The match-check proof shared by register and attach (25.3): the caller's own, unused, unexpired check for the same values and
-- the same location. PM002 when there is none, PM003 when it is expired or for other values.
CREATE FUNCTION patient.take_match_check(p_check uuid, p_hash bytea, p_location uuid) RETURNS patient.match_check
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  mc patient.match_check;
BEGIN
  SELECT * INTO mc FROM patient.match_check c
   WHERE c.id = p_check AND c.organisation_id = kernel.uuid1('app.org_id') AND c.principal_id = kernel.uuid1('app.principal_id')
   FOR UPDATE;
  IF NOT FOUND OR mc.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'patient.match_check_required' USING ERRCODE = 'PM002';
  END IF;
  IF mc.expires_at <= now() OR p_hash IS NULL OR mc.values_hash IS DISTINCT FROM p_hash OR mc.location_id IS DISTINCT FROM p_location THEN
    RAISE EXCEPTION 'patient.match_check_stale' USING ERRCODE = 'PM003';
  END IF;
  RETURN mc;
END
$$;
REVOKE ALL ON FUNCTION patient.take_match_check(uuid, bytea, uuid) FROM PUBLIC;

-- The same proof for attach, which has no searched values to hash: the candidate reference alone names the caller's check
-- (the references are random UUIDs, unique across checks). Same errors as above.
CREATE FUNCTION patient.take_match_check_by_ref(p_ref uuid, p_location uuid) RETURNS patient.match_check
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  mc patient.match_check;
BEGIN
  SELECT * INTO mc FROM patient.match_check c
   WHERE p_ref IS NOT NULL AND c.candidate_refs @> ARRAY[p_ref]
     AND c.organisation_id = kernel.uuid1('app.org_id') AND c.principal_id = kernel.uuid1('app.principal_id')
   FOR UPDATE;
  IF NOT FOUND OR mc.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'patient.match_check_required' USING ERRCODE = 'PM002';
  END IF;
  IF mc.expires_at <= now() OR mc.location_id IS DISTINCT FROM p_location THEN
    RAISE EXCEPTION 'patient.match_check_stale' USING ERRCODE = 'PM003';
  END IF;
  RETURN mc;
END
$$;
REVOKE ALL ON FUNCTION patient.take_match_check_by_ref(uuid, uuid) FROM PUBLIC;

-- patient.register (6.6, 25.3). Front desk: the patient, the care relationship at L and the scope rows in one transaction,
-- after a match check; any candidate needs an acknowledgement with a reason, and each active candidate gets a duplicate flag.
-- Self-registration (patient audience): the patient and the identity link only, no relationship and no scope; the match runs
-- here and only raises flags, so the patient learns nothing about other records. The first booking's relationship then
-- brings the flag into the work queue of that location (the flag follows the patient ID).
CREATE FUNCTION patient.register(
  p_request_id uuid, p_match_check_id uuid, p_values_hash bytea, p_duplicate_acknowledged boolean, p_acknowledge_reason text,
  p_given_name text, p_family_name text, p_middle_name text, p_date_of_birth date, p_sex_at_birth text, p_gender_identity text,
  p_phone text, p_email text, p_address jsonb, p_state_code text, p_language text, p_preferred_pharmacy jsonb, p_location uuid
) RETURNS TABLE (patient_id uuid, mrn text, duplicate_flags integer)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_aud       text := kernel.setting('app.audience');
  v_org       uuid := kernel.uuid1('app.org_id');
  v_principal uuid := kernel.uuid1('app.principal_id');
  v_id        uuid := gen_random_uuid();
  v_mrn       text;
  v_flags     integer := 0;
  v_rel       uuid;
  mc          patient.match_check;
  r           record;
  i           integer;
  v_phone     text := nullif(btrim(p_phone), '');
  v_email     text := nullif(lower(btrim(p_email)), '');
BEGIN
  IF v_org IS NULL OR v_principal IS NULL THEN
    RAISE EXCEPTION 'register: not available to this caller' USING ERRCODE = '42501';
  END IF;
  v_mrn := 'MRN-' || nextval('patient.mrn_seq')::text;

  IF v_aud = 'staff' AND kernel.setting('app.realm') = 'google' THEN
    IF p_location IS NULL OR NOT p_location = ANY (kernel.uuids('app.location_ids')) THEN
      RAISE EXCEPTION 'register: the location is not the caller''s' USING ERRCODE = '42501';
    END IF;
    mc := patient.take_match_check(p_match_check_id, p_values_hash, p_location);
    -- Candidate roots are locked before anything is written (25.2 rule 1): a merge of a candidate waits for this transaction
    -- or finishes first, and a candidate merged in the meantime gets no flag.
    PERFORM 1 FROM patient.patient c WHERE c.id = ANY (mc.candidate_patient_ids) ORDER BY c.id FOR KEY SHARE OF c;
    IF cardinality(mc.candidate_patient_ids) > 0
       AND (p_duplicate_acknowledged IS NOT TRUE OR p_acknowledge_reason IS NULL OR char_length(btrim(p_acknowledge_reason)) NOT BETWEEN 1 AND 500) THEN
      RAISE EXCEPTION 'patient.duplicate_acknowledgement_required' USING ERRCODE = 'PM004';
    END IF;
    INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, middle_name, date_of_birth, sex_at_birth,
                                 gender_identity, phone_e164, email, address, state_code, preferred_language, preferred_pharmacy,
                                 created_via, created_by)
    VALUES (v_id, v_org, v_mrn, btrim(p_given_name), btrim(p_family_name), nullif(btrim(p_middle_name), ''), p_date_of_birth,
            p_sex_at_birth, nullif(btrim(p_gender_identity), ''), v_phone, v_email, p_address, p_state_code,
            coalesce(p_language, 'en'), p_preferred_pharmacy, 'front_desk', v_principal);
    v_rel := gen_random_uuid();
    INSERT INTO patient.care_relationship (id, organisation_id, patient_id, location_id, reason, created_by)
    VALUES (v_rel, v_org, v_id, p_location, 'registration', v_principal);
    PERFORM patient.recompute_scope(v_id);
    FOR i IN 1 .. cardinality(mc.candidate_patient_ids) LOOP
      -- a candidate merged since the check is skipped: the flag would name a record that can no longer be written
      IF EXISTS (SELECT 1 FROM patient.patient c WHERE c.id = mc.candidate_patient_ids[i] AND c.status = 'active') THEN
        INSERT INTO patient.duplicate_flag (id, organisation_id, patient_id, candidate_patient_id, strength, source, created_by)
        VALUES (gen_random_uuid(), v_org, v_id, mc.candidate_patient_ids[i], mc.candidate_strengths[i], 'front_desk', v_principal)
        ON CONFLICT DO NOTHING;
        v_flags := v_flags + 1;
      END IF;
    END LOOP;
    UPDATE patient.match_check SET used_at = now() WHERE id = mc.id;
    PERFORM patient.write_audit(p_request_id, NULL, 'create', 'patient.patient', v_id, v_id, p_location,
                                nullif(btrim(p_acknowledge_reason), ''),
                                jsonb_build_object('createdVia', 'front_desk', 'duplicateFlags', v_flags));

  ELSIF v_aud = 'patient' AND kernel.setting('app.realm') = 'patient_pool' THEN
    IF p_location IS NOT NULL THEN
      RAISE EXCEPTION 'register: a self-registration has no location' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('plink:' || v_principal::text));
    IF EXISTS (SELECT 1 FROM identity.patient_link l WHERE l.principal_id = v_principal) THEN
      RAISE EXCEPTION 'patient.already_linked' USING ERRCODE = 'PM006';
    END IF;
    INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, middle_name, date_of_birth, sex_at_birth,
                                 gender_identity, phone_e164, email, address, state_code, preferred_language, preferred_pharmacy,
                                 created_via, created_by)
    VALUES (v_id, v_org, v_mrn, btrim(p_given_name), btrim(p_family_name), nullif(btrim(p_middle_name), ''), p_date_of_birth,
            p_sex_at_birth, nullif(btrim(p_gender_identity), ''), v_phone, v_email, p_address, p_state_code,
            coalesce(p_language, 'en'), p_preferred_pharmacy, 'self', v_principal);
    INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind, created_by)
    VALUES (v_principal, v_id, v_org, 'self', v_principal);
    FOR r IN SELECT * FROM patient.match_core(v_org, p_given_name, p_family_name, p_date_of_birth, v_phone, v_email, v_id) LOOP
      -- lock the candidate root, then re-check that it is still active (a merge of it waits for this transaction)
      PERFORM 1 FROM patient.patient c WHERE c.id = r.patient_id AND c.status = 'active' FOR KEY SHARE OF c;
      IF FOUND THEN
        INSERT INTO patient.duplicate_flag (id, organisation_id, patient_id, candidate_patient_id, strength, source, created_by)
        VALUES (gen_random_uuid(), v_org, v_id, r.patient_id, r.strength, 'self_registration', v_principal)
        ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
    PERFORM patient.write_audit(p_request_id, NULL, 'create', 'patient.patient', v_id, v_id, NULL, NULL,
                                jsonb_build_object('createdVia', 'self'));
    v_flags := 0; -- never reported to the patient
  ELSE
    RAISE EXCEPTION 'register: not available to this caller' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT v_id, v_mrn, v_flags;
END
$$;

-- patient.attach (BQ-4 default, 6.6): front-desk staff at L attach an out-of-scope candidate only when the candidate came from
-- the caller's own match check, the match was exact (name, date of birth and phone or e-mail) and the patient is present to
-- confirm. Audited `care_attach` and listed in the compliance report.
CREATE FUNCTION patient.attach(
  p_request_id uuid, p_candidate_ref uuid, p_patient uuid, p_location uuid, p_patient_present boolean
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  v_principal uuid := kernel.uuid1('app.principal_id');
  mc  patient.match_check;
  idx integer;
  v_status text;
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_principal IS NULL OR kernel.setting('app.audience') <> 'staff' OR kernel.setting('app.realm') <> 'google'
     OR p_location IS NULL OR NOT p_location = ANY (kernel.uuids('app.location_ids')) THEN
    RAISE EXCEPTION 'attach: not available to this caller' USING ERRCODE = '42501';
  END IF;
  mc := patient.take_match_check_by_ref(p_candidate_ref, p_location);
  idx := array_position(mc.candidate_refs, p_candidate_ref);
  IF idx IS NULL OR mc.candidate_patient_ids[idx] IS DISTINCT FROM p_patient OR mc.candidate_strengths[idx] <> 'exact'
     OR p_patient_present IS NOT TRUE THEN
    RAISE EXCEPTION 'patient.attach_not_allowed' USING ERRCODE = 'PM005';
  END IF;
  SELECT p.status INTO v_status FROM patient.patient p WHERE p.id = p_patient AND p.organisation_id = v_org FOR NO KEY UPDATE OF p;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  ELSIF v_status = 'merged' THEN
    RAISE EXCEPTION 'patient.merged' USING ERRCODE = 'PM001';
  END IF;
  SELECT r.id INTO v_id FROM patient.care_relationship r WHERE r.patient_id = p_patient AND r.location_id = p_location AND r.ended_at IS NULL;
  IF v_id IS NULL THEN
    v_id := gen_random_uuid();
    INSERT INTO patient.care_relationship (id, organisation_id, patient_id, location_id, reason, created_by)
    VALUES (v_id, v_org, p_patient, p_location, 'attach', v_principal);
    PERFORM patient.recompute_scope(p_patient);
  END IF;
  UPDATE patient.match_check SET used_at = now() WHERE id = mc.id;
  PERFORM patient.write_audit(p_request_id, NULL, 'care_attach', 'patient.care_relationship', v_id, p_patient, p_location, NULL,
                              jsonb_build_object('strength', 'exact', 'patientPresent', true));
  RETURN v_id;
END
$$;

-- patient.identity_label (6.7): name, date of birth and record number of ONE patient, for an admin_pool principal that holds
-- the patient_label slice key (app.compliance_scopes, derived from its permission). The API has already read the referencing
-- record under the caller's RLS (O-5) and passes its type and ID, which the audit row names. A merged patient answers with
-- the survivor.
CREATE FUNCTION patient.identity_label(p_request_id uuid, p_patient uuid, p_ref_type text, p_ref_id uuid) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  p patient.patient;
  v_final uuid;
BEGIN
  IF v_org IS NULL OR kernel.setting('app.audience') <> 'staff' OR kernel.setting('app.realm') <> 'admin_pool'
     OR kernel.setting('app.phi_access') IS DISTINCT FROM 'limited'
     OR NOT 'patient_label' = ANY (string_to_array(coalesce(kernel.setting('app.compliance_scopes'), ''), ',')) THEN
    RAISE EXCEPTION 'identity_label: not available to this caller' USING ERRCODE = '42501';
  END IF;
  IF p_patient IS NULL OR p_ref_id IS NULL OR p_ref_type IS NULL
     OR p_ref_type NOT IN ('audit.event', 'privacy.request', 'patient.consent', 'privacy.incident') THEN
    RAISE EXCEPTION 'patient.label_reference_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO p FROM patient.patient x WHERE x.id = p_patient AND x.organisation_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  PERFORM patient.write_audit(p_request_id, NULL, 'view', p_ref_type, p_ref_id, p_patient, NULL, NULL,
                              jsonb_build_object('label', true));
  IF p.status = 'merged' THEN
    SELECT m.final_survivor_id INTO v_final FROM patient.patient_merge m WHERE m.merged_id = p.id;
    RETURN jsonb_build_object('givenName', p.given_name, 'familyName', p.family_name, 'dateOfBirth', p.date_of_birth,
                              'mrn', p.mrn, 'merged', true, 'survivorId', coalesce(v_final, p.merged_into));
  END IF;
  RETURN jsonb_build_object('givenName', p.given_name, 'familyName', p.family_name, 'dateOfBirth', p.date_of_birth,
                            'mrn', p.mrn, 'merged', false);
END
$$;

-- The match owner reads the merge map and the scope table (to say whether a candidate is in the caller's scope).
CREATE POLICY merge_map_match_owner_select ON patient.patient_merge
  FOR SELECT TO patient_match_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff');
CREATE POLICY scope_match_owner_select ON patient.staff_scope
  FOR SELECT TO patient_match_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff');
GRANT SELECT ON patient.patient_merge TO patient_match_owner;
GRANT SELECT ON patient.staff_scope TO patient_match_owner;
-- identity_label audits through the match owner's INSERT right on audit.event (0203) and reads the merged patient's label.

-- Ownership and EXECUTE ----------------------------------------------------------------------------------------------
-- Privileges first, then the owner: once a function-owner role owns a function, app_owner (SET-only membership, INHERIT
-- FALSE) can no longer grant or revoke on it.
REVOKE ALL ON FUNCTION patient.lock_patients(uuid[], text), patient.ensure_care_relationship(uuid, uuid, uuid, text),
  patient.end_care_relationship(uuid, uuid, uuid, text), patient.verify_staff_scope(),
  patient.register(uuid, uuid, bytea, boolean, text, text, text, text, date, text, text, text, text, jsonb, text, text, jsonb, uuid),
  patient.attach(uuid, uuid, uuid, uuid, boolean),
  patient.match_candidates(uuid, text, text, date, text, text, bytea, uuid), patient.identity_label(uuid, uuid, text, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient.lock_patients(uuid[], text) TO app_api, app_worker;
GRANT EXECUTE ON FUNCTION patient.ensure_care_relationship(uuid, uuid, uuid, text), patient.end_care_relationship(uuid, uuid, uuid, text),
  patient.register(uuid, uuid, bytea, boolean, text, text, text, text, date, text, text, text, text, jsonb, text, text, jsonb, uuid),
  patient.attach(uuid, uuid, uuid, uuid, boolean),
  patient.match_candidates(uuid, text, text, date, text, text, bytea, uuid), patient.identity_label(uuid, uuid, text, uuid)
  TO app_api;
GRANT EXECUTE ON FUNCTION patient.verify_staff_scope() TO app_worker;

-- The invoker helpers run as the definer that calls them.
GRANT EXECUTE ON FUNCTION patient.caller_sees(uuid), patient.write_audit(uuid, text, text, text, uuid, uuid, uuid, text, jsonb),
  patient.match_core(uuid, text, text, date, text, text, uuid) TO patient_scope_owner, patient_match_owner;
GRANT EXECUTE ON FUNCTION patient.recompute_scope(uuid), patient.derived_scope(uuid), patient.take_match_check(uuid, bytea, uuid),
  patient.take_match_check_by_ref(uuid, uuid) TO patient_scope_owner;

ALTER FUNCTION patient.guard_open_patient() OWNER TO patient_scope_owner;
ALTER FUNCTION patient.lock_patients(uuid[], text) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.ensure_care_relationship(uuid, uuid, uuid, text) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.end_care_relationship(uuid, uuid, uuid, text) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.verify_staff_scope() OWNER TO patient_scope_owner;
ALTER FUNCTION patient.register(uuid, uuid, bytea, boolean, text, text, text, text, date, text, text, text, text, jsonb, text, text, jsonb, uuid)
  OWNER TO patient_scope_owner;
ALTER FUNCTION patient.attach(uuid, uuid, uuid, uuid, boolean) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.match_candidates(uuid, text, text, date, text, text, bytea, uuid) OWNER TO patient_match_owner;
ALTER FUNCTION patient.identity_label(uuid, uuid, text, uuid) OWNER TO patient_match_owner;

-- The CREATE right on the schema was needed only to move the ownership above.
REVOKE CREATE ON SCHEMA patient FROM patient_scope_owner, patient_match_owner;
