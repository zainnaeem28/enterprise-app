-- migration-class: expand
-- identity schema and the non-admin tables of ARCHITECTURE 22.4 (draft 8.2, ID-FREEZE; ticket BE-04, migrations 0500-0599).
-- DDL only (SBR-17): no row is inserted here. The permission catalogue, the roles and the default mapping of 27.3 are
-- reference data applied by the worker job identity.apply_reference_data. RLS, grants and triggers follow in 0501-0503.
--
-- Not created here (BE-05, migrations 2200-2299): elevation_grant, role_change_request, admin_credential,
-- webauthn_challenge, enrolment_token, person_link_request, directory_check. role_assignment.granted_via_request_id has
-- no foreign key for that reason (BE-05 adds it). patient_link.patient_id and proxy_grant.patient_id have no foreign key
-- because patient.patient does not exist yet (BE-08, BD-02: no cross-module reach before the owner exists).

CREATE SCHEMA identity;
COMMENT ON SCHEMA identity IS 'Identity: persons, principals, sessions, roles, permissions, staff profiles, patient links, proxy grants (ARCHITECTURE 22.4)';
REVOKE ALL ON SCHEMA identity FROM PUBLIC;
GRANT USAGE ON SCHEMA identity TO app_api, app_worker, identity_signin_ro, directory_ro, patient_scope_owner;

CREATE TABLE identity.person (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  display_name    text        NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200),
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz
);
COMMENT ON TABLE identity.person IS 'class=C1';

CREATE TABLE identity.principal (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  person_id        uuid        NOT NULL REFERENCES identity.person (id),
  realm            text        NOT NULL CHECK (realm IN ('patient_pool', 'google', 'admin_pool', 'partner_pool')),
  subject          text        CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 255),
  email            text        CHECK (email IS NULL OR (char_length(email) BETWEEN 3 AND 320 AND email = lower(email))),
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled')),
  disabled_reason  text        CHECK (disabled_reason IS NULL OR char_length(disabled_reason) <= 200),
  last_sign_in_at  timestamptz,
  preregistered_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  created_by_job   uuid,
  row_version      bigint      NOT NULL DEFAULT 1,
  updated_at       timestamptz,
  CONSTRAINT principal_realm_subject_uq UNIQUE (realm, subject),
  CONSTRAINT principal_person_realm_uq UNIQUE (person_id, realm),
  -- 26.1 (draft 6): only a google principal pre-registered by an admin has no sub until its first sign-in.
  CONSTRAINT principal_subject_or_preregistered CHECK (subject IS NOT NULL OR (realm = 'google' AND email IS NOT NULL))
);
CREATE UNIQUE INDEX principal_realm_unbound_email_uq ON identity.principal (realm, lower(email)) WHERE subject IS NULL;
COMMENT ON TABLE identity.principal IS 'class=C1; patient_pool rows: class=C2';

CREATE TABLE identity.session (
  id                   uuid        PRIMARY KEY,
  organisation_id      uuid        NOT NULL,
  token_hash           bytea       NOT NULL CHECK (octet_length(token_hash) = 32),
  principal_id         uuid        NOT NULL REFERENCES identity.principal (id),
  person_id            uuid        NOT NULL REFERENCES identity.person (id),
  realm                text        NOT NULL CHECK (realm IN ('patient_pool', 'google', 'admin_pool', 'partner_pool')),
  audience             text        NOT NULL CHECK (audience IN ('patient', 'staff', 'partner')),
  auth_time            timestamptz NOT NULL,
  amr                  text[]      NOT NULL DEFAULT '{}',
  csrf_hash            bytea       NOT NULL CHECK (octet_length(csrf_hash) = 32),
  idle_expires_at      timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  last_seen_at         timestamptz,
  last_interaction_at  timestamptz,
  revoked_at           timestamptz,
  revoke_reason        text        CHECK (revoke_reason IN ('sign_out', 'kill_switch', 'role_change', 'idle', 'absolute', 'realm_switch')),
  ip                   inet,
  user_agent           text        CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  created_by_job       uuid,
  row_version          bigint      NOT NULL DEFAULT 1,
  updated_at           timestamptz,
  CONSTRAINT session_token_hash_uq UNIQUE (token_hash),
  CONSTRAINT session_idle_within_absolute CHECK (idle_expires_at <= absolute_expires_at),
  CONSTRAINT session_audience_matches_realm CHECK (
       (realm = 'patient_pool' AND audience = 'patient')
    OR (realm IN ('google', 'admin_pool') AND audience = 'staff')
    OR (realm = 'partner_pool' AND audience = 'partner')),
  CONSTRAINT session_revocation_pair CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX session_principal_live_idx ON identity.session (principal_id) WHERE revoked_at IS NULL;
CREATE INDEX session_absolute_expires_idx ON identity.session (absolute_expires_at);
COMMENT ON TABLE identity.session IS 'class=C1; only the SHA-256 of the cookie token is stored';

CREATE TABLE identity.role (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  key             text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,60}$'),
  realm           text        NOT NULL CHECK (realm IN ('google', 'admin_pool')),
  privileged      boolean     NOT NULL,
  location_bound  boolean     NOT NULL,
  description     text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  CONSTRAINT role_org_key_uq UNIQUE (organisation_id, key),
  -- BD-05 rule 1: privileged roles live only in the admin realm.
  CONSTRAINT role_privileged_in_admin_realm CHECK (NOT privileged OR realm = 'admin_pool')
);
COMMENT ON TABLE identity.role IS 'class=C1; reference data';

CREATE TABLE identity.permission (
  organisation_id  uuid        NOT NULL,
  key              text        NOT NULL CHECK (key ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*){1,3}$'),
  module           text        NOT NULL CHECK (module ~ '^[a-z][a-z_-]*$'),
  privileged       boolean     NOT NULL,
  needs_elevation  boolean     NOT NULL,
  compliance_scope text        CHECK (compliance_scope IS NULL OR compliance_scope ~ '^[a-z_]{1,40}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  created_by_job   uuid,
  row_version      bigint      NOT NULL DEFAULT 1,
  updated_at       timestamptz,
  PRIMARY KEY (organisation_id, key)
);
COMMENT ON TABLE identity.permission IS 'class=C1; reference data (27.2)';

CREATE TABLE identity.role_permission (
  organisation_id uuid        NOT NULL,
  role_id         uuid        NOT NULL REFERENCES identity.role (id),
  permission_key  text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  PRIMARY KEY (role_id, permission_key),
  FOREIGN KEY (organisation_id, permission_key) REFERENCES identity.permission (organisation_id, key)
);
COMMENT ON TABLE identity.role_permission IS 'class=C1; reference data (27.3 default mapping, Proposal until G2)';

CREATE TABLE identity.role_assignment (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  principal_id            uuid        NOT NULL REFERENCES identity.principal (id),
  role_id                 uuid        NOT NULL REFERENCES identity.role (id),
  location_id             uuid        REFERENCES organisation.location (id),
  granted_via_request_id  uuid        NOT NULL,
  revoked_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  created_by_job          uuid,
  row_version             bigint      NOT NULL DEFAULT 1,
  updated_at              timestamptz
);
CREATE UNIQUE INDEX role_assignment_open_uq ON identity.role_assignment (principal_id, role_id, location_id) NULLS NOT DISTINCT WHERE revoked_at IS NULL;
CREATE INDEX role_assignment_principal_idx ON identity.role_assignment (principal_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE identity.role_assignment IS 'class=C1';

CREATE TABLE identity.staff_profile (
  principal_id          uuid        PRIMARY KEY REFERENCES identity.principal (id),
  organisation_id       uuid        NOT NULL,
  display_name          text        NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200),
  npi                   text        CHECK (npi ~ '^[0-9]{10}$'),
  dea_number            text        CHECK (dea_number IS NULL OR char_length(dea_number) <= 20),
  is_prescriber         boolean     NOT NULL DEFAULT false,
  is_trainee            boolean     NOT NULL DEFAULT false,
  supervisor_principal_id uuid      REFERENCES identity.principal (id),
  directory_listed      boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  created_by_job        uuid,
  row_version           bigint      NOT NULL DEFAULT 1,
  updated_at            timestamptz
);
COMMENT ON TABLE identity.staff_profile IS 'class=C1; display_name of a listed clinician: C0 through identity.public_clinician';

CREATE TABLE identity.licensed_state (
  principal_id      uuid        NOT NULL REFERENCES identity.principal (id),
  jurisdiction_code text        NOT NULL REFERENCES organisation.jurisdiction (code),
  organisation_id   uuid        NOT NULL,
  licence_number    text        CHECK (licence_number IS NULL OR char_length(licence_number) <= 60),
  expires_on        date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  created_by_job    uuid,
  row_version       bigint      NOT NULL DEFAULT 1,
  updated_at        timestamptz,
  PRIMARY KEY (principal_id, jurisdiction_code)
);
COMMENT ON TABLE identity.licensed_state IS 'class=C1';

CREATE TABLE identity.patient_link (
  principal_id    uuid        NOT NULL REFERENCES identity.principal (id),
  patient_id      uuid        NOT NULL,
  organisation_id uuid        NOT NULL,
  kind            text        NOT NULL CHECK (kind IN ('self')),
  linked_at       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  PRIMARY KEY (principal_id, patient_id)
);
CREATE INDEX patient_link_patient_idx ON identity.patient_link (patient_id);
COMMENT ON TABLE identity.patient_link IS 'class=C2; merge participant R (identity.repointPatient)';

CREATE TABLE identity.proxy_grant (
  id                       uuid        PRIMARY KEY,
  organisation_id          uuid        NOT NULL,
  proxy_principal_id       uuid        NOT NULL REFERENCES identity.principal (id),
  patient_id               uuid        NOT NULL,
  relationship             text        NOT NULL CHECK (relationship IN ('parent', 'guardian', 'carer', 'other')),
  scope                    text        NOT NULL DEFAULT 'appointments' CHECK (scope IN ('appointments')),
  patient_display_name     text        NOT NULL CHECK (char_length(btrim(patient_display_name)) BETWEEN 1 AND 100),
  status                   text        NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'verified', 'active', 'revoked', 'expired')),
  verified_by              uuid,
  verification_document_id uuid,
  valid_until              date,
  revoked_at               timestamptz,
  revoke_reason            text        CHECK (revoke_reason IN ('patient', 'staff', 'age_out', 'merged_duplicate')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  created_by_job           uuid,
  row_version              bigint      NOT NULL DEFAULT 1,
  updated_at               timestamptz,
  CONSTRAINT proxy_grant_revocation_shape CHECK (
       (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
    OR (status = 'expired' AND revoke_reason = 'age_out')
    OR (status IN ('requested', 'verified', 'active') AND revoked_at IS NULL AND revoke_reason IS NULL))
);
CREATE UNIQUE INDEX proxy_grant_open_uq ON identity.proxy_grant (proxy_principal_id, patient_id) WHERE status IN ('requested', 'verified', 'active');
CREATE INDEX proxy_grant_patient_idx ON identity.proxy_grant (patient_id);
CREATE INDEX proxy_grant_proxy_active_idx ON identity.proxy_grant (proxy_principal_id) WHERE status = 'active';
COMMENT ON TABLE identity.proxy_grant IS 'class=C2; merge participant R/K (identity.repointPatient); scope appointments only (D-7 default)';

CREATE TABLE identity.push_subscription (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  principal_id    uuid        NOT NULL REFERENCES identity.principal (id),
  endpoint        text        NOT NULL CHECK (char_length(endpoint) BETWEEN 8 AND 2048),
  p256dh          bytea       NOT NULL,
  auth            bytea       NOT NULL,
  user_agent      text        CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz
);
CREATE INDEX push_subscription_principal_idx ON identity.push_subscription (principal_id);
COMMENT ON TABLE identity.push_subscription IS 'class=C1';

CREATE TABLE identity.staff_support (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  assistant_principal_id  uuid        NOT NULL REFERENCES identity.principal (id),
  supported_principal_id  uuid        NOT NULL REFERENCES identity.principal (id),
  from_date               date        NOT NULL,
  to_date                 date,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  created_by_job          uuid,
  row_version             bigint      NOT NULL DEFAULT 1,
  updated_at              timestamptz,
  CONSTRAINT staff_support_distinct CHECK (assistant_principal_id <> supported_principal_id)
);
CREATE UNIQUE INDEX staff_support_open_uq ON identity.staff_support (assistant_principal_id, supported_principal_id) WHERE to_date IS NULL;
CREATE INDEX staff_support_assistant_idx ON identity.staff_support (assistant_principal_id) WHERE to_date IS NULL;
COMMENT ON TABLE identity.staff_support IS 'class=C1; Proposal with G-10 and BQ-10';
