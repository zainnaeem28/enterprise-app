-- Bootstrap: cluster-level roles, memberships and role-level settings.
--
-- Runs once per cluster, BEFORE the migrations, as a privileged administrator
-- (the CI superuser; the RDS master user in a real environment, ARCHITECTURE
-- 21.2). Migrations run as app_owner, which cannot create roles and must not
-- be able to. Idempotent: safe to run again.
--
-- No passwords are set here and none may be added: credentials come from the
-- secret store (DEVOPS-PLAN 7). The CI container uses trust authentication.
-- Source: ARCHITECTURE 21.2, 8.1; SHARED-BOUNDARIES 6.2 (M-1).

DO $bootstrap$
DECLARE
  login_roles  text[] := ARRAY['app_owner', 'app_api', 'app_worker', 'reporting_ro', 'audit_archiver', 'app_bootstrap'];
  nologin_roles text[] := ARRAY[
    'scheduling_booking_owner', 'patient_scope_owner', 'patient_match_owner',
    'integration_receiver_owner', 'queue_owner', 'identity_signin_ro', 'directory_ro', 'identity_bootstrap_owner'
  ];
  r text;
BEGIN
  FOREACH r IN ARRAY login_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I', r);
    END IF;
    EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT', r);
  END LOOP;
  FOREACH r IN ARRAY nologin_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I', r);
    END IF;
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT', r);
  END LOOP;

  -- Nobody but the migration role may create objects in the database; PUBLIC gets nothing.
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_owner, app_api, app_worker, reporting_ro, audit_archiver, app_bootstrap', current_database());
  EXECUTE format('GRANT CREATE ON DATABASE %I TO app_owner', current_database());
END
$bootstrap$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- 21.2 point 1 and draft 8.1 (TDR-15): app_owner may SET ROLE to each owner role, so a
-- non-superuser migration can transfer ownership, and inherits none of their rights.
GRANT scheduling_booking_owner, patient_scope_owner, patient_match_owner, integration_receiver_owner, directory_ro, queue_owner,
  identity_bootstrap_owner
  TO app_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

-- 21.2 identity_signin_ro: app_api may switch to it (SET LOCAL ROLE) and gains none of its rights otherwise.
GRANT identity_signin_ro TO app_api WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

-- INT04-F02b (decision log 2.1, ARCHITECTURE amendment A-6): app_bootstrap is the dedicated login of the run-once
-- `bootstrap-admins` command, a member of nothing, with CONNECTION LIMIT 1. Its only rights (in the identity migration of the
-- 2400 band) are USAGE on schema identity and EXECUTE on identity.bootstrap_admins; the password lives in the secret store
-- (<env>/db/app-bootstrap, DO-10), never here. identity_bootstrap_owner owns that one function and nothing else.
ALTER ROLE app_bootstrap CONNECTION LIMIT 1;

-- Role-level timeouts (21.2; SAR-10). transaction_timeout is the bound that
-- audit.require_bounded_tx checks, so it is set on every role that can insert
-- audit rows (app_api, app_worker, and audit_archiver, which writes its own event).
ALTER ROLE app_api        SET transaction_timeout = '60s';
ALTER ROLE app_api        SET statement_timeout = '15s';
ALTER ROLE app_api        SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE app_api        SET lock_timeout = '5s';
ALTER ROLE app_worker     SET transaction_timeout = '60s';
ALTER ROLE app_worker     SET statement_timeout = '50s';
ALTER ROLE app_worker     SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE app_worker     SET lock_timeout = '5s';
ALTER ROLE audit_archiver SET transaction_timeout = '60s';
ALTER ROLE audit_archiver SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE audit_archiver SET lock_timeout = '5s';
-- app_bootstrap writes audit rows through the definer function, so audit.require_bounded_tx reads its transaction_timeout.
ALTER ROLE app_bootstrap  SET transaction_timeout = '60s';
ALTER ROLE app_bootstrap  SET statement_timeout = '50s';
ALTER ROLE app_bootstrap  SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE app_bootstrap  SET lock_timeout = '5s';
