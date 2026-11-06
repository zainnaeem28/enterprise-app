-- migration-class: expand
-- organisation schema and its sixteen tables (ARCHITECTURE 22.5; ticket BE-03, migrations 0300-0399). Column conventions of 21.1.
-- DDL only (SBR-17): no row is inserted here. Settings defaults and the jurisdiction list are reference data applied by a
-- worker job (module organisation, settings-defaults.json). RLS, grants and the directory views follow in 0301 and 0302.

CREATE SCHEMA organisation;
COMMENT ON SCHEMA organisation IS 'Organisation configuration: locations, rooms, hours, services, booking policy, templates, flags, banners (ARCHITECTURE 22.5)';
REVOKE ALL ON SCHEMA organisation FROM PUBLIC;
GRANT USAGE ON SCHEMA organisation TO app_api, app_worker;

-- IANA zone name check for location.time_zone and organisation.default_time_zone. Invoker rights, pg_catalog only.
CREATE FUNCTION organisation.is_iana_time_zone(tz text) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT tz IS NOT NULL AND (tz = 'UTC' OR tz ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$')
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names n WHERE n.name = tz) $$;
REVOKE ALL ON FUNCTION organisation.is_iana_time_zone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION organisation.is_iana_time_zone(text) TO app_api, app_worker;

-- Published and retired template versions are immutable (22.5): a published version may only become retired.
CREATE FUNCTION organisation.guard_template_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'a % template version cannot be deleted', OLD.status USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'a retired template version is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'published' THEN
    IF NEW.status = 'retired' THEN
      -- only the status (and the generic version columns) may change
      IF to_jsonb(NEW) - ARRAY['status', 'row_version', 'updated_at']
         IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status', 'row_version', 'updated_at'] THEN
        RAISE EXCEPTION 'a published template version may only be retired, not edited' USING ERRCODE = '42501';
      END IF;
    ELSIF to_jsonb(NEW) - ARRAY['row_version', 'updated_at'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['row_version', 'updated_at'] THEN
      RAISE EXCEPTION 'a published template version is immutable' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION organisation.guard_template_version() FROM PUBLIC;

CREATE TABLE organisation.organisation (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL,
  name              text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  default_time_zone text        NOT NULL CHECK (organisation.is_iana_time_zone(default_time_zone)),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  created_by_job    uuid,
  row_version       bigint      NOT NULL DEFAULT 1,
  updated_at        timestamptz,
  CONSTRAINT organisation_is_its_own_scope CHECK (organisation_id = id)
);
COMMENT ON TABLE organisation.organisation IS 'class=C0';

CREATE TABLE organisation.jurisdiction (
  code            text        PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  organisation_id uuid        NOT NULL,
  name            text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz
);
COMMENT ON TABLE organisation.jurisdiction IS 'class=C0; reference data (USPS two-letter codes)';

CREATE TABLE organisation.location (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  name            text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  kind            text        NOT NULL CHECK (kind IN ('clinic', 'virtual')),
  time_zone       text        NOT NULL CHECK (organisation.is_iana_time_zone(time_zone)),
  address         jsonb,
  state_code      text        NOT NULL REFERENCES organisation.jurisdiction (code),
  geo             point,
  phone           text        CHECK (char_length(phone) <= 40),
  active          boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz
);
CREATE INDEX location_organisation_active_idx ON organisation.location (organisation_id) WHERE active;
COMMENT ON TABLE organisation.location IS 'class=C0';

CREATE TABLE organisation.room (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  location_id     uuid        NOT NULL REFERENCES organisation.location (id),
  name            text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  active          boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  CONSTRAINT room_location_name_uq UNIQUE (location_id, name)
);
COMMENT ON TABLE organisation.room IS 'class=C1';

-- Local time of the location. Several intervals per weekday are allowed (lunch break); the same opening time twice is not.
CREATE TABLE organisation.opening_hours (
  organisation_id uuid        NOT NULL,
  location_id     uuid        NOT NULL REFERENCES organisation.location (id),
  weekday         smallint    NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens           time        NOT NULL,
  closes          time        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  PRIMARY KEY (location_id, weekday, opens),
  CONSTRAINT opening_hours_opens_before_closes CHECK (opens < closes)
);
COMMENT ON TABLE organisation.opening_hours IS 'class=C0';

CREATE TABLE organisation.holiday (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  location_id     uuid        REFERENCES organisation.location (id),
  date            date        NOT NULL,
  name            text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  CONSTRAINT holiday_location_date_uq UNIQUE NULLS NOT DISTINCT (location_id, date)
);
COMMENT ON TABLE organisation.holiday IS 'class=C0; location_id null = all locations';

-- patient_display_name is C0 (the neutral name, BR-23 extension); the rest of the row is C1. A condition-revealing service
-- must show patients a name other than its internal one. Prices and fees are stored, never charged in R1 (D-3).
CREATE TABLE organisation.service (
  id                    uuid        PRIMARY KEY,
  organisation_id       uuid        NOT NULL,
  internal_name         text        NOT NULL CHECK (char_length(btrim(internal_name)) BETWEEN 1 AND 200),
  patient_display_name  text        NOT NULL CHECK (char_length(btrim(patient_display_name)) BETWEEN 1 AND 200),
  duration_min          integer     NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  buffer_min            integer     NOT NULL CHECK (buffer_min BETWEEN 0 AND 120),
  mode                  text        NOT NULL CHECK (mode IN ('in_person', 'video', 'either')),
  price_cents           bigint      CHECK (price_cents >= 0),
  currency              char(3)     CHECK (currency ~ '^[A-Z]{3}$'),
  fee_cents             bigint      CHECK (fee_cents >= 0),
  condition_revealing   boolean     NOT NULL DEFAULT false,
  active                boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  created_by_job        uuid,
  row_version           bigint      NOT NULL DEFAULT 1,
  updated_at            timestamptz,
  CONSTRAINT service_money_needs_currency CHECK ((price_cents IS NULL AND fee_cents IS NULL) OR currency IS NOT NULL),
  CONSTRAINT service_neutral_display_name CHECK (
    NOT condition_revealing
    OR lower(btrim(patient_display_name)) <> lower(btrim(internal_name)))
);
CREATE INDEX service_organisation_active_idx ON organisation.service (organisation_id) WHERE active;
COMMENT ON TABLE organisation.service IS 'class=C1';
COMMENT ON COLUMN organisation.service.patient_display_name IS 'class=C0';

CREATE TABLE organisation.service_location (
  organisation_id uuid        NOT NULL,
  service_id      uuid        NOT NULL REFERENCES organisation.service (id),
  location_id     uuid        NOT NULL REFERENCES organisation.location (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  PRIMARY KEY (service_id, location_id)
);
CREATE INDEX service_location_location_idx ON organisation.service_location (location_id);
COMMENT ON TABLE organisation.service_location IS 'class=C1';

-- clinician_principal_id references identity.principal, which belongs to another module (BD-02): no foreign key.
CREATE TABLE organisation.service_clinician (
  organisation_id        uuid        NOT NULL,
  service_id             uuid        NOT NULL REFERENCES organisation.service (id),
  clinician_principal_id uuid        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  created_by_job         uuid,
  row_version            bigint      NOT NULL DEFAULT 1,
  updated_at             timestamptz,
  PRIMARY KEY (service_id, clinician_principal_id)
);
CREATE INDEX service_clinician_clinician_idx ON organisation.service_clinician (clinician_principal_id);
COMMENT ON TABLE organisation.service_clinician IS 'class=C1';

-- Block-only by default (D-3): late_change 'fee' is stored, nothing is ever charged in R1.
-- cutoff_hours and max_future_per_patient are NOT NULL with no database default: the service fills them from the settings
-- (31.4), so no G2 value is written in the schema. hold_minutes and no_show_grace_min are overrides: null = use the setting.
CREATE TABLE organisation.booking_policy (
  id                        uuid        PRIMARY KEY,
  organisation_id           uuid        NOT NULL,
  service_id                uuid        NOT NULL REFERENCES organisation.service (id),
  location_id               uuid        REFERENCES organisation.location (id),
  lead_time_min             integer     NOT NULL DEFAULT 0 CHECK (lead_time_min >= 0),
  cutoff_hours              integer     NOT NULL CHECK (cutoff_hours >= 0),
  late_change               text        NOT NULL DEFAULT 'block' CHECK (late_change IN ('block', 'fee')),
  max_future_per_patient    integer     NOT NULL CHECK (max_future_per_patient >= 1),
  waitlist_enabled          boolean     NOT NULL DEFAULT false,
  overbook_cap_per_session  integer     NOT NULL DEFAULT 0 CHECK (overbook_cap_per_session >= 0),
  hold_minutes              integer     CHECK (hold_minutes BETWEEN 1 AND 120),
  no_show_grace_min         integer     CHECK (no_show_grace_min BETWEEN 0 AND 240),
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  created_by_job            uuid,
  row_version               bigint      NOT NULL DEFAULT 1,
  updated_at                timestamptz,
  CONSTRAINT booking_policy_service_location_uq UNIQUE NULLS NOT DISTINCT (service_id, location_id)
);
COMMENT ON TABLE organisation.booking_policy IS 'class=C1';

CREATE TABLE organisation.consent_template (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  key              text        NOT NULL CHECK (char_length(key) BETWEEN 1 AND 100),
  version          integer     NOT NULL CHECK (version >= 1),
  language         text        NOT NULL CHECK (char_length(language) BETWEEN 2 AND 35),
  body_document_id uuid        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  created_by_job   uuid,
  row_version      bigint      NOT NULL DEFAULT 1,
  updated_at       timestamptz,
  CONSTRAINT consent_template_key_version_language_uq UNIQUE (key, version, language)
);
COMMENT ON TABLE organisation.consent_template IS 'class=C1';

-- The red-flag rules in schema are a safety rule (BR-10): a published version that carries any needs the D-12a
-- reviewer's sign-off recorded in approved_by_note. The rules live under the schema key red_flag_rules.
CREATE TABLE organisation.questionnaire_template (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  key              text        NOT NULL CHECK (char_length(key) BETWEEN 1 AND 100),
  version          integer     NOT NULL CHECK (version >= 1),
  schema           jsonb       NOT NULL CHECK (jsonb_typeof(schema) = 'object'),
  status           text        NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  approved_by_note text        CHECK (char_length(approved_by_note) <= 1000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  created_by_job   uuid,
  row_version      bigint      NOT NULL DEFAULT 1,
  updated_at       timestamptz,
  CONSTRAINT questionnaire_template_key_version_uq UNIQUE (key, version),
  CONSTRAINT questionnaire_red_flag_signoff CHECK (
    status = 'draft'
    OR NOT (jsonb_typeof(schema -> 'red_flag_rules') = 'array' AND jsonb_array_length(schema -> 'red_flag_rules') > 0)
    OR char_length(btrim(coalesce(approved_by_note, ''))) > 0)
);
COMMENT ON TABLE organisation.questionnaire_template IS 'class=C1';

-- consent_template_key names a key, not a version: the required consent is always the latest published version.
CREATE TABLE organisation.service_required_consent (
  organisation_id      uuid        NOT NULL,
  service_id           uuid        NOT NULL REFERENCES organisation.service (id),
  consent_template_key text        NOT NULL CHECK (char_length(consent_template_key) BETWEEN 1 AND 100),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  created_by_job       uuid,
  row_version          bigint      NOT NULL DEFAULT 1,
  updated_at           timestamptz,
  PRIMARY KEY (service_id, consent_template_key)
);
COMMENT ON TABLE organisation.service_required_consent IS 'class=C1';

CREATE TABLE organisation.feature_flag (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  key             text        NOT NULL CHECK (char_length(key) BETWEEN 1 AND 100),
  location_id     uuid        REFERENCES organisation.location (id),
  enabled         boolean     NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  CONSTRAINT feature_flag_key_location_uq UNIQUE NULLS NOT DISTINCT (key, location_id)
);
COMMENT ON TABLE organisation.feature_flag IS 'class=C1';

CREATE TABLE organisation.banner (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  surface         text        NOT NULL CHECK (surface IN ('site', 'patient', 'staff', 'partner')),
  message         text        NOT NULL CHECK (char_length(btrim(message)) BETWEEN 1 AND 500),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  CONSTRAINT banner_starts_before_ends CHECK (starts_at < ends_at)
);
COMMENT ON TABLE organisation.banner IS 'class=C0; no PHI (TC-AD-09)';

-- Empty until D-2 is answered: licensingCheck then refuses every video booking (fails closed).
CREATE TABLE organisation.operating_state (
  organisation_id   uuid        NOT NULL,
  jurisdiction_code text        NOT NULL REFERENCES organisation.jurisdiction (code),
  telehealth_allowed boolean    NOT NULL,
  effective_from    date        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  created_by_job    uuid,
  row_version       bigint      NOT NULL DEFAULT 1,
  updated_at        timestamptz,
  PRIMARY KEY (jurisdiction_code, effective_from)
);
COMMENT ON TABLE organisation.operating_state IS 'class=C1';

CREATE TRIGGER consent_template_guard_version BEFORE UPDATE OR DELETE ON organisation.consent_template
  FOR EACH ROW EXECUTE FUNCTION organisation.guard_template_version();
CREATE TRIGGER questionnaire_template_guard_version BEFORE UPDATE OR DELETE ON organisation.questionnaire_template
  FOR EACH ROW EXECUTE FUNCTION organisation.guard_template_version();

CREATE TRIGGER organisation_bump_row_version BEFORE UPDATE ON organisation.organisation
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER jurisdiction_bump_row_version BEFORE UPDATE ON organisation.jurisdiction
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER location_bump_row_version BEFORE UPDATE ON organisation.location
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER room_bump_row_version BEFORE UPDATE ON organisation.room
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER opening_hours_bump_row_version BEFORE UPDATE ON organisation.opening_hours
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER holiday_bump_row_version BEFORE UPDATE ON organisation.holiday
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER service_bump_row_version BEFORE UPDATE ON organisation.service
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER service_location_bump_row_version BEFORE UPDATE ON organisation.service_location
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER service_clinician_bump_row_version BEFORE UPDATE ON organisation.service_clinician
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER booking_policy_bump_row_version BEFORE UPDATE ON organisation.booking_policy
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER consent_template_bump_row_version BEFORE UPDATE ON organisation.consent_template
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER questionnaire_template_bump_row_version BEFORE UPDATE ON organisation.questionnaire_template
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER service_required_consent_bump_row_version BEFORE UPDATE ON organisation.service_required_consent
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER feature_flag_bump_row_version BEFORE UPDATE ON organisation.feature_flag
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER banner_bump_row_version BEFORE UPDATE ON organisation.banner
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER operating_state_bump_row_version BEFORE UPDATE ON organisation.operating_state
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
