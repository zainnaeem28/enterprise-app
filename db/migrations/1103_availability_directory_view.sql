-- migration-class: expand
-- scheduling.public_clinician_location (ARCHITECTURE 22.5.1, TDR-14; ticket BE-12): the C0 directory view of the (clinician, location)
-- pairs that have an active, not-yet-ended availability template, owned by directory_ro, with the T-DIRECTORY policy and directory_ro's
-- column grants (the projected columns plus the filter column). The clinician directory a patient sees is the intersection of this view,
-- identity.public_clinician and organisation.public_service_clinician, computed in the API (22.5.1 "Clinician directory").
-- Run by app_owner, which holds SET-only membership of directory_ro (21.2): that is what lets it give the view away.

GRANT USAGE, CREATE ON SCHEMA scheduling TO directory_ro;

GRANT SELECT (organisation_id, clinician_principal_id, location_id, status, valid_to) ON scheduling.availability_template TO directory_ro;
CREATE POLICY availability_template_directory ON scheduling.availability_template
  FOR SELECT TO directory_ro
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) IN ('public', 'patient')
     AND status = 'active');

CREATE VIEW scheduling.public_clinician_location AS
  SELECT DISTINCT t.clinician_principal_id, t.location_id, t.organisation_id
  FROM scheduling.availability_template t
  WHERE t.status = 'active' AND (t.valid_to IS NULL OR t.valid_to >= current_date);
REVOKE ALL ON scheduling.public_clinician_location FROM PUBLIC;
GRANT SELECT ON scheduling.public_clinician_location TO app_api;
-- grants first: once directory_ro owns the view, app_owner can no longer change its privileges
ALTER VIEW scheduling.public_clinician_location OWNER TO directory_ro;

-- 21.2 (d): CREATE is needed only for the ownership transfer above.
REVOKE CREATE ON SCHEMA scheduling FROM directory_ro;
