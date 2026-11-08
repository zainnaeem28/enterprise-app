-- migration-class: expand
-- privacy: requests, export packages, incident register (ARCHITECTURE 22.14, 22.16, 23.1 ST-06; SHARED-BOUNDARIES 6.7; PRD RA-R1-14;
-- ticket BE-20, migrations 1900-1999). DDL only (SBR-17). Triggers and the merge guard: 1901. Row-level security and grants: 1902.
--
-- Small, recorded departures from 22.14 (all additive; see the module README):
--   * every table also carries organisation_id (21.4), created_at / created_by, and row_version / updated_at where the row is mutable;
--   * request.verified_at, decided_at: when identity was verified and when the decision was taken (a deletion request stays
--     `blocked_d8` after its identity is verified, so the status alone cannot show it);
--   * request.legal_hold_documents / legal_hold_checked_at: the result of the legal-hold check on a deletion request (a system job
--     reads the holds; a patient session cannot);
--   * export_package.failure_code: the registry code of why an assembly failed (a code only, never a value);
--   * a request has at most one package that is not `failed` (partial unique index): a failed assembly may be started again;
--   * a deletion request can only be `blocked_d8` or `refused` (CHECK): nothing in this ticket can start or finish a deletion (D-8).

CREATE SCHEMA privacy;
COMMENT ON SCHEMA privacy IS 'Privacy requests, export packages, incident register (ARCHITECTURE 22.14)';
REVOKE ALL ON SCHEMA privacy FROM PUBLIC;
GRANT USAGE ON SCHEMA privacy TO app_api, app_worker;
-- Needed only to move the merge write guard's ownership to the function-owner role (1901); withdrawn again there.
GRANT CREATE ON SCHEMA privacy TO patient_scope_owner;

CREATE TABLE privacy.request (
  id                        uuid        PRIMARY KEY,
  organisation_id           uuid        NOT NULL,
  patient_id                uuid        NOT NULL REFERENCES patient.patient (id),
  kind                      text        NOT NULL CHECK (kind IN ('access', 'export', 'correction', 'deletion')),
  requested_by_principal_id uuid        NOT NULL REFERENCES identity.principal (id),
  channel                   text        NOT NULL CHECK (channel IN ('portal', 'staff')),
  detail                    text        CHECK (detail IS NULL OR char_length(detail) <= 5120),
  status                    text        NOT NULL DEFAULT 'received'
                              CHECK (status IN ('received', 'identity_verified', 'in_progress', 'fulfilled', 'refused', 'blocked_d8')),
  verification_method       text        CHECK (verification_method IS NULL OR char_length(btrim(verification_method)) BETWEEN 3 AND 100),
  verified_by_person_id     uuid        REFERENCES identity.person (id),
  verified_at               timestamptz,
  decided_by_person_id      uuid        REFERENCES identity.person (id),
  decided_at                timestamptz,
  decision_reason           text        CHECK (decision_reason IS NULL OR char_length(btrim(decision_reason)) BETWEEN 10 AND 2000),
  due_at                    timestamptz NOT NULL,
  legal_hold_documents      integer     CHECK (legal_hold_documents IS NULL OR legal_hold_documents >= 0),
  legal_hold_checked_at     timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  row_version               bigint      NOT NULL DEFAULT 1,
  updated_at                timestamptz,
  CONSTRAINT request_verified_shape CHECK (
    (verification_method IS NULL) = (verified_by_person_id IS NULL) AND (verified_by_person_id IS NULL) = (verified_at IS NULL)),
  CONSTRAINT request_decided_shape CHECK (
    (decided_by_person_id IS NULL) = (decided_at IS NULL)),
  CONSTRAINT request_hold_shape CHECK ((legal_hold_documents IS NULL) = (legal_hold_checked_at IS NULL)),
  CONSTRAINT request_status_shape CHECK (
    (status = 'received'          AND verified_at IS NULL     AND decided_at IS NULL)
 OR (status = 'identity_verified' AND verified_at IS NOT NULL AND decided_at IS NULL)
 OR (status = 'in_progress'       AND verified_at IS NOT NULL AND decided_at IS NOT NULL)
 OR (status = 'fulfilled'         AND verified_at IS NOT NULL AND decided_at IS NOT NULL)
 OR (status = 'refused'           AND decided_at IS NOT NULL  AND decision_reason IS NOT NULL)
 OR (status = 'blocked_d8'        AND kind = 'deletion' AND decided_at IS NULL)),
  -- D-8: what deletion means is undecided, so nothing here may start or finish one.
  CONSTRAINT request_deletion_blocked CHECK (kind <> 'deletion' OR status IN ('blocked_d8', 'refused')),
  CONSTRAINT request_blocked_only_deletion CHECK (status <> 'blocked_d8' OR kind = 'deletion')
);
COMMENT ON TABLE privacy.request IS 'class=C2; merge participant R/K (received, identity_verified, in_progress, blocked_d8 R; fulfilled, refused K)';
CREATE INDEX request_status_due_idx ON privacy.request (status, due_at);
CREATE INDEX request_patient_idx ON privacy.request (patient_id);

CREATE TABLE privacy.export_package (
  id                        uuid        PRIMARY KEY,
  organisation_id           uuid        NOT NULL,
  request_id                uuid        NOT NULL REFERENCES privacy.request (id),
  patient_id                uuid        NOT NULL REFERENCES patient.patient (id),
  status                    text        NOT NULL DEFAULT 'assembling' CHECK (status IN ('assembling', 'ready', 'failed', 'released', 'expired')),
  -- Random, no PHI, no name (the same rule as the documents store).
  object_key                text        CHECK (object_key IS NULL OR object_key ~ '^p/[0-9a-f]{32}$'),
  size_bytes                bigint      CHECK (size_bytes IS NULL OR size_bytes > 0),
  part_counts               jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(part_counts) = 'object' AND pg_column_size(part_counts) <= 16384),
  expires_at                timestamptz,
  released_at               timestamptz,
  failure_code              text        CHECK (failure_code IS NULL OR failure_code ~ '^[a-z_]+\.[a-z_]+$'),
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  row_version               bigint      NOT NULL DEFAULT 1,
  updated_at                timestamptz,
  CONSTRAINT export_package_shape CHECK (
    (status = 'assembling' AND object_key IS NULL AND released_at IS NULL)
 OR (status = 'ready'      AND object_key IS NOT NULL AND size_bytes IS NOT NULL AND expires_at IS NOT NULL AND released_at IS NULL)
 OR (status = 'released'   AND object_key IS NOT NULL AND size_bytes IS NOT NULL AND expires_at IS NOT NULL AND released_at IS NOT NULL)
 OR (status = 'failed'     AND failure_code IS NOT NULL AND object_key IS NULL)
 OR (status = 'expired')),
  CONSTRAINT export_package_failure_shape CHECK ((status = 'failed') = (failure_code IS NOT NULL))
);
COMMENT ON TABLE privacy.export_package IS 'class=C2; merge participant R/K (assembling, ready, released R; failed, expired K); metadata only, the content is in the object store';
CREATE UNIQUE INDEX export_package_one_live_idx ON privacy.export_package (request_id) WHERE status <> 'failed';
CREATE INDEX export_package_expiry_idx ON privacy.export_package (expires_at) WHERE status IN ('ready', 'released');
CREATE INDEX export_package_patient_idx ON privacy.export_package (patient_id);

CREATE TABLE privacy.incident (
  id                        uuid        PRIMARY KEY,
  organisation_id           uuid        NOT NULL,
  title                     text        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description               text        NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 10240),
  severity                  text        NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status                    text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'notified', 'closed')),
  discovered_at             timestamptz NOT NULL,
  notification_deadline     timestamptz,
  closed_at                 timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  row_version               bigint      NOT NULL DEFAULT 1,
  updated_at                timestamptz,
  CONSTRAINT incident_closed_shape CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CONSTRAINT incident_deadline_after_discovery CHECK (notification_deadline IS NULL OR notification_deadline >= discovered_at)
);
COMMENT ON TABLE privacy.incident IS 'class=C2; no patient_id: the patients an incident touches are in incident_patient';
CREATE INDEX incident_status_idx ON privacy.incident (status, discovered_at);

CREATE TABLE privacy.incident_patient (
  incident_id               uuid        NOT NULL REFERENCES privacy.incident (id),
  patient_id                uuid        NOT NULL REFERENCES patient.patient (id),
  organisation_id           uuid        NOT NULL,
  audit_event_ids           uuid[]      NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(audit_event_ids) <= 1000),
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  PRIMARY KEY (incident_id, patient_id)
);
COMMENT ON TABLE privacy.incident_patient IS 'class=C2; exempt from the merge guard: it records history (22.14, 22.16). Events are only ever added';
CREATE INDEX incident_patient_patient_idx ON privacy.incident_patient (patient_id);
