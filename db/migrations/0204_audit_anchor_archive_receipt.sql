-- migration-class: expand
-- audit.anchor_archive_receipt (INT04-F10 decision D-2, design 3.2; SEC05-F02). The worker copies each anchor to the Object Lock
-- archive bucket and records here that it did: object key, S3 version and SHA-256 of the canonical body. audit.anchor stays fully
-- immutable (no UPDATE grant to any role). The receipt is bookkeeping, not the control: audit.verify_anchors treats the archive as the
-- authority and compares the database with it (an owner-level attacker can forge a receipt, not an Object Lock object).

-- No foreign key to audit.anchor: a foreign-key check runs as the table owner, and app_owner holds no privilege on audit.anchor (0201,
-- R-app-owner-no-audit-insert). The insert policy below requires the anchor to exist in the same organisation instead, and an anchor
-- can never be deleted (anchor_append_only), so a receipt cannot dangle.

CREATE TABLE audit.anchor_archive_receipt (
  anchor_id       bigint      PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  archive_key     text        NOT NULL CHECK (char_length(archive_key) <= 500),
  version_id      text        NOT NULL CHECK (char_length(version_id) <= 1024),
  body_sha256     bytea       NOT NULL CHECK (octet_length(body_sha256) = 32),
  archived_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE audit.anchor_archive_receipt IS 'class=C1';
COMMENT ON COLUMN audit.anchor.archived_at IS 'deprecated, never written; see audit.anchor_archive_receipt';
COMMENT ON COLUMN audit.anchor.archive_key IS 'deprecated, never written; see audit.anchor_archive_receipt';

CREATE TRIGGER anchor_receipt_append_only BEFORE UPDATE OR DELETE ON audit.anchor_archive_receipt
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER anchor_receipt_no_truncate BEFORE TRUNCATE ON audit.anchor_archive_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();

REVOKE ALL ON audit.anchor_archive_receipt FROM PUBLIC, app_owner;
ALTER TABLE audit.anchor_archive_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.anchor_archive_receipt FORCE  ROW LEVEL SECURITY;

-- T-SYS: the archive job inserts and the verification reads, organisation-wide.
-- The insert also requires the anchor to be visible to the worker in the same organisation (anchor_system_select), so a receipt's
-- organisation always equals its anchor's.
CREATE POLICY receipt_system_insert ON audit.anchor_archive_receipt
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND EXISTS (SELECT 1 FROM audit.anchor a WHERE a.id = anchor_id AND a.organisation_id = anchor_archive_receipt.organisation_id)
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'));
CREATE POLICY receipt_system_select ON audit.anchor_archive_receipt
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system'
     AND ((SELECT kernel.setting('app.job_scope')) = 'org'));
-- T-SLICE(audit_events): the compliance officer's audit viewer.
CREATE POLICY receipt_slice_select ON audit.anchor_archive_receipt
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'admin_pool'
     AND (SELECT kernel.setting('app.phi_access')) = 'limited'
     AND 'audit_events' = ANY (string_to_array(coalesce((SELECT kernel.setting('app.compliance_scopes')), ''), ',')));

GRANT INSERT, SELECT ON audit.anchor_archive_receipt TO app_worker;
GRANT SELECT ON audit.anchor_archive_receipt TO app_api;
