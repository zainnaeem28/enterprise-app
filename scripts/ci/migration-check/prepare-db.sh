#!/usr/bin/env bash
# Create database <name> (default ehr) on the job's PostgreSQL 17 server, apply db/roles as the administrator and the
# migrations as app_owner. Used by the contract and e2e-smoke jobs, which need a migrated database behind the API.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DB="${1:-ehr}"
cd "$CI_ROOT"
ADMIN_USER="$(node "$MC_DIR/db-admin.mjs" admin-user)"
db_create "$DB"
EHR_DB_ADMIN_URL="$(db_url "$ADMIN_USER" "$DB")" node db/tools/migrate.mjs bootstrap
EHR_DB_MIGRATE_URL="$(db_url app_owner "$DB")" node db/tools/migrate.mjs migrate
