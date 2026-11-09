-- migration-class: expand
-- INT03-F08d, ruling HEAAA-325 rev 3 R-REF-9 (security review HEAAA-328 F-01; C-1 failure of rev 2, HEAAA-336). ARCHITECTURE 22.11:
-- the target location's staff read a referral while it is SENT to them. 1702 also gave them accepted and declined rows for good.
-- Now the target branch needs the referral's inbox row at that same location to be PENDING. The status list stays only so the
-- deciding UPDATE (referral first, inbox second, in one transaction) still sees its own new row. The T-STAFF and BTG branches are
-- unchanged.

-- (a) The pending-inbox test, as an invoker PL/pgSQL function and NOT as an inline subquery. inbox_staff_insert (1702) reads
--     clinical.referral, so a referral policy that reads clinical.referral_inbox inline is a policy cycle: PostgreSQL expands policies
--     per relation, whatever the command, and refuses the send's inbox INSERT with 42P17. A PL/pgSQL body is never inlined; it is
--     planned on its own at run time, under the caller's own inbox SELECT policy (inbox_staff_select: settings only, no further
--     table), so there is no cycle at rewrite or at run time. Invoker, not SECURITY DEFINER: it reads nothing the caller cannot
--     already read. Two-valued: NULL arguments give false.
CREATE FUNCTION clinical.referral_inbox_pending(p_referral_id uuid, p_organisation_id uuid, p_location_id uuid) RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SET search_path = pg_catalog
  AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM clinical.referral_inbox i
                  WHERE i.referral_id = p_referral_id AND i.organisation_id = p_organisation_id
                    AND i.target_location_id = p_location_id AND i.status = 'pending');
END
$$;
REVOKE ALL ON FUNCTION clinical.referral_inbox_pending(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.referral_inbox_pending(uuid, uuid, uuid) TO app_api;

-- (b) The two 1702 policies, altered (0705 pattern). Only the second branch gains the call; everything else is 1702's text.
ALTER POLICY referral_staff_select ON clinical.referral
  USING ((organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = referral.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR referral.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
      OR (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND referral.status IN ('sent', 'accepted', 'declined') AND referral.target_kind IN ('internal_location', 'internal_service') AND referral.target_location_id = ANY (kernel.uuids('app.location_ids'))
          AND clinical.referral_inbox_pending(referral.id, referral.organisation_id, referral.target_location_id)));
ALTER POLICY referral_staff_update ON clinical.referral
  USING ((organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = referral.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR referral.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
      OR (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND referral.status IN ('sent', 'accepted', 'declined') AND referral.target_kind IN ('internal_location', 'internal_service') AND referral.target_location_id = ANY (kernel.uuids('app.location_ids'))
          AND clinical.referral_inbox_pending(referral.id, referral.organisation_id, referral.target_location_id)))
  WITH CHECK ((organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = referral.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR referral.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
      OR (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND referral.status IN ('sent', 'accepted', 'declined') AND referral.target_kind IN ('internal_location', 'internal_service') AND referral.target_location_id = ANY (kernel.uuids('app.location_ids'))
          AND clinical.referral_inbox_pending(referral.id, referral.organisation_id, referral.target_location_id)));
