-- migration-class: expand
-- scheduling.replace_busy_blocks: the one writer of scheduling.busy_block (ARCHITECTURE 22.8 "T-SYS write, worker through
-- scheduling.replaceBusyBlocks", 24, 33.1 QA-AL-01; ticket BE-14, answering BE-12 departure D5).
-- SECURITY DEFINER, owned by the NOLOGIN function-owner role scheduling_booking_owner, fixed search_path = pg_catalog, schema-qualified
-- names only, REVOKE ALL FROM PUBLIC, EXECUTE to app_worker only (DF-1, DF-8). It checks the caller's scope settings itself (6.2 rule 3):
-- an organisation-wide system job only. No application role holds any right on busy_block beyond SELECT.
--
-- The call replaces a doctor's `google` busy blocks with exactly the given set, keyed by external_hash (the hash of the Google event
-- ID, no title): a block absent from the set is deleted, one already present is kept (its period and synced_at refreshed), a new one is
-- inserted, never duplicated. The set is the COMPLETE set: the incremental sync merges its delta into the current rows before calling.
--
-- SQLSTATEs: 42501 not available to this caller; 22023 bad argument.

GRANT CREATE ON SCHEMA scheduling TO scheduling_booking_owner; -- the ownership transfer needs it (21.2 point 1); withdrawn at once

CREATE POLICY busy_block_owner_select ON scheduling.busy_block
  FOR SELECT TO scheduling_booking_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY busy_block_owner_insert ON scheduling.busy_block
  FOR INSERT TO scheduling_booking_owner
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY busy_block_owner_update ON scheduling.busy_block
  FOR UPDATE TO scheduling_booking_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system')
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system');
CREATE POLICY busy_block_owner_delete ON scheduling.busy_block
  FOR DELETE TO scheduling_booking_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'system');
GRANT SELECT, DELETE ON scheduling.busy_block TO scheduling_booking_owner;
GRANT INSERT (organisation_id, clinician_principal_id, period, source, external_hash, synced_at) ON scheduling.busy_block TO scheduling_booking_owner;
GRANT UPDATE (period, synced_at) ON scheduling.busy_block TO scheduling_booking_owner;

CREATE FUNCTION scheduling.replace_busy_blocks(p_clinician uuid, p_hashes bytea[], p_periods tstzrange[],
                                               OUT inserted integer, OUT updated integer, OUT deleted integer)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  v_n   integer;
  v_i   integer;
BEGIN
  IF v_org IS NULL OR kernel.setting('app.audience') IS DISTINCT FROM 'system' OR kernel.setting('app.job_scope') IS DISTINCT FROM 'org' THEN
    RAISE EXCEPTION 'replace_busy_blocks: only an organisation-wide job may call this' USING ERRCODE = '42501';
  END IF;
  IF p_clinician IS NULL OR p_hashes IS NULL OR p_periods IS NULL
     OR coalesce(array_length(p_hashes, 1), 0) <> coalesce(array_length(p_periods, 1), 0)
     OR coalesce(array_length(p_hashes, 1), 0) > 20000 THEN
    RAISE EXCEPTION 'replace_busy_blocks: bad argument' USING ERRCODE = '22023';
  END IF;
  v_n := coalesce(array_length(p_hashes, 1), 0);
  FOR v_i IN 1 .. v_n LOOP
    IF p_hashes[v_i] IS NULL OR octet_length(p_hashes[v_i]) NOT BETWEEN 16 AND 64
       OR p_periods[v_i] IS NULL OR isempty(p_periods[v_i]) OR lower_inf(p_periods[v_i]) OR upper_inf(p_periods[v_i])
       OR NOT lower_inc(p_periods[v_i]) OR upper_inc(p_periods[v_i])
       OR upper(p_periods[v_i]) - lower(p_periods[v_i]) > interval '400 days' THEN
      RAISE EXCEPTION 'replace_busy_blocks: bad argument' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT h) FROM unnest(p_hashes) AS h) <> v_n THEN
    RAISE EXCEPTION 'replace_busy_blocks: bad argument' USING ERRCODE = '22023';
  END IF;

  -- One writer per doctor at a time: two syncs of the same calendar cannot interleave their delete and insert.
  PERFORM pg_advisory_xact_lock(hashtext('bb:' || p_clinician::text));

  DELETE FROM scheduling.busy_block b
   WHERE b.organisation_id = v_org AND b.clinician_principal_id = p_clinician AND b.source = 'google'
     AND NOT (b.external_hash = ANY (p_hashes));
  GET DIAGNOSTICS deleted = ROW_COUNT;

  WITH up AS (
    INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at)
    SELECT v_org, p_clinician, t.period, 'google', t.hash, now()
      FROM unnest(p_hashes, p_periods) AS t(hash, period)
    ON CONFLICT (clinician_principal_id, external_hash) DO UPDATE SET period = EXCLUDED.period, synced_at = EXCLUDED.synced_at
    RETURNING (xmax = 0) AS was_inserted
  )
  SELECT coalesce(count(*) FILTER (WHERE was_inserted), 0), coalesce(count(*) FILTER (WHERE NOT was_inserted), 0)
    INTO inserted, updated FROM up;
END
$$;

REVOKE ALL ON FUNCTION scheduling.replace_busy_blocks(uuid, bytea[], tstzrange[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scheduling.replace_busy_blocks(uuid, bytea[], tstzrange[]) TO app_worker;
ALTER FUNCTION scheduling.replace_busy_blocks(uuid, bytea[], tstzrange[]) OWNER TO scheduling_booking_owner;

-- The CREATE right on the schema was needed only to move the ownership above.
REVOKE CREATE ON SCHEMA scheduling FROM scheduling_booking_owner;
