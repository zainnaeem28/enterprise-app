-- migration-class: expand
-- INT04-F02b (HEAAA-466; finding SEC02-F02; decision log docs/evidence/integration/M5/INT04-F02b-DECISION-LOG.md revision 5,
-- ARCHITECTURE amendment A-6, SHARED-BOUNDARIES SB-A4): identity.bootstrap_admins, the one SECURITY DEFINER function that creates
-- the first two admin_pool principals, their two org_admin assignments and their two approved enrolment tokens, in one transaction,
-- with the C4 triggers (2401) staying in force. Owner: the NOLOGIN role identity_bootstrap_owner. EXECUTE: the login role
-- app_bootstrap only (db/roles). No running service can call it; reaching it needs the dual-controlled bootstrap pipeline
-- (DEVOPS-PLAN 16.2). The function never sees a plain token: it takes the two SHA-256 hashes the command computed.
--
-- The grants and policies below are the COMPLETE list G-1..G-14 of decision log 2.1 (G-14 is in packages/kernel/src/queue/harden.sql).
-- Every policy is TO identity_bootstrap_owner and is gated on the organisation, on current_user and on audience `system`, which the
-- function sets itself after checking its caller (SHARED-BOUNDARIES 6.2 rule 3). No Setting is read: the two bounds and the 30 minute
-- lifetime are constants in the function body (decision log 2.1, notes).

-- G-1, G-2, G-3, G-4: schemas and helpers --------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA kernel, organisation, identity, audit TO identity_bootstrap_owner;
GRANT EXECUTE ON FUNCTION kernel.setting(text), kernel.uuid1(text), kernel.uuids(text) TO identity_bootstrap_owner;
-- CREATE is needed only to move the ownership of the function (checked when ownership is assigned); revoked below in this file.
GRANT CREATE ON SCHEMA identity TO identity_bootstrap_owner;

-- The run record (C1, insert-only) --------------------------------------------------------------------------------------------
CREATE TABLE identity.bootstrap_run (
  id                   uuid        PRIMARY KEY,
  organisation_id      uuid        NOT NULL,
  run_ref              text        NOT NULL CHECK (char_length(run_ref) BETWEEN 1 AND 100),
  ticket_ref           text        NOT NULL CHECK (char_length(ticket_ref) BETWEEN 1 AND 100),
  mode                 text        NOT NULL CHECK (mode IN ('create', 'reissue')),
  principal_ids        uuid[]      NOT NULL CHECK (array_ndims(principal_ids) = 1 AND cardinality(principal_ids) = 2),
  custodian_person_ids uuid[]      NOT NULL CHECK (array_ndims(custodian_person_ids) = 1 AND cardinality(custodian_person_ids) = 2),
  custodian_idp_ids    text[]      NOT NULL CHECK (array_ndims(custodian_idp_ids) = 1 AND cardinality(custodian_idp_ids) = 2
                         AND coalesce(char_length(custodian_idp_ids[1]) BETWEEN 1 AND 200, false)
                         AND coalesce(char_length(custodian_idp_ids[2]) BETWEEN 1 AND 200, false)),
  token_expires_at     timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
-- The database itself holds "exactly one create run" (D-1.3 item 1).
CREATE UNIQUE INDEX bootstrap_run_one_create_uq ON identity.bootstrap_run (organisation_id) WHERE mode = 'create';
CREATE INDEX bootstrap_run_org_created_idx ON identity.bootstrap_run (organisation_id, created_at);
COMMENT ON TABLE identity.bootstrap_run IS 'class=C1; insert-only; written only by identity.bootstrap_admins (INT04-F02b)';

CREATE FUNCTION identity.refuse_bootstrap_run_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'bootstrap runs are insert-only (% refused)', TG_OP USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION identity.refuse_bootstrap_run_change() FROM PUBLIC;
CREATE TRIGGER bootstrap_run_append_only BEFORE UPDATE OR DELETE ON identity.bootstrap_run
  FOR EACH ROW EXECUTE FUNCTION identity.refuse_bootstrap_run_change();
CREATE TRIGGER bootstrap_run_no_truncate BEFORE TRUNCATE ON identity.bootstrap_run
  FOR EACH STATEMENT EXECUTE FUNCTION identity.refuse_bootstrap_run_change();

ALTER TABLE identity.bootstrap_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.bootstrap_run FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON identity.bootstrap_run FROM PUBLIC;
GRANT SELECT ON identity.bootstrap_run TO app_api, app_worker;
GRANT INSERT, SELECT ON identity.bootstrap_run TO identity_bootstrap_owner;
-- app_api: the admin realm's T-CONF read (evidence for the privileged-access review); app_worker: the run-level notice (system).
CREATE POLICY bootstrap_run_admin_read ON identity.bootstrap_run
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool');
CREATE POLICY bootstrap_run_system_select ON identity.bootstrap_run
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'org');
-- G-12
CREATE POLICY bootstrap_run_bootstrap_insert ON identity.bootstrap_run
  FOR INSERT TO identity_bootstrap_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY bootstrap_run_bootstrap_select ON identity.bootstrap_run
  FOR SELECT TO identity_bootstrap_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');

-- G-3 organisation.organisation: the "organisation exists" read of the caller binding -------------------------------------------
GRANT SELECT (organisation_id) ON organisation.organisation TO identity_bootstrap_owner;
CREATE POLICY organisation_bootstrap_select ON organisation.organisation
  FOR SELECT TO identity_bootstrap_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');

-- G-5 identity.person ----------------------------------------------------------------------------------------------------------
GRANT INSERT (id, organisation_id, display_name, status, created_by_job) ON identity.person TO identity_bootstrap_owner;
CREATE POLICY person_bootstrap_insert ON identity.person
  FOR INSERT TO identity_bootstrap_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND status = 'active');

-- G-6 identity.principal: the two admin principals and the custodian marker principals (D-2); the reads of the latch and of the triggers
GRANT INSERT (id, organisation_id, person_id, realm, subject, status, disabled_reason, created_by_job) ON identity.principal TO identity_bootstrap_owner;
GRANT SELECT (id, organisation_id, person_id, realm, subject, status) ON identity.principal TO identity_bootstrap_owner;
CREATE POLICY principal_bootstrap_insert ON identity.principal
  FOR INSERT TO identity_bootstrap_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((realm = 'admin_pool' AND subject IS NOT NULL AND status = 'active' AND disabled_reason IS NULL)
          OR (realm = 'google' AND status = 'disabled' AND disabled_reason = 'bootstrap_custodian'
              AND subject = 'bootstrap-custodian:' || person_id::text)));
CREATE POLICY principal_bootstrap_select ON identity.principal
  FOR SELECT TO identity_bootstrap_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');

-- G-7 identity.role ------------------------------------------------------------------------------------------------------------
GRANT SELECT (id, organisation_id, key, realm, privileged, location_bound) ON identity.role TO identity_bootstrap_owner;
CREATE POLICY role_bootstrap_select ON identity.role
  FOR SELECT TO identity_bootstrap_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');

-- G-8 identity.role_change_request ---------------------------------------------------------------------------------------------
GRANT INSERT (id, organisation_id, requester_person_id, subject_principal_id, change, before, request_hash, status, expires_at, created_by_job)
  ON identity.role_change_request TO identity_bootstrap_owner;
GRANT UPDATE (status, approver_person_id, decided_at) ON identity.role_change_request TO identity_bootstrap_owner;
GRANT SELECT (id, organisation_id, subject_principal_id, status) ON identity.role_change_request TO identity_bootstrap_owner;
CREATE POLICY role_change_request_bootstrap_insert ON identity.role_change_request
  FOR INSERT TO identity_bootstrap_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY role_change_request_bootstrap_update ON identity.role_change_request
  FOR UPDATE TO identity_bootstrap_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system') WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY role_change_request_bootstrap_select ON identity.role_change_request
  FOR SELECT TO identity_bootstrap_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');

-- G-9 identity.role_assignment -------------------------------------------------------------------------------------------------
GRANT INSERT (id, organisation_id, role_id, principal_id, granted_via_request_id, created_by_job) ON identity.role_assignment TO identity_bootstrap_owner;
GRANT SELECT (id, organisation_id, principal_id, role_id, granted_via_request_id, revoked_at) ON identity.role_assignment TO identity_bootstrap_owner;
CREATE POLICY role_assignment_bootstrap_insert ON identity.role_assignment
  FOR INSERT TO identity_bootstrap_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY role_assignment_bootstrap_select ON identity.role_assignment
  FOR SELECT TO identity_bootstrap_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');

-- G-10 identity.enrolment_token ------------------------------------------------------------------------------------------------
GRANT INSERT (id, organisation_id, principal_id, requested_by_person_id, expires_at, status, created_by_job) ON identity.enrolment_token TO identity_bootstrap_owner;
GRANT UPDATE (token_hash, approved_by_person_id, expires_at, status) ON identity.enrolment_token TO identity_bootstrap_owner;
GRANT SELECT (id, organisation_id, principal_id, status) ON identity.enrolment_token TO identity_bootstrap_owner;
CREATE POLICY enrolment_token_bootstrap_insert ON identity.enrolment_token
  FOR INSERT TO identity_bootstrap_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY enrolment_token_bootstrap_update ON identity.enrolment_token
  FOR UPDATE TO identity_bootstrap_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system') WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY enrolment_token_bootstrap_select ON identity.enrolment_token
  FOR SELECT TO identity_bootstrap_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');

-- G-11 identity.admin_credential: the reissue read ("never had a credential", revoked rows included) ---------------------------------
GRANT SELECT (organisation_id, principal_id) ON identity.admin_credential TO identity_bootstrap_owner;
CREATE POLICY admin_credential_bootstrap_select ON identity.admin_credential
  FOR SELECT TO identity_bootstrap_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system');

-- G-13 audit.event: a separate policy, so the shared event_insert gains no general `system` writer. The rows carry the run reference
-- in job_id (never request_id, which is null for worker rows, 0200) and only the resource types and actions the function writes.
GRANT INSERT ON audit.event TO identity_bootstrap_owner;
CREATE POLICY event_insert_bootstrap ON audit.event
  FOR INSERT TO identity_bootstrap_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'identity_bootstrap_owner'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND realm = 'worker' AND outcome = 'allowed' AND request_id IS NULL
     AND job_id LIKE 'bootstrap-admins:%'
     AND resource_type IN ('identity.principal', 'identity.role_change_request', 'identity.enrolment_token', 'identity.bootstrap_run')
     AND action IN ('create', 'update', 'role_change_request', 'role_change_decision'));

-- identity.bootstrap_admins (decision log 2.1, 3, D-1.3, D-2). SECURITY DEFINER, owner identity_bootstrap_owner, search_path pinned,
-- schema-qualified names only. Codes in the error DETAIL (never row data): caller, bad_input, reference_data, latch_closed,
-- reissue_expired, reissue_cap, target_state. SQLSTATE PS001 `bootstrap refused`; 42501 for a caller that is not app_bootstrap.
CREATE FUNCTION identity.bootstrap_admins(
  p_run_ref text, p_ticket_ref text, p_enrollees jsonb, p_custodians jsonb, p_token_hashes bytea[]
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  c_ttl constant interval := interval '30 minutes';      -- ARCHITECTURE 26.3; constants, not Settings (decision log 2.1)
  c_reissue_window constant interval := interval '7 days';
  c_reissue_cap constant integer := 2;
  v_org        uuid;
  v_prev_person text := pg_catalog.current_setting('app.person_id', true);
  v_prev_aud   text := pg_catalog.current_setting('app.audience', true);
  v_prev_scope text := pg_catalog.current_setting('app.job_scope', true);
  v_run        uuid := pg_catalog.gen_random_uuid();
  v_job        text;
  v_mode       text;
  v_exp        timestamptz := pg_catalog.now() + c_ttl;
  v_role       uuid;
  v_first      record;
  v_admins     integer;
  v_ids        uuid[];
  v_handle     text[] := ARRAY[NULL, NULL]::text[];
  v_name       text[] := ARRAY[NULL, NULL]::text[];
  v_epr        uuid[] := ARRAY[NULL, NULL]::uuid[];   -- enrollee principals, slot order
  v_eper       uuid[] := ARRAY[NULL, NULL]::uuid[];   -- enrollee persons
  v_cper       uuid[] := ARRAY[NULL, NULL]::uuid[];   -- custodian persons
  v_cprin      uuid[] := ARRAY[NULL, NULL]::uuid[];   -- custodian principal when that custodian is an enrollee, else NULL
  v_cmark      uuid[] := ARRAY[NULL, NULL]::uuid[];   -- custodian marker principal (non-enrollee custodians)
  v_cdn        text[] := ARRAY[NULL, NULL]::text[];
  v_cidp       text[] := ARRAY[NULL, NULL]::text[];
  v_cenr       integer[] := ARRAY[NULL, NULL]::integer[];
  v_issue      boolean[] := ARRAY[true, true]::boolean[];
  v_req        uuid[] := ARRAY[NULL, NULL]::uuid[];
  v_tok        uuid[] := ARRAY[NULL, NULL]::uuid[];
  v_audit      jsonb := '[]'::jsonb;
  v_events     jsonb := '[]'::jsonb;
  v_marker     jsonb;
  v_i          integer;
  v_j          integer;
  v_x          jsonb;
  v_t          record;
  v_hash       bytea;
  v_result     jsonb := '[]'::jsonb;
  v_subject    text;
  v_person     uuid;
  v_n          integer;
BEGIN
  -- Caller binding (6.2 rule 3) -------------------------------------------------------------------------------------------
  IF session_user <> 'app_bootstrap' THEN
    RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = '42501', DETAIL = 'caller';
  END IF;
  v_org := kernel.uuid1('app.org_id');
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'bad_input';
  END IF;
  PERFORM pg_catalog.set_config('app.audience', 'system', true);
  PERFORM pg_catalog.set_config('app.job_scope', 'org', true);
  IF NOT EXISTS (SELECT 1 FROM organisation.organisation o WHERE o.organisation_id = v_org) THEN
    RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'bad_input';
  END IF;

  -- Input validation -------------------------------------------------------------------------------------------------------
  IF p_run_ref IS NULL OR p_ticket_ref IS NULL
     OR pg_catalog.char_length(pg_catalog.btrim(p_run_ref)) NOT BETWEEN 1 AND 100
     OR pg_catalog.char_length(pg_catalog.btrim(p_ticket_ref)) NOT BETWEEN 1 AND 100
     OR p_enrollees IS NULL OR pg_catalog.jsonb_typeof(p_enrollees) <> 'array' OR pg_catalog.jsonb_array_length(p_enrollees) <> 2
     OR p_custodians IS NULL OR pg_catalog.jsonb_typeof(p_custodians) <> 'array' OR pg_catalog.jsonb_array_length(p_custodians) <> 2
     OR p_token_hashes IS NULL OR pg_catalog.array_ndims(p_token_hashes) IS DISTINCT FROM 1 OR pg_catalog.cardinality(p_token_hashes) <> 2
     OR p_token_hashes[1] IS NULL OR p_token_hashes[2] IS NULL
     OR pg_catalog.octet_length(p_token_hashes[1]) <> 32 OR pg_catalog.octet_length(p_token_hashes[2]) <> 32
     OR p_token_hashes[1] = p_token_hashes[2] THEN
    RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'bad_input';
  END IF;
  FOR v_i IN 1..2 LOOP
    v_x := p_enrollees -> (v_i - 1);
    IF pg_catalog.jsonb_typeof(v_x) <> 'object' OR pg_catalog.jsonb_typeof(v_x -> 'handle') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_x -> 'display_name') IS DISTINCT FROM 'string'
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_x)) <> 2 THEN
      RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'bad_input';
    END IF;
    v_handle[v_i] := v_x ->> 'handle';
    v_name[v_i] := pg_catalog.btrim(v_x ->> 'display_name');
    IF v_handle[v_i] !~ '^[a-z0-9][a-z0-9._-]{2,63}$' OR pg_catalog.char_length(v_name[v_i]) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'bad_input';
    END IF;
  END LOOP;
  IF v_handle[1] = v_handle[2] THEN
    RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'bad_input';
  END IF;
  FOR v_i IN 1..2 LOOP
    v_x := p_custodians -> (v_i - 1);
    IF pg_catalog.jsonb_typeof(v_x) <> 'object' OR pg_catalog.jsonb_typeof(v_x -> 'idp_id') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'bad_input';
    END IF;
    v_cidp[v_i] := v_x ->> 'idp_id';
    IF pg_catalog.char_length(v_cidp[v_i]) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'bad_input';
    END IF;
    IF v_x ? 'enrollee' THEN
      IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_x)) <> 2
         OR pg_catalog.jsonb_typeof(v_x -> 'enrollee') <> 'number' OR (v_x ->> 'enrollee') NOT IN ('1', '2') THEN
        RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'bad_input';
      END IF;
      v_cenr[v_i] := (v_x ->> 'enrollee')::integer;
    ELSE
      IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_x)) <> 2
         OR pg_catalog.jsonb_typeof(v_x -> 'display_name') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'bad_input';
      END IF;
      v_cdn[v_i] := pg_catalog.btrim(v_x ->> 'display_name');
      IF pg_catalog.char_length(v_cdn[v_i]) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'bad_input';
      END IF;
    END IF;
  END LOOP;
  -- Custodian i reads the token of enrollee i (D-2): never the enrollee itself; the two custodians differ.
  IF v_cidp[1] = v_cidp[2] OR v_cenr[1] = 1 OR v_cenr[2] = 2 OR v_cenr[1] = v_cenr[2] THEN
    RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'bad_input';
  END IF;
  SELECT r.id INTO v_role FROM identity.role r
   WHERE r.organisation_id = v_org AND r.key = 'org_admin' AND r.realm = 'admin_pool';
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'reference_data';
  END IF;

  -- Serialise runs of this organisation, then read the latch -------------------------------------------------------------------
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('identity.bootstrap_admins:' || v_org::text, 0));
  SELECT pg_catalog.count(*)::integer INTO v_admins FROM identity.principal p WHERE p.organisation_id = v_org AND p.realm = 'admin_pool';
  IF v_admins = 0 THEN
    IF EXISTS (SELECT 1 FROM identity.bootstrap_run b WHERE b.organisation_id = v_org AND b.mode = 'create') THEN
      RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'latch_closed';
    END IF;
    v_mode := 'create';
    v_epr := ARRAY[pg_catalog.gen_random_uuid(), pg_catalog.gen_random_uuid()];
    v_eper := ARRAY[pg_catalog.gen_random_uuid(), pg_catalog.gen_random_uuid()];
  ELSE
    v_mode := 'reissue';
    -- 1. Run history: exactly one create run; every reissue run records the same two principals; those are the only admin_pool principals.
    SELECT pg_catalog.count(*)::integer INTO v_n FROM identity.bootstrap_run b WHERE b.organisation_id = v_org AND b.mode = 'create';
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'latch_closed';
    END IF;
    SELECT b.principal_ids, b.created_at INTO v_first FROM identity.bootstrap_run b WHERE b.organisation_id = v_org AND b.mode = 'create';
    SELECT pg_catalog.array_agg(x ORDER BY x) INTO v_ids FROM pg_catalog.unnest(v_first.principal_ids) x;
    IF EXISTS (SELECT 1 FROM identity.bootstrap_run b
                WHERE b.organisation_id = v_org AND b.mode = 'reissue'
                  AND (SELECT pg_catalog.array_agg(x ORDER BY x) FROM pg_catalog.unnest(b.principal_ids) x) IS DISTINCT FROM v_ids)
       OR (SELECT pg_catalog.array_agg(p.id ORDER BY p.id) FROM identity.principal p
            WHERE p.organisation_id = v_org AND p.realm = 'admin_pool') IS DISTINCT FROM v_ids THEN
      RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'latch_closed';
    END IF;
    v_epr := v_first.principal_ids;
    FOR v_i IN 1..2 LOOP
      SELECT p.subject, p.person_id INTO v_subject, v_person FROM identity.principal p WHERE p.id = v_epr[v_i];
      v_eper[v_i] := v_person;
      IF v_subject IS DISTINCT FROM v_handle[v_i] THEN
        RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'latch_closed';
      END IF;
    END LOOP;
    -- 2 and 3. Age bound and count cap (constants).
    IF pg_catalog.now() >= v_first.created_at + c_reissue_window THEN
      RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'reissue_expired';
    END IF;
    IF (SELECT pg_catalog.count(*) FROM identity.bootstrap_run b WHERE b.organisation_id = v_org AND b.mode = 'reissue') >= c_reissue_cap THEN
      RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'reissue_cap';
    END IF;
    -- 4. The targets never had a credential (revoked rows count); there is at least one.
    FOR v_i IN 1..2 LOOP
      v_issue[v_i] := NOT EXISTS (SELECT 1 FROM identity.admin_credential c WHERE c.organisation_id = v_org AND c.principal_id = v_epr[v_i]);
    END LOOP;
    IF NOT (v_issue[1] OR v_issue[2]) THEN
      RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'latch_closed';
    END IF;
    -- 5. Each target is active and still holds the org_admin assignment of the first run. The assignment is checked through its
    -- applied request for this principal: the grants of G-8 and G-9 do not include created_by_job, so "the first run's request"
    -- is decided by the request being applied for the target and being the one the live assignment was granted by.
    FOR v_i IN 1..2 LOOP
      IF v_issue[v_i] THEN
        IF NOT EXISTS (SELECT 1 FROM identity.principal p WHERE p.id = v_epr[v_i] AND p.status = 'active')
           OR NOT EXISTS (SELECT 1 FROM identity.role_assignment a
                           JOIN identity.role_change_request q ON q.id = a.granted_via_request_id
                          WHERE a.organisation_id = v_org AND a.principal_id = v_epr[v_i] AND a.role_id = v_role AND a.revoked_at IS NULL
                            AND q.subject_principal_id = v_epr[v_i] AND q.status = 'applied') THEN
          RAISE EXCEPTION 'bootstrap refused' USING ERRCODE = 'PS001', DETAIL = 'target_state';
        END IF;
      END IF;
    END LOOP;
  END IF;

  v_job := 'bootstrap-admins:' || p_run_ref;
  v_marker := pg_catalog.jsonb_build_object('via', 'bootstrap_admins', 'bootstrapRunId', v_run, 'mode', v_mode);

  -- Custodian persons: an enrollee custodian reuses the enrollee's person; any other gets a new person and a marker principal.
  FOR v_i IN 1..2 LOOP
    IF v_cenr[v_i] IS NOT NULL THEN
      v_cper[v_i] := v_eper[v_cenr[v_i]];
      v_cprin[v_i] := v_epr[v_cenr[v_i]];
    ELSE
      v_cper[v_i] := pg_catalog.gen_random_uuid();
      v_cmark[v_i] := pg_catalog.gen_random_uuid();
    END IF;
  END LOOP;

  -- Step 0: the run row first -------------------------------------------------------------------------------------------------
  INSERT INTO identity.bootstrap_run (id, organisation_id, run_ref, ticket_ref, mode, principal_ids, custodian_person_ids, custodian_idp_ids, token_expires_at)
  VALUES (v_run, v_org, p_run_ref, p_ticket_ref, v_mode, v_epr, v_cper, v_cidp, v_exp);
  v_audit := v_audit || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'action', 'create', 'type', 'identity.bootstrap_run', 'rid', v_run, 'person', NULL, 'principal', NULL,
    'change', pg_catalog.jsonb_build_object('mode', v_mode, 'principalIds', v_epr)));

  -- Step 1: persons and principals ---------------------------------------------------------------------------------------------
  IF v_mode = 'create' THEN
    FOR v_i IN 1..2 LOOP
      INSERT INTO identity.person (id, organisation_id, display_name, status, created_by_job) VALUES (v_eper[v_i], v_org, v_name[v_i], 'active', v_run);
      INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, status, created_by_job)
      VALUES (v_epr[v_i], v_org, v_eper[v_i], 'admin_pool', v_handle[v_i], 'active', v_run);
      v_audit := v_audit || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'action', 'create', 'type', 'identity.principal', 'rid', v_epr[v_i], 'person', NULL, 'principal', NULL,
        'change', pg_catalog.jsonb_build_object('realm', 'admin_pool')));
    END LOOP;
  END IF;
  FOR v_i IN 1..2 LOOP
    IF v_cmark[v_i] IS NOT NULL THEN
      INSERT INTO identity.person (id, organisation_id, display_name, status, created_by_job) VALUES (v_cper[v_i], v_org, v_cdn[v_i], 'active', v_run);
      INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, status, disabled_reason, created_by_job)
      VALUES (v_cmark[v_i], v_org, v_cper[v_i], 'google', 'bootstrap-custodian:' || v_cper[v_i]::text, 'disabled', 'bootstrap_custodian', v_run);
      v_audit := v_audit || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'action', 'create', 'type', 'identity.principal', 'rid', v_cmark[v_i], 'person', NULL, 'principal', NULL,
        'change', pg_catalog.jsonb_build_object('realm', 'google', 'status', 'disabled', 'reason', 'bootstrap_custodian')));
    END IF;
  END LOOP;
  -- Deferred person check (revision 5, F02B-SA-08 (b)): fire person_requires_principal here, as this owner, while audience `system`
  -- is set, then put it back to its declared mode so nothing of it runs at COMMIT as app_bootstrap. A person without a principal
  -- refuses the call at this point (PS001, rolled back).
  EXECUTE 'SET CONSTRAINTS identity.person_requires_principal IMMEDIATE';
  EXECUTE 'SET CONSTRAINTS identity.person_requires_principal DEFERRED';

  -- Step 2 and 3: requests, assignments, tokens, with the audit rows the API writes for the same changes --------------------------
  FOR v_i IN 1..2 LOOP
    CONTINUE WHEN NOT v_issue[v_i];
    v_j := 3 - v_i;
    IF v_mode = 'reissue' THEN
      FOR v_t IN SELECT t.id FROM identity.enrolment_token t
                  WHERE t.organisation_id = v_org AND t.principal_id = v_epr[v_i] AND t.status IN ('requested', 'approved') ORDER BY t.id LOOP
        UPDATE identity.enrolment_token SET status = 'expired' WHERE id = v_t.id;
        v_audit := v_audit || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'action', 'update', 'type', 'identity.enrolment_token', 'rid', v_t.id, 'person', NULL, 'principal', NULL,
          'change', pg_catalog.jsonb_build_object('status', 'expired', 'reason', 'bootstrap_reissue')));
      END LOOP;
    END IF;
    v_tok[v_i] := pg_catalog.gen_random_uuid();
    -- requester: custodian j
    PERFORM pg_catalog.set_config('app.person_id', v_cper[v_j]::text, true);
    IF v_mode = 'create' THEN
      v_req[v_i] := pg_catalog.gen_random_uuid();
      v_hash := pg_catalog.sha256(pg_catalog.convert_to(
        '{"subject":"' || v_epr[v_i]::text || '","add":[["org_admin",null]],"remove":[],"before":[]}', 'UTF8'));
      INSERT INTO identity.role_change_request (id, organisation_id, requester_person_id, subject_principal_id, change, before, request_hash, status, expires_at, created_by_job)
      VALUES (v_req[v_i], v_org, v_cper[v_j], v_epr[v_i], '{"add":[{"roleKey":"org_admin"}],"remove":[]}'::jsonb, '[]'::jsonb, v_hash, 'requested', v_exp, v_run);
      v_audit := v_audit || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'action', 'role_change_request', 'type', 'identity.role_change_request', 'rid', v_req[v_i], 'person', v_cper[v_j], 'principal', v_cprin[v_j],
        'change', pg_catalog.jsonb_build_object('subjectPrincipalId', v_epr[v_i], 'add', '[{"roleKey":"org_admin"}]'::jsonb, 'remove', '[]'::jsonb, 'before', '[]'::jsonb)));
    END IF;
    INSERT INTO identity.enrolment_token (id, organisation_id, principal_id, requested_by_person_id, expires_at, status, created_by_job)
    VALUES (v_tok[v_i], v_org, v_epr[v_i], v_cper[v_j], v_exp, 'requested', v_run);
    v_audit := v_audit || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'action', 'create', 'type', 'identity.enrolment_token', 'rid', v_tok[v_i], 'person', v_cper[v_j], 'principal', v_cprin[v_j],
      'change', pg_catalog.jsonb_build_object('principalId', v_epr[v_i])));
    -- approver: custodian i
    PERFORM pg_catalog.set_config('app.person_id', v_cper[v_i]::text, true);
    IF v_mode = 'create' THEN
      UPDATE identity.role_change_request SET status = 'approved', approver_person_id = v_cper[v_i], decided_at = pg_catalog.now() WHERE id = v_req[v_i];
      INSERT INTO identity.role_assignment (id, organisation_id, role_id, principal_id, granted_via_request_id, created_by_job)
      VALUES (pg_catalog.gen_random_uuid(), v_org, v_role, v_epr[v_i], v_req[v_i], v_run);
      UPDATE identity.role_change_request SET status = 'applied' WHERE id = v_req[v_i];
      v_audit := v_audit || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'action', 'role_change_decision', 'type', 'identity.role_change_request', 'rid', v_req[v_i], 'person', v_cper[v_i], 'principal', v_cprin[v_i],
        'change', pg_catalog.jsonb_build_object('decision', 'applied', 'subjectPrincipalId', v_epr[v_i], 'requesterPersonId', v_cper[v_j],
                                                'approverPersonId', v_cper[v_i], 'before', '[]'::jsonb, 'after', '[{"roleKey":"org_admin"}]'::jsonb)));
    END IF;
    UPDATE identity.enrolment_token SET token_hash = p_token_hashes[v_i], approved_by_person_id = v_cper[v_i], expires_at = v_exp, status = 'approved'
     WHERE id = v_tok[v_i];
    v_audit := v_audit || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'action', 'update', 'type', 'identity.enrolment_token', 'rid', v_tok[v_i], 'person', v_cper[v_i], 'principal', v_cprin[v_i],
      'change', pg_catalog.jsonb_build_object('status', 'approved')));
    v_events := v_events
      || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind', 'enrolment_token_requested', 'principalId', v_epr[v_i], 'key', 'enrolment_token_requested:' || v_tok[v_i]::text))
      || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind', 'enrolment_token_approved', 'principalId', v_epr[v_i], 'key', 'enrolment_token_approved:' || v_tok[v_i]::text));
    IF v_mode = 'create' THEN
      v_events := v_events
        || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind', 'role_change_decided', 'principalId', v_epr[v_i], 'key', 'role_change_decided:' || v_req[v_i]::text));
    END IF;
  END LOOP;

  -- Audit rows: one insert, every row under the job reference with the pipeline marker (F02B-SEC-05) --------------------------------
  INSERT INTO audit.event (event_id, organisation_id, job_id, actor_principal_id, actor_person_id, realm, audience, action, resource_type,
                           resource_id, reason, change, outcome)
  SELECT pg_catalog.gen_random_uuid(), v_org, v_job, NULLIF(a ->> 'principal', '')::uuid, NULLIF(a ->> 'person', '')::uuid,
         'worker', 'system', a ->> 'action', a ->> 'type', (a ->> 'rid')::uuid, p_ticket_ref, (a -> 'change') || v_marker, 'allowed'
    FROM pg_catalog.jsonb_array_elements(v_audit) AS a;

  -- Step 4: the admin events, the run-level one last ------------------------------------------------------------------------------
  FOR v_x IN SELECT e FROM pg_catalog.jsonb_array_elements(v_events) AS e LOOP
    PERFORM queue_api.enqueue('identity.admin_event',
      pg_catalog.jsonb_build_object('kind', v_x ->> 'kind', 'principalId', v_x ->> 'principalId'),
      NULL, v_x ->> 'key', 0::smallint);
  END LOOP;
  PERFORM queue_api.enqueue('identity.admin_event',
    pg_catalog.jsonb_build_object('kind', 'bootstrap_run', 'runId', v_run), NULL, 'bootstrap_run:' || v_run::text, 0::smallint);

  -- Step 5: restore the three settings (F02B-SEC-06 a) and return one entry per slot ----------------------------------------------
  PERFORM pg_catalog.set_config('app.person_id', COALESCE(v_prev_person, ''), true);
  PERFORM pg_catalog.set_config('app.audience', COALESCE(v_prev_aud, ''), true);
  PERFORM pg_catalog.set_config('app.job_scope', COALESCE(v_prev_scope, ''), true);
  FOR v_i IN 1..2 LOOP
    v_result := v_result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'slot', v_i, 'principal_id', v_epr[v_i],
      'result', CASE WHEN v_issue[v_i] THEN 'issued' ELSE 'skipped' END,
      'token_id', CASE WHEN v_issue[v_i] THEN pg_catalog.to_jsonb(v_tok[v_i]) ELSE 'null'::jsonb END));
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('mode', v_mode, 'run_id', v_run, 'expires_at', v_exp, 'enrollees', v_result);
END
$$;


REVOKE ALL ON FUNCTION identity.bootstrap_admins(text, text, jsonb, jsonb, bytea[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.bootstrap_admins(text, text, jsonb, jsonb, bytea[]) TO app_bootstrap;
GRANT USAGE ON SCHEMA identity TO app_bootstrap;
ALTER FUNCTION identity.bootstrap_admins(text, text, jsonb, jsonb, bytea[]) OWNER TO identity_bootstrap_owner;
-- The CREATE right on the schema was needed only to move the ownership above (22.5.1 (d)).
REVOKE CREATE ON SCHEMA identity FROM identity_bootstrap_owner;
