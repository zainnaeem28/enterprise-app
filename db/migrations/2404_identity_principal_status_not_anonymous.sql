-- migration-class: expand
-- BE-05: the column grant on principal(status, disabled_reason) exists for the staff-realm kill switch and deprovisioning, and
-- RLS policy principal_signin_update (T-SIGNIN) matches the same rows for an anonymous transaction. The grant is per role, so
-- the anonymous sign-in path must be stopped here: it may change subject and last_sign_in_at only (21.2, 21.3).
CREATE FUNCTION identity.guard_principal_status_not_anonymous() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  -- UPDATE OF fires when the column is named in SET, so even a no-change write is refused.
  IF kernel.setting('app.audience') = 'anonymous' THEN
    RAISE EXCEPTION 'an anonymous transaction cannot change the status of a principal' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION identity.guard_principal_status_not_anonymous() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.guard_principal_status_not_anonymous() TO app_api, app_worker;
CREATE TRIGGER principal_status_not_anonymous BEFORE UPDATE OF status, disabled_reason ON identity.principal
  FOR EACH ROW EXECUTE FUNCTION identity.guard_principal_status_not_anonymous();
