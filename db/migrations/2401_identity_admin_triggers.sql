-- migration-class: expand
-- Triggers of the admin-realm tables (ARCHITECTURE 21.5, 22.4; ticket BE-05). Invoker rights, search_path pinned to
-- pg_catalog, schema-qualified names only. They are the database half of C1/C4: a compromised handler still cannot approve
-- its own request, decide as someone else, reuse a challenge, lower a signature counter or reopen a revoked credential.
-- Custom SQLSTATE PS001 = illegal state transition (21.5).

CREATE TRIGGER role_change_request_bump_row_version BEFORE UPDATE ON identity.role_change_request FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER enrolment_token_bump_row_version BEFORE UPDATE ON identity.enrolment_token FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER admin_credential_bump_row_version BEFORE UPDATE ON identity.admin_credential FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER webauthn_challenge_bump_row_version BEFORE UPDATE ON identity.webauthn_challenge FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER elevation_grant_bump_row_version BEFORE UPDATE ON identity.elevation_grant FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- role_change_request (C4): requested -> approved | rejected | expired | cancelled, approved -> applied. What was asked never
-- changes. A decision is recorded by the person the session belongs to (app.person_id), who is neither the requester (CK)
-- nor the person being changed (this trigger).
CREATE FUNCTION identity.guard_role_change_request() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  subject_person uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' OR NEW.approver_person_id IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a role change request starts as requested' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.requester_person_id IS DISTINCT FROM kernel.uuid1('app.person_id') THEN
      RAISE EXCEPTION 'a request is made by the person of the session' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.requester_person_id IS DISTINCT FROM OLD.requester_person_id
     OR NEW.subject_principal_id IS DISTINCT FROM OLD.subject_principal_id
     OR NEW.change IS DISTINCT FROM OLD.change OR NEW.before IS DISTINCT FROM OLD.before
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a role change request keeps what was asked' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'expired', 'cancelled'))
    OR (OLD.status = 'approved'  AND NEW.status = 'applied')) THEN
    RAISE EXCEPTION 'illegal role change request transition' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status IN ('applied', 'rejected', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'a decided role change request accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected') THEN
    IF NEW.approver_person_id IS DISTINCT FROM kernel.uuid1('app.person_id') THEN
      RAISE EXCEPTION 'a request is decided by the person of the session' USING ERRCODE = 'PS001';
    END IF;
    SELECT p.person_id INTO subject_person FROM identity.principal p WHERE p.id = NEW.subject_principal_id;
    IF subject_person IS NULL OR subject_person = NEW.approver_person_id THEN
      RAISE EXCEPTION 'the approver is not the person being changed' USING ERRCODE = 'PS001';
    END IF;
  ELSIF NEW.approver_person_id IS DISTINCT FROM OLD.approver_person_id OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
    IF NOT (OLD.status = 'requested' AND NEW.status IN ('expired', 'cancelled')) THEN
      RAISE EXCEPTION 'the decision of a request does not change' USING ERRCODE = 'PS001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION identity.guard_role_change_request() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.guard_role_change_request() TO app_api, app_worker;
CREATE TRIGGER role_change_request_guard BEFORE INSERT OR UPDATE ON identity.role_change_request
  FOR EACH ROW EXECUTE FUNCTION identity.guard_role_change_request();

-- enrolment_token (P-4): only an admin_pool principal can be enrolled; the token hash is set once, at approval, by someone
-- other than the requester; a used, expired or cancelled token never reopens.
CREATE FUNCTION identity.guard_enrolment_token() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' OR NEW.token_hash IS NOT NULL OR NEW.approved_by_person_id IS NOT NULL THEN
      RAISE EXCEPTION 'an enrolment token starts as requested, without a token' USING ERRCODE = 'PS001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM identity.principal p WHERE p.id = NEW.principal_id AND p.realm = 'admin_pool') THEN
      RAISE EXCEPTION 'only an admin-realm principal is enrolled' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.requested_by_person_id IS DISTINCT FROM OLD.requested_by_person_id THEN
    RAISE EXCEPTION 'an enrolment token keeps its principal and requester' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status IN ('used', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'a used, expired or cancelled enrolment token accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('approved', 'expired', 'cancelled'))
    OR (OLD.status = 'approved'  AND NEW.status IN ('used', 'expired', 'cancelled'))) THEN
    RAISE EXCEPTION 'illegal enrolment token transition' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.token_hash IS NOT NULL AND NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    RAISE EXCEPTION 'the token of an enrolment never changes' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status = 'requested' AND NEW.status = 'approved' THEN
    IF NEW.approved_by_person_id IS DISTINCT FROM kernel.uuid1('app.person_id') THEN
      RAISE EXCEPTION 'an enrolment is approved by the person of the session' USING ERRCODE = 'PS001';
    END IF;
  ELSIF NEW.approved_by_person_id IS DISTINCT FROM OLD.approved_by_person_id THEN
    RAISE EXCEPTION 'the approver of an enrolment does not change' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION identity.guard_enrolment_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.guard_enrolment_token() TO app_api, app_worker;
CREATE TRIGGER enrolment_token_guard BEFORE INSERT OR UPDATE ON identity.enrolment_token
  FOR EACH ROW EXECUTE FUNCTION identity.guard_enrolment_token();

-- admin_credential (B2-3, B2-4): insert-only except sign_count (never lower), last_used_at and revoked_*; a revoked
-- credential accepts no change; only an admin_pool principal holds one.
CREATE FUNCTION identity.guard_admin_credential() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM identity.principal p WHERE p.id = NEW.principal_id AND p.realm = 'admin_pool') THEN
      RAISE EXCEPTION 'only an admin-realm principal holds a credential' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.revoked_at IS NOT NULL OR NEW.sign_count <> 0 THEN
      RAISE EXCEPTION 'a credential starts live with a zero counter' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked credential accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.public_key IS DISTINCT FROM OLD.public_key
     OR NEW.aaguid IS DISTINCT FROM OLD.aaguid OR NEW.transports IS DISTINCT FROM OLD.transports
     OR NEW.backup_eligible IS DISTINCT FROM OLD.backup_eligible
     OR NEW.user_verified_at_enrol IS DISTINCT FROM OLD.user_verified_at_enrol
     OR NEW.enrolment_token_id IS DISTINCT FROM OLD.enrolment_token_id THEN
    RAISE EXCEPTION 'a credential is insert-only apart from its counter, last use and revocation' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.sign_count < OLD.sign_count THEN
    RAISE EXCEPTION 'the signature counter never goes down' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION identity.guard_admin_credential() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.guard_admin_credential() TO app_api, app_worker;
CREATE TRIGGER admin_credential_guard BEFORE INSERT OR UPDATE ON identity.admin_credential
  FOR EACH ROW EXECUTE FUNCTION identity.guard_admin_credential();

-- webauthn_challenge (B2-5): used_at is written once and nothing else changes after insert.
CREATE FUNCTION identity.guard_webauthn_challenge() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'a used challenge accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.challenge IS DISTINCT FROM OLD.challenge
     OR NEW.bound_hash IS DISTINCT FROM OLD.bound_hash OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a challenge keeps its purpose, principal, session, value and expiry' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION identity.guard_webauthn_challenge() FROM PUBLIC;
CREATE TRIGGER webauthn_challenge_guard BEFORE UPDATE ON identity.webauthn_challenge
  FOR EACH ROW EXECUTE FUNCTION identity.guard_webauthn_challenge();

-- elevation_grant (C1): revocation is monotonic and the only change; a grant is for an admin_pool session.
CREATE FUNCTION identity.guard_elevation_grant() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM identity.session s
                    WHERE s.id = NEW.session_id AND s.realm = 'admin_pool' AND s.person_id = NEW.person_id
                      AND s.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'a grant is for a live admin-realm session of the same person' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked grant accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.assertion_at IS DISTINCT FROM OLD.assertion_at OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.credential_id IS DISTINCT FROM OLD.credential_id THEN
    RAISE EXCEPTION 'a grant is only ever revoked' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION identity.guard_elevation_grant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.guard_elevation_grant() TO app_api, app_worker;
CREATE TRIGGER elevation_grant_guard BEFORE INSERT OR UPDATE ON identity.elevation_grant
  FOR EACH ROW EXECUTE FUNCTION identity.guard_elevation_grant();
