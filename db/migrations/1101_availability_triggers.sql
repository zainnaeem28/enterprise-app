-- migration-class: expand
-- Triggers of the availability tables (ARCHITECTURE 21.5; ticket BE-12). Invoker rights, search_path pinned to pg_catalog.

CREATE TRIGGER availability_template_bump_row_version BEFORE UPDATE ON scheduling.availability_template FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER template_rule_bump_row_version BEFORE UPDATE ON scheduling.template_rule FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER blocked_time_bump_row_version BEFORE UPDATE ON scheduling.blocked_time FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER roster_entry_bump_row_version BEFORE UPDATE ON scheduling.roster_entry FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- A template keeps its doctor and organisation for life (the rules copy the doctor; a different doctor is a different template).
-- A retired template stays retired (history is kept; a new template is a new row).
CREATE FUNCTION scheduling.guard_template() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.clinician_principal_id IS DISTINCT FROM OLD.clinician_principal_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a template keeps its doctor' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status = 'retired' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a retired template stays retired' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.guard_template() FROM PUBLIC;
CREATE TRIGGER availability_template_guard BEFORE UPDATE ON scheduling.availability_template FOR EACH ROW EXECUTE FUNCTION scheduling.guard_template();

-- A blocked-time row keeps its doctor; only its time, kind and note change.
CREATE FUNCTION scheduling.guard_blocked_time() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.clinician_principal_id IS DISTINCT FROM OLD.clinician_principal_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'blocked time keeps its doctor' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.guard_blocked_time() FROM PUBLIC;
CREATE TRIGGER blocked_time_guard BEFORE UPDATE ON scheduling.blocked_time FOR EACH ROW EXECUTE FUNCTION scheduling.guard_blocked_time();

-- A roster entry keeps its place and duty; the holder and the time can be corrected.
CREATE FUNCTION scheduling.guard_roster_entry() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.duty IS DISTINCT FROM OLD.duty
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a roster entry keeps its place and duty' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION scheduling.guard_roster_entry() FROM PUBLIC;
CREATE TRIGGER roster_entry_guard BEFORE UPDATE ON scheduling.roster_entry FOR EACH ROW EXECUTE FUNCTION scheduling.guard_roster_entry();
