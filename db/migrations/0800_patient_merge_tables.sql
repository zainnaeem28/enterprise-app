-- migration-class: expand
-- Patient merge tables (ARCHITECTURE 22.6, 22.16, 25.4; SHARED-BOUNDARIES 9.2; ticket BE-09, migrations 0800-0899). DDL only
-- (SBR-17). Triggers: 0801. Row-level security and grants: 0802. Functions: 0803.
--
-- merge_request carries the request, its second-person approval (BQ-3 default) and the execution outcome. merge_residue
-- keeps the content of every row a conflict rule deleted, for the unmerge procedure of BQ-6 (which is not built in R1: `merged`
-- is terminal). The merge map patient_merge was created in 0700 with no writer; complete_merge (0803) is its only writer.
--
-- Small, recorded departures from 22.6 (all additive):
--   * merge_request carries organisation_id (every template requires the organisation predicate, 21.4), requester_principal_id
--     and approver_principal_id next to the person ids (the function compares both, so one person with two principals cannot
--     approve their own request), and row_version / updated_at (21.5);
--   * merge_residue.patient_id is named survivor_id (see the column);
--   * reason is at most 500 characters, as the OpenAPI contract says (22.6 says 1000);
--   * job_id is text (the queue's job identifier), set when the job starts.

CREATE TABLE patient.merge_request (
  id                    uuid        PRIMARY KEY,
  organisation_id       uuid        NOT NULL,
  survivor_id           uuid        NOT NULL REFERENCES patient.patient (id),
  merged_id             uuid        NOT NULL REFERENCES patient.patient (id),
  requester_person_id   uuid        NOT NULL,
  requester_principal_id uuid       NOT NULL,
  reason                text        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  status                text        NOT NULL DEFAULT 'requested'
                          CHECK (status IN ('requested', 'approved', 'rejected', 'executing', 'completed', 'failed', 'cancelled')),
  approver_person_id    uuid,
  approver_principal_id uuid,
  decided_at            timestamptz,
  job_id                text        CHECK (job_id IS NULL OR char_length(job_id) <= 200),
  failure_code          text        CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  counts                jsonb       CHECK (counts IS NULL OR (jsonb_typeof(counts) = 'object' AND pg_column_size(counts) <= 65536)),
  created_at            timestamptz NOT NULL DEFAULT now(),
  row_version           bigint      NOT NULL DEFAULT 1,
  updated_at            timestamptz,
  CONSTRAINT merge_request_distinct CHECK (survivor_id <> merged_id),
  -- BQ-3 default: a second staff member approves. Compared on the person and on the principal.
  CONSTRAINT merge_request_second_approver CHECK (
    approver_person_id IS DISTINCT FROM requester_person_id AND approver_principal_id IS DISTINCT FROM requester_principal_id),
  CONSTRAINT merge_request_decision_shape CHECK (
    (status IN ('requested', 'cancelled', 'failed') AND (status <> 'requested' OR (approver_person_id IS NULL AND decided_at IS NULL)))
    OR (status IN ('approved', 'rejected', 'executing', 'completed') AND approver_person_id IS NOT NULL
        AND approver_principal_id IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT merge_request_outcome_shape CHECK (
    (status IN ('failed', 'cancelled')) = (failure_code IS NOT NULL)
    AND (status = 'completed') = (counts IS NOT NULL))
);
COMMENT ON TABLE patient.merge_request IS 'class=C2; exempt from the merge guard (references both patients by design); completed, rejected, failed and cancelled are terminal';
-- One open request per merged patient (a second request for the same duplicate is patient.merge_pending).
CREATE UNIQUE INDEX merge_request_open_uq ON patient.merge_request (merged_id) WHERE status IN ('requested', 'approved', 'executing');
CREATE INDEX merge_request_survivor_idx ON patient.merge_request (survivor_id);
CREATE INDEX merge_request_status_idx ON patient.merge_request (status, created_at);

-- No foreign key from patient_merge.merge_request_id: complete_merge (0803) is the only writer and reads the locked request row, and
-- the BE-08 tests (outside this ticket's paths) insert merge-map rows with synthetic request IDs.

CREATE TABLE patient.merge_residue (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  merge_request_id uuid        NOT NULL REFERENCES patient.merge_request (id),
  -- The survivor's ID at merge time (22.6 calls the column patient_id). It is named survivor_id here: the row is append-only and
  -- is written once, by complete_merge, while the survivor is locked and active, so the write guard of 0701 (which attaches to
  -- tables with a patient_id column and cannot be attached by a later migration, because the guard function belongs to
  -- patient_scope_owner) has nothing to add. Like merge_request, the table references both patients by design.
  survivor_id      uuid        NOT NULL REFERENCES patient.patient (id),
  merged_id        uuid        NOT NULL REFERENCES patient.patient (id),
  source_table     text        NOT NULL CHECK (source_table ~ '^[a-z][a-z_0-9]*\.[a-z][a-z_0-9]*$'),
  rule             text        NOT NULL CHECK (char_length(rule) BETWEEN 1 AND 2000),
  source_row       jsonb       NOT NULL CHECK (jsonb_typeof(source_row) = 'object' AND pg_column_size(source_row) <= 65536),
  created_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE patient.merge_residue IS 'class=C2; merge participant K (append-only: every row is kept and never touched)';
CREATE INDEX merge_residue_request_idx ON patient.merge_residue (merge_request_id);
CREATE INDEX merge_residue_survivor_idx ON patient.merge_residue (survivor_id);
