-- migration-class: expand
-- Availability tables of the scheduling schema (ARCHITECTURE 22.8; ticket BE-12, migrations 1100-1199). DDL only (SBR-17).
-- Triggers: 1101. Row-level security and grants: 1102. Directory view: 1103.
--
-- availability_template + template_rule: a doctor's weekly pattern in the LOCAL time of the template's location (weekday 0-6 with 0 =
-- Sunday, the extract(dow) numbering). blocked_time: leave, blocked and admin time as absolute instants. busy_block: Google busy time,
-- written only by the calendar-sync module (BE-14). roster_entry: who is on duty or on call at a location.
-- Small, recorded additions to 22.8: template_rule has an `id` (a rule is addressed when a template is replaced), and the audit
-- columns of 21.1 are present on every table.

CREATE TABLE scheduling.availability_template (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  clinician_principal_id  uuid        NOT NULL REFERENCES identity.principal (id),
  location_id             uuid        NOT NULL REFERENCES organisation.location (id),
  valid_from              date        NOT NULL,
  valid_to                date,
  status                  text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  created_by_job          uuid,
  row_version             bigint      NOT NULL DEFAULT 1,
  updated_at              timestamptz,
  CONSTRAINT availability_template_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from),
  -- the target of the rule's foreign key: the copied clinician cannot differ from the template's
  CONSTRAINT availability_template_id_clinician_uq UNIQUE (id, clinician_principal_id)
);
COMMENT ON TABLE scheduling.availability_template IS 'class=C1';
CREATE INDEX availability_template_clinician_idx ON scheduling.availability_template (clinician_principal_id);
CREATE INDEX availability_template_active_idx ON scheduling.availability_template (location_id, clinician_principal_id) WHERE status = 'active';

CREATE TABLE scheduling.template_rule (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  template_id             uuid        NOT NULL,
  clinician_principal_id  uuid        NOT NULL,
  weekday                 smallint    NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_local             time        NOT NULL,
  end_local               time        NOT NULL,
  service_ids             uuid[]      CHECK (service_ids IS NULL OR cardinality(service_ids) BETWEEN 1 AND 100),
  mode                    text        NOT NULL CHECK (mode IN ('in_person', 'video', 'either')),
  room_id                 uuid        REFERENCES organisation.room (id),
  overbookable            boolean     NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  created_by_job          uuid,
  row_version             bigint      NOT NULL DEFAULT 1,
  updated_at              timestamptz,
  CONSTRAINT template_rule_start_before_end CHECK (start_local < end_local),
  CONSTRAINT template_rule_template_fk FOREIGN KEY (template_id, clinician_principal_id)
    REFERENCES scheduling.availability_template (id, clinician_principal_id)
);
COMMENT ON TABLE scheduling.template_rule IS 'class=C1';
CREATE INDEX template_rule_template_idx ON scheduling.template_rule (template_id);
CREATE INDEX template_rule_clinician_weekday_idx ON scheduling.template_rule (clinician_principal_id, weekday);

CREATE TABLE scheduling.blocked_time (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  clinician_principal_id  uuid        NOT NULL REFERENCES identity.principal (id),
  period                  tstzrange   NOT NULL,
  kind                    text        NOT NULL CHECK (kind IN ('leave', 'blocked', 'admin')),
  note                    text        CHECK (note IS NULL OR char_length(note) <= 200),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  created_by_job          uuid,
  row_version             bigint      NOT NULL DEFAULT 1,
  updated_at              timestamptz,
  CONSTRAINT blocked_time_period_shape CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
                                              AND NOT lower_inf(period) AND NOT upper_inf(period))
);
COMMENT ON TABLE scheduling.blocked_time IS 'class=C1; note: no patient data';
CREATE INDEX blocked_time_clinician_period_idx ON scheduling.blocked_time USING gist (clinician_principal_id, period);

CREATE TABLE scheduling.busy_block (
  organisation_id         uuid        NOT NULL,
  clinician_principal_id  uuid        NOT NULL REFERENCES identity.principal (id),
  period                  tstzrange   NOT NULL,
  source                  text        NOT NULL CHECK (source IN ('google')),
  external_hash           bytea       NOT NULL CHECK (octet_length(external_hash) BETWEEN 16 AND 64),
  synced_at               timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by_job          uuid,
  PRIMARY KEY (clinician_principal_id, external_hash),
  CONSTRAINT busy_block_period_shape CHECK (NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period))
);
COMMENT ON TABLE scheduling.busy_block IS 'class=C1; hash of the Google event ID, no title; written by calendar-sync (BE-14) only';
CREATE INDEX busy_block_clinician_period_idx ON scheduling.busy_block USING gist (clinician_principal_id, period);

CREATE TABLE scheduling.roster_entry (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  location_id             uuid        NOT NULL REFERENCES organisation.location (id),
  duty                    text        NOT NULL CHECK (duty IN ('on_duty_doctor', 'on_call_doctor', 'compliance_on_call')),
  principal_id            uuid        NOT NULL REFERENCES identity.principal (id),
  period                  tstzrange   NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  created_by_job          uuid,
  row_version             bigint      NOT NULL DEFAULT 1,
  updated_at              timestamptz,
  CONSTRAINT roster_entry_period_shape CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
                                              AND NOT lower_inf(period) AND NOT upper_inf(period)),
  -- one holder per duty, place and time
  CONSTRAINT roster_entry_no_overlap EXCLUDE USING gist (location_id WITH =, duty WITH =, period WITH &&)
);
COMMENT ON TABLE scheduling.roster_entry IS 'class=C1';
CREATE INDEX roster_entry_principal_idx ON scheduling.roster_entry (principal_id);
