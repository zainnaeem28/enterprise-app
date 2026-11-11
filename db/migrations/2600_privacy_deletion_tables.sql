-- migration-class: expand
-- Account deletion and retention, tables and the request state machine (owner ruling 2026-11-11 C, items 1 and 2; PRD D-8, C-05 †,
-- C-20 †; ticket HEAAA-789 C-BE-DEL; migrations 2600-2619). DDL only (SBR-17). Rights of the retention role and the definer functions:
-- 2601. The constraint this change relaxes (a deletion request could only be blocked_d8 or refused) is dropped in the contract file 2602.
--
-- What changes:
--   * privacy.deletion_record: one row per executed deletion request. It holds what the deletion did (counts per class, no PHI), the
--     statement to the patient (what was deleted, what is kept, why and until when), the date the kept medical record may be purged and
--     whether the purge has happened. It carries NO patient_id column on purpose: it follows its request (which is a merge participant),
--     so the merge needs no new participant.
--   * privacy.retention_run: the report of one run of the daily retention job (counts per class, no PHI). Append-only.
--   * privacy.guard_request: a deletion request now starts `received` (a pre-existing `blocked_d8` insert from the previous release is
--     still accepted, N-1) and moves like every other kind: identity verified by compliance, approved by compliance, completed by the
--     worker. A deletion request can be completed only when its deletion_record exists. D-8 is decided by the ruling, so no step is
--     blocked on it any more; a legacy blocked_d8 row that was verified can be approved too.
--
-- Down-note (forward-only): to go back, restore privacy.guard_request from 1901/1903 and drop the two tables. Nothing else depends on them.

CREATE TABLE privacy.deletion_record (
  id                   uuid        PRIMARY KEY,
  organisation_id      uuid        NOT NULL,
  request_id           uuid        NOT NULL REFERENCES privacy.request (id),
  executed_at          timestamptz NOT NULL,
  principals_disabled  integer     NOT NULL CHECK (principals_disabled >= 0),
  sessions_revoked     integer     NOT NULL CHECK (sessions_revoked >= 0),
  -- Counts per class, class names only (no values, no identifiers): what was deleted now and what is kept.
  deleted_counts       jsonb       NOT NULL CHECK (jsonb_typeof(deleted_counts) = 'object' AND pg_column_size(deleted_counts) <= 4096),
  kept_counts          jsonb       NOT NULL CHECK (jsonb_typeof(kept_counts) = 'object' AND pg_column_size(kept_counts) <= 4096),
  -- Documents under a legal hold at execution: never deleted, whatever their state.
  held_documents       integer     NOT NULL CHECK (held_documents >= 0),
  -- The last day the medical record must be kept (retention settings; the purge may run the day after).
  retained_until       date        NOT NULL,
  -- The statement to the patient: structured, no PHI (class names, counts, dates, reasons as codes).
  statement            jsonb       NOT NULL CHECK (jsonb_typeof(statement) = 'object' AND pg_column_size(statement) <= 8192),
  statement_sent_at    timestamptz,
  purge_state          text        NOT NULL DEFAULT 'pending' CHECK (purge_state IN ('pending', 'objects_pending', 'purged')),
  purge_checked_at     timestamptz,
  purge_deferred_reason text       CHECK (purge_deferred_reason IS NULL OR purge_deferred_reason IN ('legal_hold', 'document_retention')),
  purged_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_job       uuid,
  row_version          bigint      NOT NULL DEFAULT 1,
  updated_at           timestamptz,
  CONSTRAINT deletion_record_request_uq UNIQUE (request_id),
  CONSTRAINT deletion_record_purge_shape CHECK ((purge_state = 'purged') = (purged_at IS NOT NULL))
);
COMMENT ON TABLE privacy.deletion_record IS 'class=C2; no patient_id: follows its request, which is the merge participant. Counts and class names only, no PHI';
CREATE INDEX deletion_record_purge_idx ON privacy.deletion_record (retained_until) WHERE purge_state <> 'purged';

CREATE TABLE privacy.retention_run (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz NOT NULL,
  status           text        NOT NULL CHECK (status IN ('completed', 'partial')),
  -- Counts per class and the cut-off dates used, class names only. No PHI, no identifiers.
  report           jsonb       NOT NULL CHECK (jsonb_typeof(report) = 'object' AND pg_column_size(report) <= 16384),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by_job   uuid
);
COMMENT ON TABLE privacy.retention_run IS 'class=C1; one row per run of the daily retention job, counts per class only, no PHI; append-only';
CREATE INDEX retention_run_started_idx ON privacy.retention_run (started_at);

CREATE TRIGGER deletion_record_bump_row_version BEFORE UPDATE ON privacy.deletion_record FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- deletion_record: what may change, by whom. The statement and counts never change; the worker records the sending of the statement once;
-- the purge columns are the retention role's (2601). A record is deleted only by the retention role, after the HIPAA documentation period.
CREATE FUNCTION privacy.guard_deletion_record() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_sys   boolean := (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system');
  v_owner boolean := (current_user = 'privacy_retention_owner');
  v_old   jsonb;
  v_new   jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT v_sys OR NEW.statement_sent_at IS NOT NULL OR NEW.purge_state <> 'pending' OR NEW.purged_at IS NOT NULL
       OR NEW.purge_checked_at IS NOT NULL OR NEW.purge_deferred_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a deletion record is written by the worker, with nothing sent and nothing purged' USING ERRCODE = 'PS001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM privacy.request r
                    WHERE r.id = NEW.request_id AND r.organisation_id = NEW.organisation_id AND r.kind = 'deletion' AND r.status = 'in_progress'
                      AND r.verified_at IS NOT NULL AND r.decided_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a deletion record belongs to an approved, identity-verified deletion request' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  v_old := to_jsonb(OLD) - 'row_version' - 'updated_at';
  v_new := to_jsonb(NEW) - 'row_version' - 'updated_at';
  IF OLD.purge_state = 'purged' THEN
    RAISE EXCEPTION 'a purged deletion record is final' USING ERRCODE = 'PS001';
  END IF;
  -- The worker records that the statement was sent, once.
  IF NEW.statement_sent_at IS DISTINCT FROM OLD.statement_sent_at THEN
    IF NOT v_sys OR OLD.statement_sent_at IS NOT NULL OR NEW.statement_sent_at IS NULL
       OR (v_old - 'statement_sent_at') IS DISTINCT FROM (v_new - 'statement_sent_at') THEN
      RAISE EXCEPTION 'the sending of the statement is recorded once, by the worker, and changes nothing else' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  -- The purge columns are the retention role's.
  IF NOT v_owner OR (v_old - 'purge_state' - 'purge_checked_at' - 'purge_deferred_reason' - 'purged_at')
                    IS DISTINCT FROM (v_new - 'purge_state' - 'purge_checked_at' - 'purge_deferred_reason' - 'purged_at') THEN
    RAISE EXCEPTION 'a deletion record changes only its statement-sent time and, for the retention role, its purge state' USING ERRCODE = 'PS001';
  END IF;
  IF NOT ((OLD.purge_state = 'pending'         AND NEW.purge_state IN ('pending', 'objects_pending', 'purged'))
       OR (OLD.purge_state = 'objects_pending' AND NEW.purge_state IN ('objects_pending', 'purged'))) THEN
    RAISE EXCEPTION 'the purge only moves forward' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION privacy.guard_deletion_record() FROM PUBLIC;
CREATE TRIGGER deletion_record_guard BEFORE INSERT OR UPDATE ON privacy.deletion_record FOR EACH ROW EXECUTE FUNCTION privacy.guard_deletion_record();
CREATE TRIGGER deletion_record_no_delete BEFORE DELETE ON privacy.deletion_record FOR EACH ROW
  WHEN (current_user <> 'privacy_retention_owner') EXECUTE FUNCTION privacy.refuse_delete();

CREATE FUNCTION privacy.refuse_run_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'a retention report is append-only' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION privacy.refuse_run_change() FROM PUBLIC;
CREATE TRIGGER retention_run_append_only BEFORE UPDATE OR DELETE ON privacy.retention_run FOR EACH ROW EXECUTE FUNCTION privacy.refuse_run_change();

-- Row-level security -----------------------------------------------------------------------------------------------------
ALTER TABLE privacy.deletion_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy.deletion_record FORCE  ROW LEVEL SECURITY;
ALTER TABLE privacy.retention_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy.retention_run FORCE  ROW LEVEL SECURITY;

-- Compliance (admin realm, the privacy_requests slice) reads both, never writes. The record is reached through its request, which
-- the slice already reaches.
CREATE POLICY deletion_record_slice_select ON privacy.deletion_record
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff'
     AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited'
     AND 'privacy_requests' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ','))
     AND EXISTS (SELECT 1 FROM privacy.request r WHERE r.id = deletion_record.request_id));
CREATE POLICY retention_run_slice_select ON privacy.retention_run
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff'
     AND (SELECT kernel.setting('app.realm')) = 'admin_pool' AND (SELECT kernel.setting('app.phi_access')) = 'limited'
     AND 'privacy_requests' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));

-- The worker: the organisation-scope retention job reads every record and writes its report; the patients-scope deletion job reads
-- and writes the record of its own request (the job's exact patient IDs).
CREATE POLICY deletion_record_system_select ON privacy.deletion_record
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'
          OR ((SELECT kernel.setting('app.job_scope')) = 'patients'
              AND EXISTS (SELECT 1 FROM privacy.request r WHERE r.id = deletion_record.request_id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids'))))));
CREATE POLICY deletion_record_system_insert ON privacy.deletion_record
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM privacy.request r WHERE r.id = deletion_record.request_id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY deletion_record_system_update ON privacy.deletion_record
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM privacy.request r WHERE r.id = deletion_record.request_id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'patients'
     AND EXISTS (SELECT 1 FROM privacy.request r WHERE r.id = deletion_record.request_id AND r.patient_id = ANY (kernel.uuids('app.job_patient_ids'))));
CREATE POLICY retention_run_system_select ON privacy.retention_run
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');
CREATE POLICY retention_run_system_insert ON privacy.retention_run
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND (SELECT kernel.setting('app.job_scope')) = 'org');

REVOKE ALL ON privacy.deletion_record, privacy.retention_run FROM PUBLIC;
GRANT SELECT ON privacy.deletion_record, privacy.retention_run TO app_api, app_worker;
GRANT INSERT (id, organisation_id, request_id, executed_at, principals_disabled, sessions_revoked, deleted_counts, kept_counts,
              held_documents, retained_until, statement, created_by_job) ON privacy.deletion_record TO app_worker;
GRANT UPDATE (statement_sent_at) ON privacy.deletion_record TO app_worker;
GRANT INSERT (id, organisation_id, started_at, finished_at, status, report, created_by_job) ON privacy.retention_run TO app_worker;

-- The request state machine ---------------------------------------------------------------------------------------------
-- Body of 1901/1903 with four changes (marked D2600): a deletion request starts received (or legacy blocked_d8); identity verification
-- takes a deletion request to identity_verified like any other kind; compliance approves a verified deletion request (from
-- identity_verified, or from a verified legacy blocked_d8); a deletion request is completed only when its deletion_record exists.
CREATE OR REPLACE FUNCTION privacy.guard_request() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_who     uuid := kernel.uuid1('app.principal_id');
  v_person  uuid := kernel.uuid1('app.person_id');
  v_aud     text := kernel.setting('app.audience');
  v_admin   boolean := (kernel.setting('app.audience') = 'staff' AND kernel.setting('app.realm') = 'admin_pool');
  v_sys     boolean := (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system');
  v_col     text;
  v_old     jsonb;
  v_new     jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- D2600: a deletion request starts received; blocked_d8 is still accepted from the previous release (N-1).
    IF NEW.status <> 'received' AND NOT (NEW.kind = 'deletion' AND NEW.status = 'blocked_d8') THEN
      RAISE EXCEPTION 'a request starts received' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.verification_method IS NOT NULL OR NEW.decided_by_person_id IS NOT NULL OR NEW.legal_hold_checked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new request has no verification, decision or hold check' USING ERRCODE = 'PS001';
    END IF;
    IF v_who IS NOT NULL AND NEW.requested_by_principal_id <> v_who THEN
      RAISE EXCEPTION 'a request is recorded under the caller' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('fulfilled', 'refused') THEN
    RAISE EXCEPTION 'a fulfilled or refused request is final' USING ERRCODE = 'PS001';
  END IF;
  FOREACH v_col IN ARRAY ARRAY['id', 'organisation_id', 'kind', 'requested_by_principal_id', 'channel', 'detail', 'due_at', 'created_at', 'created_by'] LOOP
    IF to_jsonb(OLD) -> v_col IS DISTINCT FROM to_jsonb(NEW) -> v_col THEN
      RAISE EXCEPTION 'a request keeps its kind, requester, channel and due date' USING ERRCODE = 'PS001';
    END IF;
  END LOOP;
  v_old := to_jsonb(OLD) - 'row_version' - 'updated_at';
  v_new := to_jsonb(NEW) - 'row_version' - 'updated_at';

  -- The merge moves a request that is not final to the survivor and changes nothing else (22.16).
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    IF NOT v_sys THEN
      RAISE EXCEPTION 'only a merge moves a request to another patient' USING ERRCODE = 'PS001';
    END IF;
    IF (v_old - 'patient_id') IS DISTINCT FROM (v_new - 'patient_id') THEN
      RAISE EXCEPTION 'a merge changes nothing but the patient' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  -- The legal-hold check: the worker writes these two columns and nothing else in the same statement.
  IF NEW.legal_hold_documents IS DISTINCT FROM OLD.legal_hold_documents OR NEW.legal_hold_checked_at IS DISTINCT FROM OLD.legal_hold_checked_at THEN
    IF NOT v_sys THEN
      RAISE EXCEPTION 'only the system records the legal-hold check' USING ERRCODE = 'PS001';
    END IF;
    IF (v_old - 'legal_hold_documents' - 'legal_hold_checked_at') IS DISTINCT FROM (v_new - 'legal_hold_documents' - 'legal_hold_checked_at') THEN
      RAISE EXCEPTION 'a hold check changes nothing else' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  -- Identity verification: once, by compliance (admin realm), for the caller's own person. A legacy blocked_d8 row keeps its status.
  IF OLD.verified_at IS NULL AND NEW.verified_at IS NOT NULL THEN
    IF NOT v_admin OR NEW.verified_by_person_id IS DISTINCT FROM v_person THEN
      RAISE EXCEPTION 'identity is verified by compliance, under the caller' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.decided_by_person_id IS NOT NULL OR NEW.decision_reason IS NOT NULL THEN
      RAISE EXCEPTION 'verifying identity decides nothing' USING ERRCODE = 'PS001';
    END IF;
    -- D2600: the deletion kind is no longer excluded from received -> identity_verified.
    IF NOT ((OLD.status = 'received' AND NEW.status = 'identity_verified')
         OR (OLD.status = 'blocked_d8' AND NEW.status = 'blocked_d8')) THEN
      RAISE EXCEPTION 'illegal verification step' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.verified_at IS DISTINCT FROM OLD.verified_at OR NEW.verification_method IS DISTINCT FROM OLD.verification_method
     OR NEW.verified_by_person_id IS DISTINCT FROM OLD.verified_by_person_id THEN
    RAISE EXCEPTION 'identity is verified once' USING ERRCODE = 'PS001';
  END IF;

  -- Decisions: refuse (any live request, with a reason), approve (identity_verified -> in_progress), complete (in_progress -> fulfilled).
  IF NEW.status = 'refused' THEN
    IF NOT v_admin OR NEW.decided_by_person_id IS DISTINCT FROM v_person THEN
      RAISE EXCEPTION 'a request is refused by compliance, under the caller' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  -- D2600: a verified legacy blocked_d8 deletion request can be approved like an identity_verified one.
  IF (OLD.status = 'identity_verified' OR (OLD.status = 'blocked_d8' AND OLD.verified_at IS NOT NULL)) AND NEW.status = 'in_progress' THEN
    IF NOT v_admin OR NEW.decided_by_person_id IS DISTINCT FROM v_person OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason THEN
      RAISE EXCEPTION 'a request is approved by compliance, under the caller' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'in_progress' AND NEW.status = 'fulfilled' THEN
    IF NOT (v_sys OR v_admin) THEN
      RAISE EXCEPTION 'a request is completed by the system or by compliance' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.decided_by_person_id IS DISTINCT FROM OLD.decided_by_person_id OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'completing a request keeps its decision' USING ERRCODE = 'PS001';
    END IF;
    -- D2600: a deletion request is completed by the worker, and only once its deletion record (the statement) exists.
    IF OLD.kind = 'deletion' AND (NOT v_sys OR NOT EXISTS (SELECT 1 FROM privacy.deletion_record d WHERE d.request_id = OLD.id)) THEN
      RAISE EXCEPTION 'a deletion request is completed by the worker, after its deletion record is written' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal request step' USING ERRCODE = 'PS001';
END
$$;
