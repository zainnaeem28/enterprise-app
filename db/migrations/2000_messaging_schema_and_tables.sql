-- migration-class: expand
-- messaging: threads, participants, messages, tasks (ARCHITECTURE 22.12, 22.16, 24; PRD RA-R1-25, F-DR-12, F-PP-09 (S);
-- ticket BE-19, migrations 2000-2099). DDL only (SBR-17). Triggers and the merge guard: 2001. Row-level security and grants: 2002.
--
-- Small, recorded departures from 22.12 (all additive; see the module README):
--   * every table also carries organisation_id (21.4); thread and task also created_at / created_by and row_version / updated_at;
--   * thread.created_by is NOT NULL (a thread is always created by a principal; the creator-sees-own-thread rule needs it);
--   * thread_participant.added_by / created_at: who added the row (audit trail of who made whom a participant);
--   * task.completed_at / completed_by, task.created_by_job (a system job creates `privacy_correction` tasks, SBR-04);
--   * a task has exactly the assignee columns its assignee_kind needs (CHECK);
--   * message.attachment_document_ids is capped at 10 entries (the thread view has no list that scales further).

CREATE SCHEMA messaging;
COMMENT ON SCHEMA messaging IS 'Threads, messages, tasks (ARCHITECTURE 22.12)';
REVOKE ALL ON SCHEMA messaging FROM PUBLIC;
GRANT USAGE ON SCHEMA messaging TO app_api, app_worker;
-- Needed only to move the merge write guard's ownership to the function-owner role (2001); withdrawn again there.
GRANT CREATE ON SCHEMA messaging TO patient_scope_owner;

CREATE TABLE messaging.thread (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  kind            text        NOT NULL CHECK (kind IN ('staff', 'patient')),
  patient_id      uuid        REFERENCES patient.patient (id),
  subject         text        NOT NULL CHECK (char_length(btrim(subject)) BETWEEN 1 AND 200),
  status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  location_id     uuid        REFERENCES organisation.location (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL REFERENCES identity.principal (id),
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  CONSTRAINT thread_patient_kind CHECK (kind <> 'patient' OR patient_id IS NOT NULL)
);
COMMENT ON TABLE messaging.thread IS 'class=C2; merge participant R/K (open R; closed K)';
CREATE INDEX thread_patient_idx ON messaging.thread (patient_id);

CREATE TABLE messaging.thread_participant (
  thread_id       uuid        NOT NULL REFERENCES messaging.thread (id),
  principal_id    uuid        NOT NULL REFERENCES identity.principal (id),
  organisation_id uuid        NOT NULL,
  role            text        NOT NULL CHECK (role IN ('member', 'owner')),
  last_read_at    timestamptz,
  added_by        uuid        NOT NULL REFERENCES identity.principal (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, principal_id)
);
COMMENT ON TABLE messaging.thread_participant IS 'class=C1; no patient column, not a merge participant';
CREATE INDEX thread_participant_principal_idx ON messaging.thread_participant (principal_id);

CREATE TABLE messaging.message (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  thread_id               uuid        NOT NULL REFERENCES messaging.thread (id),
  patient_id              uuid        REFERENCES patient.patient (id),
  author_principal_id     uuid        NOT NULL REFERENCES identity.principal (id),
  body                    text        NOT NULL CHECK (char_length(btrim(body)) >= 1 AND octet_length(body) <= 10240),
  attachment_document_ids uuid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(attachment_document_ids) <= 10),
  sent_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE messaging.message IS 'class=C2; merge participant K for every row (append-only)';
CREATE INDEX message_thread_sent_idx ON messaging.message (thread_id, sent_at);

CREATE TABLE messaging.task (
  id                    uuid        PRIMARY KEY,
  organisation_id       uuid        NOT NULL,
  patient_id            uuid        REFERENCES patient.patient (id),
  title                 text        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  detail                text        CHECK (detail IS NULL OR octet_length(detail) <= 5120),
  assignee_kind         text        NOT NULL CHECK (assignee_kind IN ('principal', 'role_location')),
  assignee_principal_id uuid        REFERENCES identity.principal (id),
  assignee_role_key     text        CHECK (assignee_role_key IS NULL OR assignee_role_key ~ '^[a-z][a-z0-9_]{0,60}$'),
  assignee_location_id  uuid        REFERENCES organisation.location (id),
  status                text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  due_at                timestamptz,
  source                text        NOT NULL DEFAULT 'manual'
                          CHECK (source IN ('manual', 'privacy_correction', 'no_show_follow_up', 'note_sign_deadline')),
  source_ref            uuid,
  completed_at          timestamptz,
  completed_by          uuid        REFERENCES identity.principal (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        REFERENCES identity.principal (id),
  created_by_job        uuid,
  row_version           bigint      NOT NULL DEFAULT 1,
  updated_at            timestamptz,
  CONSTRAINT task_assignee_shape CHECK (
    (assignee_kind = 'principal' AND assignee_principal_id IS NOT NULL AND assignee_role_key IS NULL AND assignee_location_id IS NULL)
 OR (assignee_kind = 'role_location' AND assignee_principal_id IS NULL AND assignee_role_key IS NOT NULL AND assignee_location_id IS NOT NULL)),
  CONSTRAINT task_creator CHECK (created_by IS NOT NULL OR created_by_job IS NOT NULL),
  CONSTRAINT task_done_shape CHECK ((status = 'open') = (completed_at IS NULL)),
  CONSTRAINT task_source_ref CHECK (source = 'manual' OR source_ref IS NOT NULL)
);
COMMENT ON TABLE messaging.task IS 'class=C2; merge participant R/K (open R; done and cancelled K)';
CREATE INDEX task_assignee_status_idx ON messaging.task (assignee_principal_id, status);
CREATE INDEX task_role_location_status_idx ON messaging.task (assignee_location_id, assignee_role_key, status);
CREATE INDEX task_patient_idx ON messaging.task (patient_id);
-- A correction request produces one task, however many times its event is delivered (at-least-once outbox, 21.8).
CREATE UNIQUE INDEX task_source_ref_uq ON messaging.task (source, source_ref) WHERE source <> 'manual';
