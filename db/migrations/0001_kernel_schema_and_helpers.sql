-- migration-class: expand
-- Kernel schema, the session-setting helpers of ARCHITECTURE 21.3 and the
-- row_version trigger of 21.5. Runs as app_owner (roles come from db/roles).

CREATE SCHEMA kernel;
COMMENT ON SCHEMA kernel IS 'Platform kernel: idempotency store, settings, reference-data versions, rate counters (ARCHITECTURE 22.1)';

REVOKE ALL ON SCHEMA kernel FROM PUBLIC;
GRANT USAGE ON SCHEMA kernel TO app_api, app_worker, identity_signin_ro, directory_ro,
  scheduling_booking_owner, patient_scope_owner, patient_match_owner, integration_receiver_owner;

-- kernel.setting(name) -> text: a missing or empty setting is NULL (fail closed).
CREATE FUNCTION kernel.setting(name text) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting(name, true), '') $$;

-- kernel.uuid1(name) -> uuid: one UUID setting, NULL when missing.
CREATE FUNCTION kernel.uuid1(name text) RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting(name, true), '')::uuid $$;

-- kernel.uuids(name) -> uuid[]: comma-separated UUID text; NULL or '' -> '{}' (fail closed).
CREATE FUNCTION kernel.uuids(name text) RETURNS uuid[]
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT coalesce(string_to_array(nullif(current_setting(name, true), ''), ',')::uuid[], '{}'::uuid[]) $$;

REVOKE ALL ON FUNCTION kernel.setting(text), kernel.uuid1(text), kernel.uuids(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.setting(text), kernel.uuid1(text), kernel.uuids(text)
  TO app_api, app_worker, identity_signin_ro, directory_ro,
     scheduling_booking_owner, patient_scope_owner, patient_match_owner, integration_receiver_owner;

-- 21.5: BEFORE UPDATE on every mutable table. Invoker rights, no table access of its own.
CREATE FUNCTION kernel.bump_row_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kernel.bump_row_version() FROM PUBLIC;
