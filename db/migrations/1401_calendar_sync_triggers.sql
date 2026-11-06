-- migration-class: expand
-- Triggers of the calendar_sync tables (ARCHITECTURE 21.5, 22.9; ticket BE-14). Invoker rights, search_path pinned to pg_catalog,
-- schema-qualified names only. SQLSTATE PS001: illegal state transition.
--
-- The database, not the route, decides that a link cannot be `active` without a stored token reference, and which moves a link and a
-- busy-event mapping may make. The guard runs with the CALLER's rights: a doctor (callback) and the worker each see the reference
-- through their own policies of 1402.

CREATE TRIGGER calendar_link_bump_row_version BEFORE UPDATE ON calendar_sync.calendar_link
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER event_map_bump_row_version BEFORE UPDATE ON calendar_sync.event_map
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

CREATE FUNCTION calendar_sync.guard_calendar_link() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_consent' OR NEW.sync_token IS NOT NULL OR NEW.last_synced_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new calendar link starts pending consent' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.clinician_principal_id <> OLD.clinician_principal_id OR NEW.organisation_id <> OLD.organisation_id
     OR NEW.token_secret_name <> OLD.token_secret_name THEN
    RAISE EXCEPTION 'calendar link identity is immutable' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.status = 'active' AND OLD.status <> 'active' THEN
    -- A link becomes active only once the doctor's refresh token has been stored as an outbound secret reference (BD-11).
    IF NOT EXISTS (SELECT 1
                     FROM integration_core.secret_ref r
                     JOIN integration_core.connection c ON c.id = r.connection_id
                    WHERE c.kind = 'google_calendar' AND r.class = 'outbound' AND r.name = NEW.token_secret_name) THEN
      RAISE EXCEPTION 'no stored token for this link' USING ERRCODE = 'PS001';
    END IF;
  END IF;
  IF OLD.status = 'pending_consent' AND NEW.status IN ('token_revoked') THEN
    RAISE EXCEPTION 'illegal calendar link transition' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER calendar_link_guard BEFORE INSERT OR UPDATE ON calendar_sync.calendar_link
  FOR EACH ROW EXECUTE FUNCTION calendar_sync.guard_calendar_link();

CREATE FUNCTION calendar_sync.guard_event_map() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.occupancy_id <> OLD.occupancy_id OR NEW.clinician_principal_id <> OLD.clinician_principal_id
     OR NEW.google_event_id <> OLD.google_event_id OR NEW.organisation_id <> OLD.organisation_id THEN
    RAISE EXCEPTION 'event map identity is immutable' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER event_map_guard BEFORE UPDATE ON calendar_sync.event_map
  FOR EACH ROW EXECUTE FUNCTION calendar_sync.guard_event_map();
