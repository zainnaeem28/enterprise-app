-- Read-only probe for the C-01 "Unverified" item (DEVOPS-PLAN 5.2, SHARED-BOUNDARIES 12):
-- on a real RDS PostgreSQL 17 instance in staging, role-level transaction_timeout must be
-- storable and readable from the session of the role that writes audit rows.
-- Run by the build-foundation task as a DBA test role AFTER the F-03 roles bootstrap. Not run here.

-- 1. The instance accepts the parameter and the server is version 17.
SHOW server_version;
SHOW transaction_timeout;

-- 2. The role-level settings exist (pg_db_role_setting is readable by any role).
SELECT r.rolname, s.setconfig
FROM pg_db_role_setting s
JOIN pg_roles r ON r.oid = s.setrole
WHERE r.rolname IN ('app_api', 'app_worker', 'audit_archiver')
ORDER BY r.rolname;
-- Expected: each row's setconfig contains transaction_timeout=60s.

-- 3. The session of an audit-writing role reads the value (run connected AS app_api, then app_worker,
--    then audit_archiver): current_setting is what the audit insert trigger sees.
SELECT current_setting('transaction_timeout') AS seen_by_trigger;
-- Expected: 1min (60 s).

-- 4. A client-supplied override above the bound is visible to the trigger (trigger must refuse it):
BEGIN;
SET LOCAL transaction_timeout = '61s';
SELECT current_setting('transaction_timeout');   -- Expected: 1min1s
ROLLBACK;
