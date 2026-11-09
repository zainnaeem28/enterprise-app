-- migration-class: expand
-- Admin-realm tables of ARCHITECTURE 22.4 (draft 8.2, ID-FREEZE, variant B2; ticket BE-05, migrations 2200-2299):
-- role_change_request, enrolment_token, admin_credential, webauthn_challenge, elevation_grant, and the foreign key that
-- BE-04 left open (role_assignment.granted_via_request_id). DDL only (SBR-17). Triggers follow in 2201, RLS and grants in 2202.
--
-- Not created here, on purpose: person_link_request and directory_check (26.3 person link; the C2/C3 hourly directory
-- reconciliation). Neither is part of the BE-05 acceptance list; they need the Directory API crossing and are ticketed
-- separately (see the BE-05 limitations).

CREATE TABLE identity.role_change_request (
  id                   uuid        PRIMARY KEY,
  organisation_id      uuid        NOT NULL,
  requester_person_id  uuid        NOT NULL REFERENCES identity.person (id),
  subject_principal_id uuid        NOT NULL REFERENCES identity.principal (id),
  change               jsonb       NOT NULL CHECK (jsonb_typeof(change) = 'object'),
  before               jsonb       NOT NULL CHECK (jsonb_typeof(before) = 'array'),
  request_hash         bytea       NOT NULL CHECK (octet_length(request_hash) = 32),
  status               text        NOT NULL DEFAULT 'requested'
                         CHECK (status IN ('requested', 'approved', 'applied', 'rejected', 'expired', 'cancelled')),
  approver_person_id   uuid        REFERENCES identity.person (id),
  decided_at           timestamptz,
  expires_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  created_by_job       uuid,
  row_version          bigint      NOT NULL DEFAULT 1,
  updated_at           timestamptz,
  -- C4: nobody approves their own request.
  CONSTRAINT role_change_request_approver_not_requester CHECK (approver_person_id IS NULL OR approver_person_id <> requester_person_id),
  -- A decision names its approver and its time.
  CONSTRAINT role_change_request_decision_named CHECK (
    status NOT IN ('approved', 'applied', 'rejected') OR (approver_person_id IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX role_change_request_status_expiry_idx ON identity.role_change_request (status, expires_at);
CREATE INDEX role_change_request_subject_idx ON identity.role_change_request (subject_principal_id);
COMMENT ON TABLE identity.role_change_request IS 'class=C1';

ALTER TABLE identity.role_assignment
  ADD CONSTRAINT role_assignment_granted_via_request_fk
  FOREIGN KEY (granted_via_request_id) REFERENCES identity.role_change_request (id) NOT VALID;

CREATE TABLE identity.enrolment_token (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  principal_id            uuid        NOT NULL REFERENCES identity.principal (id),
  -- Null until the approver approves: the plain token (256 random bits) exists only in that one response (26.3).
  token_hash              bytea       CHECK (token_hash IS NULL OR octet_length(token_hash) = 32),
  requested_by_person_id  uuid        NOT NULL REFERENCES identity.person (id),
  approved_by_person_id   uuid        REFERENCES identity.person (id),
  expires_at              timestamptz NOT NULL,
  used_at                 timestamptz,
  status                  text        NOT NULL DEFAULT 'requested'
                            CHECK (status IN ('requested', 'approved', 'used', 'expired', 'cancelled')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  created_by_job          uuid,
  row_version             bigint      NOT NULL DEFAULT 1,
  updated_at              timestamptz,
  CONSTRAINT enrolment_token_approver_not_requester CHECK (approved_by_person_id IS NULL OR approved_by_person_id <> requested_by_person_id),
  CONSTRAINT enrolment_token_hash_when_approved CHECK (status NOT IN ('approved', 'used') OR (token_hash IS NOT NULL AND approved_by_person_id IS NOT NULL)),
  CONSTRAINT enrolment_token_used_pair CHECK ((status = 'used') = (used_at IS NOT NULL))
);
CREATE UNIQUE INDEX enrolment_token_hash_uq ON identity.enrolment_token (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX enrolment_token_principal_idx ON identity.enrolment_token (principal_id);
COMMENT ON TABLE identity.enrolment_token IS 'class=C1; only the SHA-256 of the token is stored';

CREATE TABLE identity.admin_credential (
  id                     bytea       PRIMARY KEY CHECK (octet_length(id) BETWEEN 16 AND 1023),
  organisation_id        uuid        NOT NULL,
  principal_id           uuid        NOT NULL REFERENCES identity.principal (id),
  public_key             bytea       NOT NULL CHECK (octet_length(public_key) BETWEEN 16 AND 2048),
  sign_count             bigint      NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  aaguid                 uuid        NOT NULL,
  transports             text[]      NOT NULL DEFAULT '{}',
  -- SEC-01 B2-3: roaming, non-backed-up keys only (BE = 0 and BS = 0).
  backup_eligible        boolean     NOT NULL CHECK (backup_eligible = false),
  user_verified_at_enrol boolean     NOT NULL CHECK (user_verified_at_enrol = true),
  enrolment_token_id     uuid        NOT NULL REFERENCES identity.enrolment_token (id),
  last_used_at           timestamptz,
  revoked_at             timestamptz,
  revoke_reason          text        CHECK (revoke_reason IN ('counter_regression', 'kill_switch', 'admin_revoked')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  created_by_job         uuid,
  row_version            bigint      NOT NULL DEFAULT 1,
  updated_at             timestamptz,
  CONSTRAINT admin_credential_revocation_pair CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX admin_credential_principal_live_idx ON identity.admin_credential (principal_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE identity.admin_credential IS 'class=C1; public keys and credential IDs are not secrets';

CREATE TABLE identity.webauthn_challenge (
  id            uuid        PRIMARY KEY,
  organisation_id uuid      NOT NULL,
  purpose       text        NOT NULL CHECK (purpose IN ('sign_in', 'elevation', 'enrol', 'tx_sign')),
  principal_id  uuid        REFERENCES identity.principal (id),
  session_id    uuid        REFERENCES identity.session (id) ON DELETE CASCADE,
  challenge     bytea       NOT NULL CHECK (octet_length(challenge) = 32),
  bound_hash    bytea       CHECK (bound_hash IS NULL OR octet_length(bound_hash) = 32),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  created_by_job uuid,
  row_version   bigint      NOT NULL DEFAULT 1,
  updated_at    timestamptz,
  CONSTRAINT webauthn_challenge_session_for_bound_purposes CHECK (purpose IN ('sign_in', 'enrol') OR session_id IS NOT NULL),
  CONSTRAINT webauthn_challenge_bound_hash_for_tx_sign CHECK (purpose = 'tx_sign' OR bound_hash IS NULL)
);
CREATE INDEX webauthn_challenge_expires_idx ON identity.webauthn_challenge (expires_at);
CREATE INDEX webauthn_challenge_session_idx ON identity.webauthn_challenge (session_id) WHERE session_id IS NOT NULL;
COMMENT ON TABLE identity.webauthn_challenge IS 'class=C1; single use, 2 minutes';

CREATE TABLE identity.elevation_grant (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL,
  session_id      uuid        NOT NULL REFERENCES identity.session (id),
  person_id       uuid        NOT NULL REFERENCES identity.person (id),
  issued_at       timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  assertion_at    timestamptz NOT NULL,
  method          text        NOT NULL CHECK (method IN ('webauthn_api', 'pool_auth_time')),
  credential_id   bytea       REFERENCES identity.admin_credential (id),
  revoked_at      timestamptz,
  revoke_reason   text        CHECK (revoke_reason IN ('kill_switch', 'role_change', 'sign_out', 'credential_revoked', 'reconciliation')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  created_by_job  uuid,
  row_version     bigint      NOT NULL DEFAULT 1,
  updated_at      timestamptz,
  CONSTRAINT elevation_grant_window CHECK (expires_at > issued_at),
  CONSTRAINT elevation_grant_revocation_pair CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX elevation_grant_session_live_idx ON identity.elevation_grant (session_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE identity.elevation_grant IS 'class=C1';
