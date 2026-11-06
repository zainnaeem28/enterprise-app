-- migration-class: expand
-- Triggers of the documents tables (ARCHITECTURE 21.5, 22.7, 22.16, 23.1 ST-06, 25.10; SHARED-BOUNDARIES 9.2; ticket BE-10).
-- Invoker rights, search_path pinned to pg_catalog, schema-qualified names only, except documents.guard_open_patient (below).
-- SQLSTATE PS001: illegal state transition or a write to a kept (K) row; PS002: the business refusal of deleting a held or retained
-- document (its message carries the reason code `legal_hold` or `retention`).
--
-- The database, not the route, decides who may move a document to which state: a file becomes `clean` only when the worker has
-- recorded a clean scan of the object (and the version row then names the clean bucket); only staff confirm; `deleted` follows only
-- a deletion request that was decided `deleted` after the hold and retention checks (ST-06, BR-29, AC-31).

CREATE TRIGGER document_bump_row_version BEFORE UPDATE ON documents.document FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER document_version_bump_row_version BEFORE UPDATE ON documents.document_version FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER deletion_request_bump_row_version BEFORE UPDATE ON documents.deletion_request FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- The merge write guard (SBR-12, 9.2). Same refusal, same name as patient.guard_open_patient (the M-5 check looks for the name): a
-- copy, because that function is owned by patient_scope_owner with EXECUTE revoked from PUBLIC and app_owner cannot attach it
-- (the BE-11 departure D1, README). 1003 moves this copy to patient_scope_owner too, so it reads the root whatever the caller's
-- scope is, and it takes the same FOR KEY SHARE lock, which conflicts with the merge's FOR UPDATE on the root.
CREATE FUNCTION documents.guard_open_patient() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.patient_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF (SELECT kernel.setting('app.audience')) IS NULL
     OR (SELECT kernel.setting('app.audience')) NOT IN ('patient', 'staff', 'system')
     OR (SELECT kernel.uuid1('app.org_id')) IS DISTINCT FROM NEW.organisation_id THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  SELECT p.status INTO v_status FROM patient.patient p WHERE p.id = NEW.patient_id AND p.organisation_id = NEW.organisation_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient not found' USING ERRCODE = 'PM008';
  END IF;
  IF v_status = 'merged' THEN
    RAISE EXCEPTION 'patient.merged' USING ERRCODE = 'PM001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION documents.guard_open_patient() FROM PUBLIC;
CREATE TRIGGER document_guard_open BEFORE INSERT OR UPDATE ON documents.document FOR EACH ROW EXECUTE FUNCTION documents.guard_open_patient();
CREATE TRIGGER document_version_guard_open BEFORE INSERT OR UPDATE ON documents.document_version FOR EACH ROW EXECUTE FUNCTION documents.guard_open_patient();
CREATE TRIGGER legal_hold_guard_open BEFORE INSERT OR UPDATE ON documents.legal_hold FOR EACH ROW EXECUTE FUNCTION documents.guard_open_patient();
CREATE TRIGGER deletion_request_guard_open BEFORE INSERT OR UPDATE ON documents.deletion_request FOR EACH ROW EXECUTE FUNCTION documents.guard_open_patient();

-- Why a document may not be deleted now: 'legal_hold' when the latest hold row says placed (a hold wins over retention), 'retention'
-- when the retention date is unset (D-8 undecided, fail closed) or not yet reached, else NULL. VOLATILE on purpose: it reads a fresh
-- snapshot after the advisory lock below, so a hold committed a moment ago is seen.
CREATE FUNCTION documents.deletion_blockers(p_document uuid) RETURNS text
  LANGUAGE sql
  VOLATILE
  SET search_path = pg_catalog
  AS $$
  SELECT CASE
    WHEN (SELECT h.action FROM documents.legal_hold h WHERE h.document_id = p_document ORDER BY h.seq DESC LIMIT 1) = 'placed' THEN 'legal_hold'
    WHEN NOT EXISTS (SELECT 1 FROM documents.document d WHERE d.id = p_document AND d.retention_until IS NOT NULL AND d.retention_until <= current_date) THEN 'retention'
    ELSE NULL
  END
$$;
REVOKE ALL ON FUNCTION documents.deletion_blockers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION documents.deletion_blockers(uuid) TO app_api, app_worker;

-- documents.document: ST-06 and who may take each step ----------------------------------------------------------------------
CREATE FUNCTION documents.guard_document() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_aud    text := kernel.setting('app.audience');
  v_realm  text := kernel.setting('app.realm');
  v_worker boolean := (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system');
  v_staff  boolean := (kernel.setting('app.audience') = 'staff' AND kernel.setting('app.realm') = 'google');
  v_ver    documents.document_version%ROWTYPE;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by OR NEW.upload_channel IS DISTINCT FROM OLD.upload_channel
     OR NEW.current_version IS DISTINCT FROM OLD.current_version OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a document keeps its identity, uploader and version' USING ERRCODE = 'PS001';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    -- No state change. The merge re-points patient_id in any state (R); everything else is fixed in a terminal state.
    IF OLD.status IN ('quarantined', 'deleted')
       AND (NEW.classification IS DISTINCT FROM OLD.classification OR NEW.suggested_classification IS DISTINCT FROM OLD.suggested_classification
            OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
            OR NEW.retention_until IS DISTINCT FROM OLD.retention_until OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
      RAISE EXCEPTION 'a finished document accepts no change' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.retention_until IS DISTINCT FROM OLD.retention_until OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      RAISE EXCEPTION 'confirmation, retention and deletion are written with their state change' USING ERRCODE = 'PS001';
    END IF;
    -- Classification is staff's, and only before the confirmation that makes it the record.
    IF NEW.classification IS DISTINCT FROM OLD.classification AND NOT (OLD.status = 'clean' AND v_staff) THEN
      RAISE EXCEPTION 'only staff classify, and only a clean document that is not yet confirmed' USING ERRCODE = 'PS001';
    END IF;
    -- The OCR suggestion is the worker's, and only while the document waits for staff.
    IF NEW.suggested_classification IS DISTINCT FROM OLD.suggested_classification AND NOT (OLD.status = 'clean' AND v_worker) THEN
      RAISE EXCEPTION 'the suggestion is written by the worker for a clean, unconfirmed document' USING ERRCODE = 'PS001';
    END IF;
    RETURN NEW;
  END IF;

  -- A state change: the allowed steps (ST-06), who takes them, and what must already be true.
  IF NEW.classification IS DISTINCT FROM OLD.classification AND NOT (OLD.status = 'clean' AND NEW.status = 'confirmed' AND v_staff) THEN
    RAISE EXCEPTION 'classification changes on its own, not with another step' USING ERRCODE = 'PS001';
  END IF;
  SELECT * INTO v_ver FROM documents.document_version v WHERE v.document_id = OLD.id AND v.version = OLD.current_version;

  IF OLD.status = 'awaiting_upload' AND NEW.status = 'scanning' THEN
    IF v_aud NOT IN ('patient', 'staff') OR v_ver.document_id IS NULL OR v_ver.scan_status <> 'pending' OR v_ver.scan_requested_at IS NULL THEN
      RAISE EXCEPTION 'illegal document transition' USING ERRCODE = 'PS001';
    END IF;
  ELSIF OLD.status = 'scanning' AND NEW.status = 'clean' THEN
    IF NOT v_worker OR v_ver.document_id IS NULL OR v_ver.scan_status <> 'clean' OR v_ver.bucket <> 'clean' THEN
      RAISE EXCEPTION 'a document is clean only after a clean scan of its object' USING ERRCODE = 'PS001';
    END IF;
  ELSIF OLD.status = 'scanning' AND NEW.status = 'quarantined' THEN
    IF NOT v_worker OR v_ver.document_id IS NULL OR v_ver.scan_status <> 'infected' THEN
      RAISE EXCEPTION 'a document is quarantined only after an infected scan result' USING ERRCODE = 'PS001';
    END IF;
  ELSIF OLD.status = 'clean' AND NEW.status = 'confirmed' THEN
    IF NOT v_staff OR NEW.confirmed_by IS DISTINCT FROM kernel.uuid1('app.principal_id') OR NEW.confirmed_at IS NULL
       OR v_ver.document_id IS NULL OR v_ver.scan_status <> 'clean' OR v_ver.bucket <> 'clean' THEN
      RAISE EXCEPTION 'a document is confirmed by staff, after a clean scan' USING ERRCODE = 'PS001';
    END IF;
  ELSIF OLD.status = 'confirmed' AND NEW.status = 'deleted' THEN
    IF NOT v_staff OR NEW.deleted_at IS NULL THEN
      RAISE EXCEPTION 'illegal document transition' USING ERRCODE = 'PS001';
    END IF;
    -- Serialised with legal_hold inserts and with the decision itself (same key); then the blockers are read afresh.
    PERFORM pg_advisory_xact_lock(hashtextextended('doc-hold:' || OLD.id::text, 0));
    IF documents.deletion_blockers(OLD.id) IS NOT NULL THEN
      RAISE EXCEPTION '%', documents.deletion_blockers(OLD.id) USING ERRCODE = 'PS002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM documents.deletion_request r WHERE r.document_id = OLD.id AND r.outcome = 'deleted') THEN
      RAISE EXCEPTION 'deletion follows a deletion request that was decided deleted' USING ERRCODE = 'PS001';
    END IF;
  ELSE
    RAISE EXCEPTION 'illegal document transition' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION documents.guard_document() FROM PUBLIC;
CREATE TRIGGER document_guard BEFORE UPDATE ON documents.document FOR EACH ROW EXECUTE FUNCTION documents.guard_document();

-- A new document starts in awaiting_upload with no confirmation, suggestion or deletion; the classification is the uploader's.
CREATE FUNCTION documents.check_document_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.status <> 'awaiting_upload' OR NEW.current_version <> 1 OR NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL
     OR NEW.deleted_at IS NOT NULL OR NEW.retention_until IS NOT NULL OR NEW.suggested_classification IS NOT NULL THEN
    RAISE EXCEPTION 'a document starts awaiting its upload' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION documents.check_document_insert() FROM PUBLIC;
CREATE TRIGGER document_insert_check BEFORE INSERT ON documents.document FOR EACH ROW EXECUTE FUNCTION documents.check_document_insert();

-- documents.document_version: the object's scan and OCR state --------------------------------------------------------------
CREATE FUNCTION documents.guard_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_aud    text := kernel.setting('app.audience');
  v_worker boolean := (current_user = 'app_worker' AND kernel.setting('app.audience') = 'system');
BEGIN
  IF NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.declared_content_type IS DISTINCT FROM OLD.declared_content_type
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a version keeps its identity' USING ERRCODE = 'PS001';
  END IF;

  -- The start of the scan clock is written once, by the caller who completes the upload.
  IF NEW.scan_requested_at IS DISTINCT FROM OLD.scan_requested_at
     AND (OLD.scan_requested_at IS NOT NULL OR v_aud NOT IN ('patient', 'staff') OR OLD.scan_status <> 'pending') THEN
    RAISE EXCEPTION 'the scan request time is written once, when the upload is completed' USING ERRCODE = 'PS001';
  END IF;

  -- The scan outcome and what follows from it (the clean copy's key, hash and bucket) are the worker's.
  IF NEW.scan_status IS DISTINCT FROM OLD.scan_status OR NEW.scanned_at IS DISTINCT FROM OLD.scanned_at
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.object_key IS DISTINCT FROM OLD.object_key OR NEW.bucket IS DISTINCT FROM OLD.bucket
     OR NEW.content_type IS DISTINCT FROM OLD.content_type OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes THEN
    IF NOT v_worker THEN
      RAISE EXCEPTION 'only the scan job writes scan results' USING ERRCODE = 'PS001';
    END IF;
    IF OLD.scan_status IN ('clean', 'infected') THEN
      RAISE EXCEPTION 'a scan result is final' USING ERRCODE = 'PS001';
    END IF;
    IF NOT ((OLD.scan_status, NEW.scan_status) IN (('pending', 'pending'), ('pending', 'clean'), ('pending', 'infected'), ('pending', 'error'),
                                                  ('error', 'error'), ('error', 'pending'), ('error', 'clean'), ('error', 'infected'))) THEN
      RAISE EXCEPTION 'illegal scan transition' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.scan_status = 'clean' THEN
      -- Only a clean scan moves the file: a new random key in the clean bucket.
      IF NEW.bucket <> 'clean' OR NEW.object_key = OLD.object_key THEN
        RAISE EXCEPTION 'a clean file is copied to the clean bucket under a new key' USING ERRCODE = 'PS001';
      END IF;
    ELSIF NEW.bucket IS DISTINCT FROM OLD.bucket OR NEW.object_key IS DISTINCT FROM OLD.object_key THEN
      RAISE EXCEPTION 'a file that is not clean stays in quarantine' USING ERRCODE = 'PS001';
    END IF;
  END IF;

  -- OCR suggestion state: the worker's, for a clean file.
  IF NEW.ocr_status IS DISTINCT FROM OLD.ocr_status THEN
    IF NOT v_worker OR NEW.scan_status <> 'clean' THEN
      RAISE EXCEPTION 'OCR state is written by the worker for a clean file' USING ERRCODE = 'PS001';
    END IF;
    IF NOT ((OLD.ocr_status, NEW.ocr_status) IN (('not_requested', 'pending'), ('not_requested', 'skipped'), ('pending', 'done'), ('pending', 'failed'),
                                                ('pending', 'skipped'), ('failed', 'pending'))) THEN
      RAISE EXCEPTION 'illegal OCR transition' USING ERRCODE = 'PS001';
    END IF;
  END IF;

  -- The retention sweep records that it removed the stored object, once, for a document that is deleted or quarantined.
  IF NEW.object_removed_at IS DISTINCT FROM OLD.object_removed_at THEN
    IF NOT v_worker OR OLD.object_removed_at IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM documents.document d WHERE d.id = OLD.document_id AND d.status IN ('deleted', 'quarantined')) THEN
      RAISE EXCEPTION 'an object is removed once, for a deleted or quarantined document' USING ERRCODE = 'PS001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION documents.guard_version() FROM PUBLIC;
CREATE TRIGGER document_version_guard BEFORE UPDATE ON documents.document_version FOR EACH ROW EXECUTE FUNCTION documents.guard_version();

-- A version starts pending, in quarantine, for its own document's patient and organisation.
CREATE FUNCTION documents.check_version_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.scan_status <> 'pending' OR NEW.bucket <> 'quarantine' OR NEW.sha256 IS NOT NULL OR NEW.scanned_at IS NOT NULL
     OR NEW.scan_requested_at IS NOT NULL OR NEW.ocr_status <> 'not_requested' OR NEW.object_removed_at IS NOT NULL
     OR NEW.content_type <> NEW.declared_content_type THEN
    RAISE EXCEPTION 'a version starts pending in quarantine' USING ERRCODE = 'PS001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM documents.document d WHERE d.id = NEW.document_id AND d.organisation_id = NEW.organisation_id
                  AND d.patient_id = NEW.patient_id AND d.current_version = NEW.version AND d.status = 'awaiting_upload') THEN
    RAISE EXCEPTION 'a version belongs to its document''s patient and current version' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION documents.check_version_insert() FROM PUBLIC;
CREATE TRIGGER document_version_insert_check BEFORE INSERT ON documents.document_version FOR EACH ROW EXECUTE FUNCTION documents.check_version_insert();

-- documents.legal_hold: append-only ---------------------------------------------------------------------------------------
CREATE FUNCTION documents.refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'append-only: a later change is a new row' USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION documents.refuse_change() FROM PUBLIC;
CREATE TRIGGER legal_hold_append_only BEFORE UPDATE OR DELETE ON documents.legal_hold FOR EACH ROW EXECUTE FUNCTION documents.refuse_change();

-- A hold row changes the state (placed after released or nothing; released after placed), belongs to the document's current patient,
-- and is serialised with deletion decisions through the same advisory key.
CREATE FUNCTION documents.check_hold_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_last text;
BEGIN
  IF NOT (kernel.setting('app.audience') = 'staff' AND kernel.setting('app.realm') = 'google') THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('doc-hold:' || NEW.document_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM documents.document d WHERE d.id = NEW.document_id AND d.organisation_id = NEW.organisation_id
                  AND d.patient_id = NEW.patient_id AND d.status <> 'deleted') THEN
    RAISE EXCEPTION 'a hold names a document of its patient that is not deleted' USING ERRCODE = 'PS001';
  END IF;
  SELECT h.action INTO v_last FROM documents.legal_hold h WHERE h.document_id = NEW.document_id ORDER BY h.seq DESC LIMIT 1;
  IF (NEW.action = 'placed' AND v_last = 'placed') OR (NEW.action = 'released' AND v_last IS DISTINCT FROM 'placed') THEN
    RAISE EXCEPTION 'the hold is already in that state' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION documents.check_hold_insert() FROM PUBLIC;
CREATE TRIGGER legal_hold_insert_check BEFORE INSERT ON documents.legal_hold FOR EACH ROW EXECUTE FUNCTION documents.check_hold_insert();

-- documents.deletion_request: decided rows are kept; the outcome must be what the checks say ------------------------------
CREATE FUNCTION documents.guard_deletion_request() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_blocker text;
  v_status  text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.outcome <> 'pending' THEN
      RAISE EXCEPTION 'a decided deletion request is kept' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a deletion request keeps its document and requester' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.outcome = 'pending' THEN
      RETURN NEW; -- only the merge re-points a pending request
    END IF;
    IF NOT (kernel.setting('app.audience') = 'staff' AND kernel.setting('app.realm') = 'google') OR NEW.decided_by IS DISTINCT FROM kernel.uuid1('app.principal_id') THEN
      RAISE EXCEPTION 'only staff decide, and name themselves' USING ERRCODE = 'PS001';
    END IF;
  ELSE
    IF NEW.outcome = 'deleted' THEN
      RAISE EXCEPTION 'a request is decided after it is made' USING ERRCODE = 'PS001';
    END IF;
  END IF;

  IF NEW.outcome <> 'pending' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('doc-hold:' || NEW.document_id::text, 0));
    SELECT d.status INTO v_status FROM documents.document d WHERE d.id = NEW.document_id AND d.patient_id = NEW.patient_id;
    v_blocker := documents.deletion_blockers(NEW.document_id);
    IF NEW.outcome = 'deleted' AND (v_blocker IS NOT NULL OR v_status IS DISTINCT FROM 'confirmed') THEN
      RAISE EXCEPTION '%', coalesce(v_blocker, 'not_confirmed') USING ERRCODE = 'PS002';
    END IF;
    IF NEW.outcome = 'refused_legal_hold' AND v_blocker IS DISTINCT FROM 'legal_hold' THEN
      RAISE EXCEPTION 'no legal hold is in force' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.outcome = 'refused_retention' AND v_blocker IS DISTINCT FROM 'retention' THEN
      RAISE EXCEPTION 'no retention refusal applies' USING ERRCODE = 'PS001';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM documents.document d WHERE d.id = NEW.document_id AND d.organisation_id = NEW.organisation_id
                     AND d.patient_id = NEW.patient_id) THEN
    RAISE EXCEPTION 'a request names a document of its patient' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION documents.guard_deletion_request() FROM PUBLIC;
CREATE TRIGGER deletion_request_guard BEFORE INSERT OR UPDATE ON documents.deletion_request FOR EACH ROW EXECUTE FUNCTION documents.guard_deletion_request();
