-- migration-class: expand
-- INT02-R9-B1: the worker's patients-scope jobs (scheduling.offer_waitlist offers per candidate patient) run the availability check
-- `windows`, which joins identity.principal to know that the clinician is active (staff path, audience system). principal_system_read
-- (0502) only matches job scope `org`, so in patients scope app_worker saw 0 principal rows, every slot resolved outside_hours and
-- every candidate was skipped.
--
-- Narrowest grant that fixes it: SELECT only, same role and audience, job scope `patients`, and only active google-realm (clinician /
-- staff) principals. Patient-pool, admin-pool and non-active principals stay invisible in patients scope. Column grants are unchanged.
-- Not a widening of `org` scope: org-scope jobs keep principal_system_read as is.

CREATE POLICY principal_system_patients_read ON identity.principal
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker'
     AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND realm = 'google' AND status = 'active');
