-- migration-class: expand
-- The seven organisation C0 directory views of ARCHITECTURE 22.5.1 (ticket BE-03), the T-DIRECTORY policies TO directory_ro and
-- directory_ro's column grants, exactly the per-table lists of 22.5.1 (projected columns plus filter/join columns).
-- Run by app_owner (non-superuser): it holds SET-only membership of directory_ro (21.2, TDR-15), which is what lets it give
-- the views to that role. Owner-rights views (no security_invoker): they read the base tables as directory_ro, whose
-- policies match audience public and patient only. app_api gets SELECT on the views, never on the role.
-- The other two of the nine views, identity.public_clinician and scheduling.public_clinician_location, read tables of the
-- identity and scheduling modules, which do not exist yet: they are created by the tickets that create those tables.

GRANT USAGE, CREATE ON SCHEMA organisation TO directory_ro;

-- organisation.location
GRANT SELECT (id, organisation_id, name, kind, time_zone, address, state_code, geo, phone, active) ON organisation.location TO directory_ro;
CREATE POLICY location_directory ON organisation.location
  FOR SELECT TO directory_ro
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('public', 'patient')
     AND active);

-- organisation.service
GRANT SELECT (id, organisation_id, patient_display_name, duration_min, mode, active) ON organisation.service TO directory_ro;
CREATE POLICY service_directory ON organisation.service
  FOR SELECT TO directory_ro
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('public', 'patient')
     AND active);

-- organisation.service_location
GRANT SELECT (service_id, location_id, organisation_id) ON organisation.service_location TO directory_ro;
CREATE POLICY service_location_directory ON organisation.service_location
  FOR SELECT TO directory_ro
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('public', 'patient')
     AND true);

-- organisation.service_clinician
GRANT SELECT (service_id, clinician_principal_id, organisation_id) ON organisation.service_clinician TO directory_ro;
CREATE POLICY service_clinician_directory ON organisation.service_clinician
  FOR SELECT TO directory_ro
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('public', 'patient')
     AND true);

-- organisation.opening_hours
GRANT SELECT (location_id, weekday, opens, closes, organisation_id) ON organisation.opening_hours TO directory_ro;
CREATE POLICY opening_hours_directory ON organisation.opening_hours
  FOR SELECT TO directory_ro
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('public', 'patient')
     AND true);

-- organisation.holiday
GRANT SELECT (location_id, date, name, organisation_id) ON organisation.holiday TO directory_ro;
CREATE POLICY holiday_directory ON organisation.holiday
  FOR SELECT TO directory_ro
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('public', 'patient')
     AND true);

-- organisation.banner
GRANT SELECT (id, organisation_id, message, starts_at, ends_at, surface) ON organisation.banner TO directory_ro;
CREATE POLICY banner_directory ON organisation.banner
  FOR SELECT TO directory_ro
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('public', 'patient')
     AND surface = 'site' AND now() >= starts_at AND now() < ends_at);

CREATE VIEW organisation.public_location AS
  SELECT l.id, l.organisation_id, l.name, l.kind, l.time_zone, l.address, l.state_code, l.geo, l.phone
  FROM organisation.location l
  WHERE l.active;
REVOKE ALL ON organisation.public_location FROM PUBLIC;
GRANT SELECT ON organisation.public_location TO app_api;
-- grants first: once directory_ro owns the view, app_owner can no longer change its privileges
ALTER VIEW organisation.public_location OWNER TO directory_ro;

CREATE VIEW organisation.public_service AS
  SELECT s.id, s.organisation_id, s.patient_display_name, s.duration_min, s.mode
  FROM organisation.service s
  WHERE s.active;
REVOKE ALL ON organisation.public_service FROM PUBLIC;
GRANT SELECT ON organisation.public_service TO app_api;
-- grants first: once directory_ro owns the view, app_owner can no longer change its privileges
ALTER VIEW organisation.public_service OWNER TO directory_ro;

CREATE VIEW organisation.public_service_location AS
  SELECT sl.service_id, sl.location_id, sl.organisation_id
  FROM organisation.service_location sl
  JOIN organisation.service s ON s.id = sl.service_id AND s.active
  JOIN organisation.location l ON l.id = sl.location_id AND l.active;
REVOKE ALL ON organisation.public_service_location FROM PUBLIC;
GRANT SELECT ON organisation.public_service_location TO app_api;
-- grants first: once directory_ro owns the view, app_owner can no longer change its privileges
ALTER VIEW organisation.public_service_location OWNER TO directory_ro;

CREATE VIEW organisation.public_service_clinician AS
  SELECT sc.service_id, sc.clinician_principal_id, sc.organisation_id
  FROM organisation.service_clinician sc
  JOIN organisation.service s ON s.id = sc.service_id AND s.active;
REVOKE ALL ON organisation.public_service_clinician FROM PUBLIC;
GRANT SELECT ON organisation.public_service_clinician TO app_api;
-- grants first: once directory_ro owns the view, app_owner can no longer change its privileges
ALTER VIEW organisation.public_service_clinician OWNER TO directory_ro;

CREATE VIEW organisation.public_opening_hours AS
  SELECT oh.location_id, oh.weekday, oh.opens, oh.closes, oh.organisation_id
  FROM organisation.opening_hours oh
  JOIN organisation.location l ON l.id = oh.location_id AND l.active;
REVOKE ALL ON organisation.public_opening_hours FROM PUBLIC;
GRANT SELECT ON organisation.public_opening_hours TO app_api;
-- grants first: once directory_ro owns the view, app_owner can no longer change its privileges
ALTER VIEW organisation.public_opening_hours OWNER TO directory_ro;

CREATE VIEW organisation.public_holiday AS
  SELECT h.location_id, h.date, h.name, h.organisation_id
  FROM organisation.holiday h;
REVOKE ALL ON organisation.public_holiday FROM PUBLIC;
GRANT SELECT ON organisation.public_holiday TO app_api;
-- grants first: once directory_ro owns the view, app_owner can no longer change its privileges
ALTER VIEW organisation.public_holiday OWNER TO directory_ro;

CREATE VIEW organisation.public_banner AS
  SELECT b.id, b.organisation_id, b.message, b.starts_at, b.ends_at
  FROM organisation.banner b
  WHERE b.surface = 'site' AND now() >= b.starts_at AND now() < b.ends_at;
REVOKE ALL ON organisation.public_banner FROM PUBLIC;
GRANT SELECT ON organisation.public_banner TO app_api;
-- grants first: once directory_ro owns the view, app_owner can no longer change its privileges
ALTER VIEW organisation.public_banner OWNER TO directory_ro;

