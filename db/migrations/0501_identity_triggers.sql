-- migration-class: expand
-- Triggers of the identity tables (ARCHITECTURE 21.5, 22.4; ticket BE-04). All are invoker-rights, search_path pinned to
-- pg_catalog, schema-qualified names only. They are the database half of rules the API also checks: a bug or a
-- compromised handler still cannot rebind a subject, extend a revoked session, or put a privileged role in the wrong realm.
-- Custom SQLSTATE PS001 = illegal state transition (21.5).

-- row_version / updated_at (21.5) on every mutable identity table.
CREATE TRIGGER person_bump_row_version BEFORE UPDATE ON identity.person FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER principal_bump_row_version BEFORE UPDATE ON identity.principal FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER session_bump_row_version BEFORE UPDATE ON identity.session FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER role_bump_row_version BEFORE UPDATE ON identity.role FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER permission_bump_row_version BEFORE UPDATE ON identity.permission FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER role_assignment_bump_row_version BEFORE UPDATE ON identity.role_assignment FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER staff_profile_bump_row_version BEFORE UPDATE ON identity.staff_profile FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER licensed_state_bump_row_version BEFORE UPDATE ON identity.licensed_state FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER proxy_grant_bump_row_version BEFORE UPDATE ON identity.proxy_grant FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER push_subscription_bump_row_version BEFORE UPDATE ON identity.push_subscription FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER staff_support_bump_row_version BEFORE UPDATE ON identity.staff_support FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- 22.4 person: a person must have at least one principal at commit (T-SIGNIN creates both in one transaction).
CREATE FUNCTION identity.require_principal() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity.principal p WHERE p.person_id = NEW.id) THEN
    RAISE EXCEPTION 'a person must have at least one principal' USING ERRCODE = 'PS001';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION identity.require_principal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.require_principal() TO app_api, app_worker;
CREATE CONSTRAINT TRIGGER person_requires_principal AFTER INSERT ON identity.person
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_principal();

-- 22.4 / 26.1 principal: the IdP subject goes from null to a value once (the pre-registered email binding) and never
-- changes again, so a reassigned Workspace address cannot take the principal over. Person, realm and organisation never
-- change; the email changes only while the principal is still unbound.
CREATE FUNCTION identity.guard_principal() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.realm IS DISTINCT FROM OLD.realm OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id THEN
    RAISE EXCEPTION 'a principal keeps its identity, person, realm and organisation' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.subject IS NOT NULL AND NEW.subject IS DISTINCT FROM OLD.subject THEN
    RAISE EXCEPTION 'a bound principal subject never changes' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.subject IS NOT NULL AND NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'the email of a bound principal never changes' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION identity.guard_principal() FROM PUBLIC;
CREATE TRIGGER principal_guard BEFORE UPDATE ON identity.principal FOR EACH ROW EXECUTE FUNCTION identity.guard_principal();

-- 22.4 session (SEC01-F-09): revocation is monotonic; a revoked row accepts no other change; the columns that fix the
-- session's identity never change after insert.
CREATE FUNCTION identity.guard_session() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked session accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.realm IS DISTINCT FROM OLD.realm OR NEW.audience IS DISTINCT FROM OLD.audience
     OR NEW.auth_time IS DISTINCT FROM OLD.auth_time OR NEW.amr IS DISTINCT FROM OLD.amr
     OR NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at
     OR NEW.ip IS DISTINCT FROM OLD.ip OR NEW.user_agent IS DISTINCT FROM OLD.user_agent THEN
    RAISE EXCEPTION 'a session keeps its principal, realm, audience, authentication time and absolute expiry' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION identity.guard_session() FROM PUBLIC;
CREATE TRIGGER session_guard BEFORE UPDATE ON identity.session FOR EACH ROW EXECUTE FUNCTION identity.guard_session();

-- 22.4 role_assignment: role realm = principal realm; privileged roles only in admin_pool; location_bound <=> location_id;
-- no role for a principal whose subject is still null (SEC01-F-08: a pre-registered google principal is inert until its
-- first sign-in binds it). An unreadable role or principal row fails closed.
CREATE FUNCTION identity.guard_role_assignment() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  r record;
  p record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.role_id IS DISTINCT FROM OLD.role_id
       OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.granted_via_request_id IS DISTINCT FROM OLD.granted_via_request_id
       OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id THEN
      RAISE EXCEPTION 'a role assignment is only ever revoked' USING ERRCODE = 'PS001';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'a revoked role assignment stays revoked' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT realm, privileged, location_bound INTO r FROM identity.role WHERE id = NEW.role_id;
  SELECT realm, subject INTO p FROM identity.principal WHERE id = NEW.principal_id;
  IF r IS NULL OR p IS NULL THEN
    RAISE EXCEPTION 'role or principal not found' USING ERRCODE = 'PS001';
  END IF;
  IF r.realm IS DISTINCT FROM p.realm THEN
    RAISE EXCEPTION 'the role realm must equal the principal realm' USING ERRCODE = 'PS001';
  END IF;
  IF r.privileged AND p.realm <> 'admin_pool' THEN
    RAISE EXCEPTION 'a privileged role is held only in the admin realm' USING ERRCODE = 'PS001';
  END IF;
  IF r.location_bound <> (NEW.location_id IS NOT NULL) THEN
    RAISE EXCEPTION 'location_id is set exactly for location-bound roles' USING ERRCODE = 'PS001';
  END IF;
  IF p.subject IS NULL THEN
    RAISE EXCEPTION 'a principal that has not signed in yet can hold no role' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION identity.guard_role_assignment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.guard_role_assignment() TO app_api, app_worker;
CREATE TRIGGER role_assignment_guard BEFORE INSERT OR UPDATE ON identity.role_assignment FOR EACH ROW EXECUTE FUNCTION identity.guard_role_assignment();

-- 22.4 / ST-06 proxy_grant: requested -> verified -> active -> revoked | expired, plus requested|verified -> revoked.
-- revoked and expired are K (kept) states: no further update by any route or job (22.16, 21.5). A re-point of an R row
-- (merge) changes patient_id and nothing else.
CREATE FUNCTION identity.guard_proxy_grant() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status IN ('revoked', 'expired') THEN
    RAISE EXCEPTION 'a revoked or expired proxy grant accepts no change' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.proxy_principal_id IS DISTINCT FROM OLD.proxy_principal_id
     OR NEW.relationship IS DISTINCT FROM OLD.relationship OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id THEN
    RAISE EXCEPTION 'a proxy grant keeps its proxy, relationship and scope' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('verified', 'revoked'))
    OR (OLD.status = 'verified'  AND NEW.status IN ('active', 'revoked'))
    OR (OLD.status = 'active'    AND NEW.status IN ('revoked', 'expired'))) THEN
    RAISE EXCEPTION 'illegal proxy grant transition' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION identity.guard_proxy_grant() FROM PUBLIC;
CREATE TRIGGER proxy_grant_guard BEFORE UPDATE ON identity.proxy_grant FOR EACH ROW EXECUTE FUNCTION identity.guard_proxy_grant();

-- 22.4 staff_support: both principals are in realm google.
CREATE FUNCTION identity.guard_staff_support() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF (SELECT count(*) FROM identity.principal p
        WHERE p.id IN (NEW.assistant_principal_id, NEW.supported_principal_id) AND p.realm = 'google') <> 2 THEN
    RAISE EXCEPTION 'staff support links two google-realm principals' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION identity.guard_staff_support() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.guard_staff_support() TO app_api, app_worker;
CREATE TRIGGER staff_support_guard BEFORE INSERT OR UPDATE ON identity.staff_support FOR EACH ROW EXECUTE FUNCTION identity.guard_staff_support();
