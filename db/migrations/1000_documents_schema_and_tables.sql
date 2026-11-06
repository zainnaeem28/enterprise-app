-- migration-class: expand
-- documents schema (ARCHITECTURE 5.1, 22.7, 25.10; PRD BR-28, BR-29; ticket BE-10, migrations 1000-1099).
-- DDL only (SBR-17). Triggers: 1001. Row-level security and grants: 1002. Merge guard ownership: 1003.
--
-- Created here: document (metadata, status, classification, retention), document_version (the stored object: random key, bucket,
-- scan and OCR state), legal_hold (append-only) and deletion_request (decided requests are kept).
--
-- Small, recorded departures from 22.7 (all additive; see the module README):
--   * document_version.declared_content_type, scan_requested_at and object_removed_at (what the uploader declared and the presigned
--     URL fixed; when the scan clock started, for the 30-minute window of 25.10; when the retention sweep removed the object);
--   * legal_hold.seq (identity), so "the latest action" is the order of the writes and not of a clock;
--   * deletion_request.decided_by (who decided);
--   * an object key is `q/<32 hex>` (quarantine) or `c/<32 hex>` (clean): random, never a name, never PHI (CHECK below).

CREATE SCHEMA documents;
COMMENT ON SCHEMA documents IS 'Document metadata, versions, legal holds, deletion requests (ARCHITECTURE 22.7)';
REVOKE ALL ON SCHEMA documents FROM PUBLIC;
GRANT USAGE ON SCHEMA documents TO app_api, app_worker;
-- Needed only to move the merge write guard's ownership to the function-owner role (1003); withdrawn again there.
GRANT CREATE ON SCHEMA documents TO patient_scope_owner;

CREATE TABLE documents.document (
  id                        uuid        PRIMARY KEY,
  organisation_id           uuid        NOT NULL,
  patient_id                uuid        NOT NULL REFERENCES patient.patient (id),
  classification            text        NOT NULL CHECK (classification IN ('insurance_card', 'id_document', 'consent', 'referral_letter', 'external_record',
                                                                           'clinical_photo', 'patient_upload_other', 'questionnaire_attachment')),
  suggested_classification  text        CHECK (suggested_classification IS NULL OR suggested_classification IN ('insurance_card', 'id_document', 'consent',
                                                                           'referral_letter', 'external_record', 'clinical_photo', 'patient_upload_other',
                                                                           'questionnaire_attachment')),
  status                    text        NOT NULL CHECK (status IN ('awaiting_upload', 'scanning', 'quarantined', 'clean', 'confirmed', 'deleted')),
  current_version           integer     NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  uploaded_by               uuid        NOT NULL REFERENCES identity.principal (id),
  upload_channel            text        NOT NULL CHECK (upload_channel IN ('patient', 'staff')),
  confirmed_by              uuid        REFERENCES identity.principal (id),
  confirmed_at              timestamptz,
  retention_until           date,
  deleted_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  created_by_job            uuid,
  row_version               bigint      NOT NULL DEFAULT 1,
  updated_at                timestamptz,
  CONSTRAINT document_confirmed_shape CHECK (status <> 'confirmed' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CONSTRAINT document_deleted_shape CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
COMMENT ON TABLE documents.document IS 'class=C2; merge participant R (metadata is mutable; the record follows the patient)';
CREATE INDEX document_patient_idx ON documents.document (patient_id, created_at);
CREATE INDEX document_pending_scan_idx ON documents.document (status) WHERE status IN ('scanning', 'quarantined');

CREATE TABLE documents.document_version (
  document_id               uuid        NOT NULL REFERENCES documents.document (id),
  version                   integer     NOT NULL CHECK (version >= 1),
  organisation_id           uuid        NOT NULL,
  patient_id                uuid        NOT NULL REFERENCES patient.patient (id),
  -- Random, no name and no PHI. The clean copy gets a new random key (25.10).
  object_key                text        NOT NULL CHECK (object_key ~ '^[qc]/[0-9a-f]{32}$'),
  bucket                    text        NOT NULL CHECK (bucket IN ('quarantine', 'clean')),
  sha256                    bytea       CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
  size_bytes                bigint      NOT NULL CHECK (size_bytes > 0),
  -- The type the upload URL fixed, then (when the scan is clean) the type the file's own bytes show.
  content_type              text        NOT NULL CHECK (char_length(content_type) BETWEEN 3 AND 100),
  declared_content_type     text        NOT NULL CHECK (char_length(declared_content_type) BETWEEN 3 AND 100),
  scan_status               text        NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'error')),
  scanned_at                timestamptz,
  scan_requested_at         timestamptz,
  ocr_status                text        NOT NULL DEFAULT 'not_requested' CHECK (ocr_status IN ('not_requested', 'pending', 'done', 'failed', 'skipped')),
  object_removed_at         timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  row_version               bigint      NOT NULL DEFAULT 1,
  updated_at                timestamptz,
  PRIMARY KEY (document_id, version),
  CONSTRAINT document_version_key_uq UNIQUE (object_key),
  -- A file is in the clean bucket only after a clean scan; a clean scan has a hash and a time.
  CONSTRAINT document_version_clean_shape CHECK (bucket = 'quarantine' OR scan_status = 'clean'),
  CONSTRAINT document_version_scan_shape CHECK (scan_status <> 'clean' OR (sha256 IS NOT NULL AND scanned_at IS NOT NULL AND bucket = 'clean')),
  CONSTRAINT document_version_key_bucket CHECK ((bucket = 'quarantine') = (object_key LIKE 'q/%'))
);
COMMENT ON TABLE documents.document_version IS 'class=C2; merge participant R (draft 6, TDR-02: the scan and OCR jobs update the row, so it follows its document to the survivor)';
CREATE INDEX document_version_patient_idx ON documents.document_version (patient_id);

CREATE TABLE documents.legal_hold (
  id                        uuid        PRIMARY KEY,
  seq                       bigint      GENERATED ALWAYS AS IDENTITY,
  organisation_id           uuid        NOT NULL,
  document_id               uuid        NOT NULL REFERENCES documents.document (id),
  patient_id                uuid        NOT NULL REFERENCES patient.patient (id),
  action                    text        NOT NULL CHECK (action IN ('placed', 'released')),
  reason                    text        NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  by_person_id              uuid        NOT NULL REFERENCES identity.person (id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid
);
COMMENT ON TABLE documents.legal_hold IS 'class=C2; merge participant K (append-only; a later change is a new row that carries the survivor''s patient_id)';
CREATE INDEX legal_hold_document_idx ON documents.legal_hold (document_id, seq);
CREATE INDEX legal_hold_patient_idx ON documents.legal_hold (patient_id);

CREATE TABLE documents.deletion_request (
  id                        uuid        PRIMARY KEY,
  organisation_id           uuid        NOT NULL,
  document_id               uuid        NOT NULL REFERENCES documents.document (id),
  patient_id                uuid        NOT NULL REFERENCES patient.patient (id),
  requested_by              uuid        NOT NULL REFERENCES identity.principal (id),
  outcome                   text        NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'deleted', 'refused_legal_hold', 'refused_retention')),
  reason_recorded           text        CHECK (reason_recorded IS NULL OR char_length(reason_recorded) BETWEEN 1 AND 500),
  decided_at                timestamptz,
  decided_by                uuid        REFERENCES identity.principal (id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  row_version               bigint      NOT NULL DEFAULT 1,
  updated_at                timestamptz,
  CONSTRAINT deletion_request_decided_shape CHECK ((outcome = 'pending') = (decided_at IS NULL)),
  -- A refusal always records its reason (AC-31).
  CONSTRAINT deletion_request_reason_shape CHECK (outcome IN ('pending', 'deleted') OR reason_recorded IS NOT NULL)
);
COMMENT ON TABLE documents.deletion_request IS 'class=C2; merge participant R/K (pending R; decided K)';
CREATE UNIQUE INDEX deletion_request_one_pending_uq ON documents.deletion_request (document_id) WHERE outcome = 'pending';
CREATE INDEX deletion_request_patient_idx ON documents.deletion_request (patient_id);
