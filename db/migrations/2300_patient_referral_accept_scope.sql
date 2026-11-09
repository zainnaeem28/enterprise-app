-- migration-class: expand
-- INT03-F08d, ruling HEAAA-325 rev e3fa32f4, G2 delta decision HEAAA-330, ARCHITECTURE amendment A-4 (section 5 of the ruling).
-- The receiving location's accept/decline: a referral-bound root lock and care-relationship create (R-REF-1..8).
-- caller_sees and every read predicate are unchanged.

-- (a) What patient_scope_owner may read of a referral: a SENT internal referral addressed to one of the staff caller's
--     locations, and its PENDING inbox row. Columns limited; no reason, no free text.
GRANT USAGE ON SCHEMA clinical TO patient_scope_owner;
GRANT SELECT (id, organisation_id, patient_id, status, target_kind, target_location_id) ON clinical.referral TO patient_scope_owner;
GRANT SELECT (referral_id, organisation_id, target_location_id, status) ON clinical.referral_inbox TO patient_scope_owner;
CREATE POLICY referral_scope_owner_select ON clinical.referral
  FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND status = 'sent' AND target_kind IN ('internal_location', 'internal_service')
     AND target_location_id = ANY (kernel.uuids('app.location_ids')));
CREATE POLICY inbox_scope_owner_select ON clinical.referral_inbox
  FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google'
     AND status = 'pending' AND target_location_id = ANY (kernel.uuids('app.location_ids')));

-- (b) The one predicate (internal, invoker; runs as the definer that calls it). It repeats the policy conditions on purpose,
--     so that a later widening of a policy does not widen this rule. Two-valued: NULL settings or arguments give false (F-02).
CREATE FUNCTION patient.referral_pending_for_caller(p_referral_id uuid, p_patient uuid, p_location uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
  AS $$
  SELECT coalesce(
           kernel.setting('app.audience') = 'staff' AND kernel.setting('app.realm') = 'google'
       AND p_location = ANY (kernel.uuids('app.location_ids'))
       AND EXISTS (SELECT 1 FROM clinical.referral r
                     JOIN clinical.referral_inbox i ON i.referral_id = r.id AND i.organisation_id = r.organisation_id
                    WHERE r.id = p_referral_id AND r.patient_id = p_patient AND r.organisation_id = kernel.uuid1('app.org_id')
                      AND r.status = 'sent' AND r.target_kind IN ('internal_location', 'internal_service')
                      AND r.target_location_id = p_location AND i.target_location_id = p_location AND i.status = 'pending'),
           false)
$$;
REVOKE ALL ON FUNCTION patient.referral_pending_for_caller(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient.referral_pending_for_caller(uuid, uuid, uuid) TO patient_scope_owner;

-- (c) Root lock for the accept/decline transaction (O-6). Same contract as lock_patients (DF-5, DF-8, DF-9, one error for
--     missing and invisible), with the referral-bound basis instead of caller_sees. Returns nothing.
CREATE FUNCTION patient.lock_referral_patient(p_referral_id uuid, p_patient uuid, p_mode text) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  SET lock_timeout = '5s'
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  v_loc uuid;
BEGIN
  IF v_org IS NULL OR kernel.setting('app.audience') IS DISTINCT FROM 'staff' OR kernel.setting('app.realm') IS DISTINCT FROM 'google' THEN
    RAISE EXCEPTION 'lock_referral_patient: not available to this caller' USING ERRCODE = '42501';
  END IF;
  IF p_referral_id IS NULL OR p_patient IS NULL
     OR (CASE p_mode WHEN 'key_share' THEN false WHEN 'no_key_update' THEN false ELSE true END) THEN
    RAISE EXCEPTION 'lock_referral_patient: bad argument' USING ERRCODE = '22023';
  END IF;
  SELECT r.target_location_id INTO v_loc FROM clinical.referral r WHERE r.id = p_referral_id;
  IF v_loc IS NULL OR patient.referral_pending_for_caller(p_referral_id, p_patient, v_loc) IS NOT TRUE THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  IF p_mode = 'no_key_update' THEN
    PERFORM 1 FROM patient.patient p WHERE p.id = p_patient AND p.organisation_id = v_org FOR NO KEY UPDATE OF p;
  ELSE
    PERFORM 1 FROM patient.patient p WHERE p.id = p_patient AND p.organisation_id = v_org FOR KEY SHARE OF p;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
END
$$;

-- (d) The accept's care relationship. Patient and location come from the referral row only (22.11 draft 7).
--     Idempotent like ensure_care_relationship; merged -> PM001.
CREATE FUNCTION patient.ensure_referral_care_relationship(p_request_id uuid, p_referral_id uuid) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org     uuid := kernel.uuid1('app.org_id');
  v_patient uuid;
  v_loc     uuid;
  v_status  text;
  v_id      uuid;
BEGIN
  IF v_org IS NULL OR kernel.setting('app.audience') IS DISTINCT FROM 'staff' OR kernel.setting('app.realm') IS DISTINCT FROM 'google' THEN
    RAISE EXCEPTION 'ensure_referral_care_relationship: not available to this caller' USING ERRCODE = '42501';
  END IF;
  IF p_referral_id IS NULL THEN
    RAISE EXCEPTION 'ensure_referral_care_relationship: bad argument' USING ERRCODE = '22023';
  END IF;
  SELECT r.patient_id, r.target_location_id INTO v_patient, v_loc FROM clinical.referral r WHERE r.id = p_referral_id;
  IF v_patient IS NULL OR v_loc IS NULL OR patient.referral_pending_for_caller(p_referral_id, v_patient, v_loc) IS NOT TRUE THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  SELECT p.status INTO v_status FROM patient.patient p WHERE p.id = v_patient AND p.organisation_id = v_org FOR NO KEY UPDATE OF p;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  ELSIF v_status = 'merged' THEN
    RAISE EXCEPTION 'patient.merged' USING ERRCODE = 'PM001';
  END IF;
  SELECT c.id INTO v_id FROM patient.care_relationship c
   WHERE c.patient_id = v_patient AND c.location_id = v_loc AND c.ended_at IS NULL;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  v_id := gen_random_uuid();
  INSERT INTO patient.care_relationship (id, organisation_id, patient_id, location_id, reason, created_by)
  VALUES (v_id, v_org, v_patient, v_loc, 'referral', kernel.uuid1('app.principal_id'));
  PERFORM patient.recompute_scope(v_patient);
  PERFORM patient.write_audit(p_request_id, NULL, 'update', 'patient.care_relationship', v_id, v_patient, v_loc, NULL,
                              jsonb_build_object('reason', 'referral', 'started', true, 'referral_id', p_referral_id));
  RETURN v_id;
END
$$;

-- (e) R-REF-6: the origin guard of 0904 (owned by app_owner, invoker, runs as the writing role) now requires the referral.
CREATE OR REPLACE FUNCTION patient.guard_care_relationship_origin() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.reason = 'referral' THEN
    IF kernel.setting('app.audience') IS DISTINCT FROM 'staff' THEN
      RAISE EXCEPTION 'a referral is accepted by staff' USING ERRCODE = '42501';
    END IF;
    IF NEW.patient_id IS NULL OR NEW.location_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM clinical.referral r
           JOIN clinical.referral_inbox i ON i.referral_id = r.id AND i.organisation_id = r.organisation_id
          WHERE r.patient_id = NEW.patient_id AND r.target_location_id = NEW.location_id AND r.organisation_id = NEW.organisation_id
            AND r.status = 'sent' AND r.target_kind IN ('internal_location', 'internal_service')
            AND i.target_location_id = NEW.location_id AND i.status = 'pending') THEN
      RAISE EXCEPTION 'no pending referral of this patient to this location' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.reason = 'booking' AND NOT EXISTS (
       SELECT 1 FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
        WHERE r.patient_id = NEW.patient_id AND r.location_id = NEW.location_id AND r.organisation_id = NEW.organisation_id
          AND o.status IN ('confirmed', 'checked_in', 'in_consultation', 'completed')) THEN
    RAISE EXCEPTION 'no confirmed appointment of this patient at this location' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- (f) Privileges first, then the owner (0704 pattern); CREATE on the schema only for the transfer.
REVOKE ALL ON FUNCTION patient.lock_referral_patient(uuid, uuid, text), patient.ensure_referral_care_relationship(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient.lock_referral_patient(uuid, uuid, text), patient.ensure_referral_care_relationship(uuid, uuid) TO app_api;
GRANT CREATE ON SCHEMA patient TO patient_scope_owner;
ALTER FUNCTION patient.lock_referral_patient(uuid, uuid, text) OWNER TO patient_scope_owner;
ALTER FUNCTION patient.ensure_referral_care_relationship(uuid, uuid) OWNER TO patient_scope_owner;
REVOKE CREATE ON SCHEMA patient FROM patient_scope_owner;
