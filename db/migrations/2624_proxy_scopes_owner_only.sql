-- migration-class: expand
-- HEAAA-791 BR-PROXY-01: a proxy (or an invitee accepting) must never change the scopes of a grant, even though the accept and leave
-- policies let them update their own row. Only the patient who owns the record, acting as themselves and not as a proxy, changes scopes.
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
  IF NEW.proxy_principal_id IS DISTINCT FROM OLD.proxy_principal_id
     AND NOT (v_invite AND NEW.proxy_principal_id IS NOT NULL AND NEW.status = 'active') THEN
    RAISE EXCEPTION 'a proxy grant keeps its proxy' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('verified', 'revoked'))
    OR (OLD.status = 'verified'  AND NEW.status IN ('active', 'revoked'))
    OR (OLD.status = 'active'    AND NEW.status IN ('revoked', 'expired'))
    OR (v_invite AND OLD.status IN ('requested', 'verified') AND NEW.status IN ('active', 'revoked', 'expired'))) THEN
    RAISE EXCEPTION 'illegal proxy grant transition' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status = 'active' AND OLD.status <> 'active' AND kernel.setting('app.audience') IN ('patient', 'staff')
     AND NEW.proxy_principal_id IS DISTINCT FROM kernel.uuid1('app.principal_id') THEN
    RAISE EXCEPTION 'a proxy grant is activated by its proxy' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND coalesce(kernel.setting('app.audience'), '') IN ('patient', 'staff')
     AND NEW.status NOT IN ('revoked', 'active') THEN
    RAISE EXCEPTION 'a portal request can only revoke a proxy grant or accept an invitation' USING ERRCODE = 'PS001';
  END IF;
  -- Scopes: only the patient who owns the record, as themselves (never while acting as a proxy), and never on a guardian grant.
  IF NEW.scopes IS DISTINCT FROM OLD.scopes AND (
       OLD.guardian
       OR coalesce(kernel.setting('app.audience'), '') <> 'patient'
       OR NOT (OLD.patient_id = ANY (kernel.uuids('app.patient_ids')))
       OR OLD.patient_id = ANY (kernel.uuids('app.proxy_patient_ids'))
       OR OLD.proxy_principal_id IS NOT DISTINCT FROM kernel.uuid1('app.principal_id')) THEN
    RAISE EXCEPTION 'only the patient changes the scopes of a proxy grant' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
