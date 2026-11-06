-- migration-class: expand
-- audit.btg_grant, audit.btg_review, audit.export_job (ARCHITECTURE 22.2; ST-06; SA-F-11).
-- patient_id on btg_grant has no foreign key yet: schema `patient` (root key patient.patient) is created by a later
-- ticket, which adds the constraint (22.2: FK to the root, ON DELETE RESTRICT) in its own migration range.

CREATE TABLE audit.btg_grant (
  id                  uuid        PRIMARY KEY,
  organisation_id     uuid        NOT NULL,
  holder_principal_id uuid        NOT NULL,
  holder_person_id    uuid        NOT NULL,
  holder_realm        text        NOT NULL CHECK (holder_realm IN ('google', 'admin_pool')),
  patient_id          uuid        NOT NULL,
  reason              text        NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  opened_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  review_status       text        NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'justified', 'not_justified')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  created_by_job      uuid,
  row_version         bigint      NOT NULL DEFAULT 1,
  updated_at          timestamptz,
  CONSTRAINT btg_grant_expiry CHECK (expires_at > opened_at)
);
CREATE INDEX btg_grant_holder_idx ON audit.btg_grant (holder_principal_id, expires_at);
CREATE INDEX btg_grant_review_idx ON audit.btg_grant (review_status, opened_at);
CREATE INDEX btg_grant_patient_idx ON audit.btg_grant (patient_id);
COMMENT ON TABLE audit.btg_grant IS 'class=C2';

CREATE TRIGGER btg_grant_bump_row_version BEFORE UPDATE ON audit.btg_grant
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

-- ST-06: opened -> justified | not_justified, once. A grant may be revoked once. Nothing else about a grant changes
-- (the column-level UPDATE grant of 0203 already limits the columns; this is the second wall).
CREATE FUNCTION audit.guard_btg_grant() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a break-the-glass grant is never deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.holder_principal_id IS DISTINCT FROM OLD.holder_principal_id
     OR NEW.holder_person_id IS DISTINCT FROM OLD.holder_person_id
     OR NEW.holder_realm IS DISTINCT FROM OLD.holder_realm OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a break-the-glass grant keeps its holder, patient, reason and times' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.review_status IS DISTINCT FROM OLD.review_status
     AND NOT (OLD.review_status = 'pending' AND NEW.review_status IN ('justified', 'not_justified')) THEN
    RAISE EXCEPTION 'illegal break-the-glass review transition' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a break-the-glass grant is revoked once' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION audit.guard_btg_grant() FROM PUBLIC;
CREATE TRIGGER btg_grant_guard BEFORE UPDATE OR DELETE ON audit.btg_grant
  FOR EACH ROW EXECUTE FUNCTION audit.guard_btg_grant();

-- No foreign key from btg_review to btg_grant: a foreign-key check runs as the table owner (app_owner), and app_owner holds
-- no privilege on audit tables by design (R-app-owner-no-audit-insert). guard_btg_review below reads the grant under the
-- reviewer's own rights and refuses a review of a grant it cannot see; grants are never deleted or re-keyed
-- (guard_btg_grant), so the reference cannot dangle.
CREATE TABLE audit.btg_review (
  grant_id           uuid        PRIMARY KEY,
  organisation_id    uuid        NOT NULL,
  reviewer_person_id uuid        NOT NULL,
  outcome            text        NOT NULL CHECK (outcome IN ('justified', 'not_justified')),
  note               text        CHECK (char_length(note) <= 2000),
  reviewed_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid
);
COMMENT ON TABLE audit.btg_review IS 'class=C2';

-- 22.2: reviewer is never the holder (403 audit.self_review at the API; this is the database wall). Fail closed when the
-- grant is not visible. Invoker rights: the reviewer reads the grant under the btg_grants slice.
CREATE FUNCTION audit.guard_btg_review() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  holder uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'a break-the-glass review is final' USING ERRCODE = '42501';
  END IF;
  SELECT g.holder_person_id INTO holder FROM audit.btg_grant g WHERE g.id = NEW.grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'break-the-glass grant not visible' USING ERRCODE = '42501';
  END IF;
  IF holder = NEW.reviewer_person_id THEN
    RAISE EXCEPTION 'audit.self_review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION audit.guard_btg_review() FROM PUBLIC;
CREATE TRIGGER btg_review_guard BEFORE INSERT OR UPDATE OR DELETE ON audit.btg_review
  FOR EACH ROW EXECUTE FUNCTION audit.guard_btg_review();

-- audit.export_job: one asynchronous export (RA-R1-12, SA-F-11). The two cursor columns are an addition to 22.2: the
-- chunked job resumes after the last exported row (occurred_at, event_id), and the queue payload may carry IDs only.
CREATE TABLE audit.export_job (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  requested_by_person_id  uuid        NOT NULL,
  reason                  text        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  filter                  jsonb       NOT NULL,
  status                  text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
  row_count               bigint      CHECK (row_count >= 0),
  object_key              text        CHECK (char_length(object_key) <= 500),
  expires_at              timestamptz,
  elevation_id            uuid        NOT NULL,
  last_occurred_at        timestamptz,
  last_event_id           uuid,
  chunks_done             integer     NOT NULL DEFAULT 0 CHECK (chunks_done >= 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  created_by_job          uuid,
  row_version             bigint      NOT NULL DEFAULT 1,
  updated_at              timestamptz,
  -- 22.2: the time range is required.
  CONSTRAINT export_job_filter_range CHECK (filter ? 'from' AND filter ? 'to')
);
CREATE INDEX export_job_requester_idx ON audit.export_job (requested_by_person_id, created_at);
COMMENT ON TABLE audit.export_job IS 'class=C1 (the filter may hold a patient ID: C2)';
CREATE TRIGGER export_job_bump_row_version BEFORE UPDATE ON audit.export_job
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

REVOKE ALL ON audit.btg_grant, audit.btg_review, audit.export_job FROM PUBLIC, app_owner;
