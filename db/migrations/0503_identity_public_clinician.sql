-- migration-class: expand
-- identity.public_clinician (ARCHITECTURE 22.5.1, TDR-14; ticket BE-04): the C0 directory view of listed, active google-realm
-- clinicians, owned by directory_ro, with the T-DIRECTORY policies and directory_ro's column grants (the projected columns
-- plus the filter and join columns, TDR-16). npi, dea_number, supervisor_principal_id, the flags, emails and subjects are not granted.
-- Run by app_owner, which holds SET-only membership of directory_ro (21.2): that is what lets it give the view away.

GRANT USAGE, CREATE ON SCHEMA identity TO directory_ro;

GRANT SELECT (id, organisation_id, realm, status) ON identity.principal TO directory_ro;
CREATE POLICY principal_directory ON identity.principal
  FOR SELECT TO directory_ro
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('public', 'patient')
     AND realm = 'google' AND status = 'active');

GRANT SELECT (principal_id, organisation_id, display_name, directory_listed) ON identity.staff_profile TO directory_ro;
CREATE POLICY staff_profile_directory ON identity.staff_profile
  FOR SELECT TO directory_ro
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('public', 'patient')
     AND directory_listed);

CREATE VIEW identity.public_clinician AS
  SELECT sp.principal_id, sp.display_name, sp.organisation_id
  FROM identity.staff_profile sp
  JOIN identity.principal p ON p.id = sp.principal_id
  WHERE sp.directory_listed AND p.realm = 'google' AND p.status = 'active';
REVOKE ALL ON identity.public_clinician FROM PUBLIC;
GRANT SELECT ON identity.public_clinician TO app_api;
-- grants first: once directory_ro owns the view, app_owner can no longer change its privileges
ALTER VIEW identity.public_clinician OWNER TO directory_ro;

-- 21.2 (d): CREATE is needed only for the ownership transfer above.
REVOKE CREATE ON SCHEMA identity FROM directory_ro;
