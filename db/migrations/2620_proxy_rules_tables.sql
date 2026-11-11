-- migration-class: expand
-- HEAAA-791 (owner ruling 2026-11-11 C item 3, D-7 / C-04): proxy rules. The default stays "appointments only"; the patient grants more
-- (messages, documents) per scope. A patient invites a proxy by e-mail, staff link a guardian after checking the relationship document,
-- both are accepted by the proxy with an account and an e-mail code. Guardian access ends on the minor's 18th birthday; ages 13-17 keep
-- appointments only. Every value (18, 13, 30 days, invite lifetime, code attempts) is a kernel.setting row, seeded from the catalogue.
--
-- Expand only. No existing CHECK is dropped or rewritten (DEVOPS-PLAN 8.1 rule 1), so the states are mapped onto the existing ones:
--   pending invitation  = status 'requested' (patient invite) or 'verified' (staff link, the document is checked), proxy_principal_id NULL
--   accepted            = 'active'
--   left / revoked      = 'revoked' (revoke_reason 'patient' | 'staff'); ended_by names who precisely (patient, proxy, staff)
--   aged out            = 'expired' (revoke_reason 'age_out'); an invitation nobody accepted in time is 'expired' with ended_by 'invite_expired'
-- The legacy `scope` column stays 'appointments' (N-1 code reads it); `scopes` is the granted list.

ALTER TABLE identity.proxy_grant ALTER COLUMN proxy_principal_id DROP NOT NULL;

ALTER TABLE identity.proxy_grant
  ADD COLUMN scopes             text[]      NOT NULL DEFAULT ARRAY['appointments']::text[],
  ADD COLUMN guardian           boolean     NOT NULL DEFAULT false,
  ADD COLUMN source             text        NOT NULL DEFAULT 'proxy_request',
  ADD COLUMN invited_email      text,
  ADD COLUMN patient_birth_date date,
  ADD COLUMN adolescent_from    date,
  ADD COLUMN age_out_notice_at  timestamptz,
  ADD COLUMN accepted_at        timestamptz,
  ADD COLUMN ended_by           text,
  ADD CONSTRAINT proxy_grant_scopes_ck CHECK (
        scopes <@ ARRAY['appointments', 'messages', 'documents']::text[] AND 'appointments' = ANY (scopes)) NOT VALID,
  ADD CONSTRAINT proxy_grant_source_ck CHECK (source IN ('proxy_request', 'patient_invite', 'staff_link')) NOT VALID,
  ADD CONSTRAINT proxy_grant_ended_by_ck CHECK (ended_by IS NULL OR ended_by IN ('patient', 'proxy', 'staff', 'age_out', 'invite_expired', 'merge')) NOT VALID,
  ADD CONSTRAINT proxy_grant_invite_email_ck CHECK (invited_email IS NULL OR (char_length(invited_email) BETWEEN 3 AND 320 AND invited_email = lower(invited_email))) NOT VALID,
  -- A grant without a proxy is an invitation: it names the address, and only the two invitation sources create one.
  ADD CONSTRAINT proxy_grant_pending_invite_ck CHECK (
        proxy_principal_id IS NOT NULL
     OR (invited_email IS NOT NULL AND source IN ('patient_invite', 'staff_link') AND status IN ('requested', 'verified', 'revoked', 'expired'))) NOT VALID,
  -- Guardian grants (staff link) carry the dates the age rules need, copied from the patient's date of birth at link time.
  ADD CONSTRAINT proxy_grant_guardian_dates_ck CHECK (NOT guardian OR (patient_birth_date IS NOT NULL AND source = 'staff_link')) NOT VALID;

COMMENT ON COLUMN identity.proxy_grant.scopes IS 'granted scopes (appointments always; messages, documents by the patient). The effective list is identity.proxy_effective_scopes';
COMMENT ON COLUMN identity.proxy_grant.valid_until IS 'last day of access. Guardian grants: the day before the patient reaches the age of majority (setting proxy_age_of_majority)';
COMMENT ON COLUMN identity.proxy_grant.patient_birth_date IS 'guardian grants only; copied from patient.patient at link time (class C2, like patient_display_name) so the proxy side never reads the patient row';
COMMENT ON COLUMN identity.proxy_grant.invited_email IS 'lower-case address an invitation was sent to; compared with the accepting principal''s own address';

-- The code of an invitation (e-mail code). The hash is kept apart from proxy_grant so a patient or staff member who can read the grant
-- never reads code material. Written by the worker job that sends the mail (the code exists in clear only in that job and the mail).
CREATE TABLE identity.proxy_invite_code (
  grant_id        uuid        PRIMARY KEY REFERENCES identity.proxy_grant (id),
  organisation_id uuid        NOT NULL,
  salt            bytea       NOT NULL CHECK (octet_length(salt) = 16),
  code_hash       bytea       NOT NULL CHECK (octet_length(code_hash) = 32),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at      timestamptz NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz
);
COMMENT ON TABLE identity.proxy_invite_code IS 'class=C2; hashed e-mail code of one proxy invitation; no patient_id (reached through proxy_grant)';
CREATE TRIGGER proxy_invite_code_bump_row_version BEFORE UPDATE ON identity.proxy_invite_code FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- The state machine of ST-06 with the invitation path: the proxy activates their own invitation (requested|verified -> active, principal
-- set once), an unaccepted invitation expires, and only the patient changes the scopes of a non-guardian grant.
CREATE OR REPLACE FUNCTION identity.guard_proxy_grant() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_invite boolean := OLD.proxy_principal_id IS NULL;
BEGIN
  IF OLD.status IN ('revoked', 'expired') THEN
    RAISE EXCEPTION 'a revoked or expired proxy grant accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.relationship IS DISTINCT FROM OLD.relationship OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.guardian IS DISTINCT FROM OLD.guardian OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.invited_email IS DISTINCT FROM OLD.invited_email THEN
    RAISE EXCEPTION 'a proxy grant keeps its relationship, source and scope' USING ERRCODE = 'PS001';
  END IF;
  -- The proxy is fixed at creation, except that an invitation takes its proxy once, at acceptance.
  IF NEW.proxy_principal_id IS DISTINCT FROM OLD.proxy_principal_id
     AND NOT (v_invite AND NEW.proxy_principal_id IS NOT NULL AND NEW.status = 'active') THEN
    RAISE EXCEPTION 'a proxy grant keeps its proxy' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('verified', 'revoked'))
    OR (OLD.status = 'verified'  AND NEW.status IN ('active', 'revoked'))
    OR (OLD.status = 'active'    AND NEW.status IN ('revoked', 'expired'))
    -- invitation path: accepted by the proxy, or timed out / voided before acceptance
    OR (v_invite AND OLD.status IN ('requested', 'verified') AND NEW.status IN ('active', 'revoked', 'expired'))) THEN
    RAISE EXCEPTION 'illegal proxy grant transition' USING ERRCODE = 'PS001';
  END IF;
  -- Through a portal only the proxy themselves turns a grant on: no patient or staff request activates one for them.
  IF NEW.status = 'active' AND OLD.status <> 'active' AND kernel.setting('app.audience') IN ('patient', 'staff')
     AND NEW.proxy_principal_id IS DISTINCT FROM kernel.uuid1('app.principal_id') THEN
    RAISE EXCEPTION 'a proxy grant is activated by its proxy' USING ERRCODE = 'PS001';
  END IF;
  -- A patient or staff request can only end a grant (or, for the proxy's own acceptance, turn it on); it never walks the middle states.
  IF NEW.status IS DISTINCT FROM OLD.status AND coalesce(kernel.setting('app.audience'), '') IN ('patient', 'staff')
     AND NEW.status NOT IN ('revoked', 'active') THEN
    RAISE EXCEPTION 'a portal request can only revoke a proxy grant or accept an invitation' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.scopes IS DISTINCT FROM OLD.scopes AND (OLD.guardian OR coalesce(kernel.setting('app.audience'), '') <> 'patient') THEN
    RAISE EXCEPTION 'only the patient changes the scopes of a proxy grant' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;

-- The effective scopes of a grant today: nothing after valid_until; appointments only for a guardian between the adolescent age and
-- the age of majority (RA-R1-20b: ages 13-17 keep appointments only even when a broader scope was granted).
CREATE FUNCTION identity.proxy_effective_scopes(p_scopes text[], p_guardian boolean, p_adolescent_from date, p_valid_until date)
  RETURNS text[]
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
  AS $$
  SELECT CASE
           WHEN p_valid_until IS NOT NULL AND p_valid_until < current_date THEN ARRAY[]::text[]
           WHEN p_guardian AND p_adolescent_from IS NOT NULL AND current_date >= p_adolescent_from THEN ARRAY['appointments']::text[]
           ELSE p_scopes
         END
$$;

-- Does the calling proxy hold `p_scope` for `p_patient` right now? SECURITY INVOKER: it reads the caller's own active grants through
-- the proxy_grant_proxy_read policy, so revocation and age-out are effective in the next statement (no copy, no cache).
CREATE FUNCTION identity.proxy_allows(p_patient uuid, p_scope text) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
  AS $$
  SELECT EXISTS (
    SELECT 1 FROM identity.proxy_grant g
     WHERE g.patient_id = p_patient AND g.proxy_principal_id = kernel.uuid1('app.principal_id') AND g.status = 'active'
       AND p_scope = ANY (identity.proxy_effective_scopes(g.scopes, g.guardian, g.adolescent_from, g.valid_until)))
$$;
REVOKE ALL ON FUNCTION identity.proxy_effective_scopes(text[], boolean, date, date), identity.proxy_allows(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.proxy_effective_scopes(text[], boolean, date, date), identity.proxy_allows(uuid, text) TO app_api, app_worker;
