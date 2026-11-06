#!/usr/bin/env bash
# Seeded-violation proof for the database jobs (F-09 acceptance: "each job is proved to fail on a seeded violation").
# Every scenario introduces ONE defect into a THROWAWAY COPY of the working tree (or into the throwaway database) and
# requires the job's entry point to exit non-zero AND to name the expected rule. The repository itself is never modified.
#   seed.sh migration-check | integration-db        Needs the job's PostgreSQL 17 server and a finished `pnpm build`.
# Exit 0 only if every seeded defect was caught for the stated reason.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
JOB="${1:?migration-check|integration-db}"
RESULTS="$REPORT_ROOT/seeded-$JOB.txt"
mkdir -p "$REPORT_ROOT"
: >"$RESULTS"
WORK="$(mktemp -d)"
LOGS="$REPORT_ROOT/seeded-$JOB-logs"
mkdir -p "$LOGS"
trap 'rm -rf "$WORK"' EXIT
bad=0

# fresh_copy <name> [git]: copy the tree (no .git, reports) into a new repository and link the installed dependencies;
# with `git`, the first commit is tagged r1 (the "previous release").
fresh_copy() {
  local d="$WORK/$1" src="$CI_ROOT" nm rel
  mkdir -p "$d"
  tar -C "$src" --exclude=.git --exclude=reports --exclude=node_modules -cf - . | tar -C "$d" -xf -
  while read -r nm; do
    rel="${nm#"$src"/}"
    ln -s "$nm" "$d/$rel"
  done < <(find "$src" -maxdepth 3 -name node_modules -prune -not -path '*/.git/*')
  # Always a repository (the secret-reference lint reads `git ls-files`); the linked node_modules are never committed.
  (cd "$d" && git init -q -b main && git config user.name seed && git config user.email seed@example.invalid &&
    printf 'node_modules\n' >>.git/info/exclude && git add -A && git commit -q -m baseline)
  if [ "${2:-}" = git ]; then
    (cd "$d" && git tag r1)
  fi
  echo "$d"
}

# expect_fail <label> <pattern> <dir> <command...>: must exit non-zero and print <pattern> (the right reason).
expect_fail() {
  local label="$1" pattern="$2" dir="$3"
  shift 3
  local log="$LOGS/${label//[^A-Za-z0-9]/_}.log" rc=0
  (cd "$dir" && REPORT_ROOT="$dir/reports" "$@") >"$log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ] && grep -Eq -- "$pattern" "$log"; then
    printf 'PASS (rc=%s, matched /%s/)  %s\n' "$rc" "$pattern" "$label" | tee -a "$RESULTS"
  else
    printf 'FAIL (rc=%s, pattern /%s/ %s)  %s\n' "$rc" "$pattern" "$(grep -Eq -- "$pattern" "$log" && echo found || echo NOT found)" "$label" | tee -a "$RESULTS"
    tail -n 15 "$log" | sed 's/^/      /' | tee -a "$RESULTS"
    bad=$((bad + 1))
  fi
}

add_migration() { # add_migration <dir> <file name> (SQL on stdin)
  cat >"$1/db/migrations/$2"
}
SEED_TABLE='CREATE SCHEMA seedmod;
CREATE TABLE seedmod.thing (id uuid PRIMARY KEY, patient_id uuid);
ALTER TABLE seedmod.thing ENABLE ROW LEVEL SECURITY;
ALTER TABLE seedmod.thing FORCE ROW LEVEL SECURITY;'

mc() { bash scripts/ci/migration-check/migration-check.sh; }

if [ "$JOB" = migration-check ]; then
  d="$(fresh_copy m-no-rls)"
  printf -- '-- migration-class: expand\nCREATE SCHEMA seedmod;\nCREATE TABLE seedmod.thing (id uuid PRIMARY KEY);\n' | add_migration "$d" 0900_seed.sql
  expect_fail "RLS/FORCE missing on a table" 'check M-1 FAILED' "$d" mc

  d="$(fresh_copy m-public-policy)"
  { echo '-- migration-class: expand'; echo "$SEED_TABLE"; echo 'CREATE POLICY seed_all ON seedmod.thing TO PUBLIC USING (true);'; } | add_migration "$d" 0900_seed.sql
  expect_fail "policy TO PUBLIC" 'check M-2 FAILED' "$d" mc

  d="$(fresh_copy m-view)"
  { echo '-- migration-class: expand'; echo "$SEED_TABLE"; echo 'CREATE POLICY seed_p ON seedmod.thing TO app_api USING (false);'; echo 'CREATE VIEW seedmod.v AS SELECT id FROM seedmod.thing;'; } | add_migration "$d" 0900_seed.sql
  expect_fail "view without security_invoker" 'check M-4-views FAILED' "$d" mc

  d="$(fresh_copy m-patient-guard)"
  { echo '-- migration-class: expand'; echo "$SEED_TABLE"; echo 'CREATE POLICY seed_p ON seedmod.thing TO app_api USING (false);'; } | add_migration "$d" 0900_seed.sql
  expect_fail "patient_id table without the merge write guard" 'check M-5-patient-guard FAILED' "$d" mc

  d="$(fresh_copy m-definer)"
  printf -- '-- migration-class: expand\nCREATE SCHEMA seedmod;\nCREATE FUNCTION seedmod.f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;\n' | add_migration "$d" 0900_seed.sql
  expect_fail "SECURITY DEFINER function outside the inventory, no search_path" 'check M-5-definer FAILED' "$d" mc

  d="$(fresh_copy m-dml)"
  printf -- '-- migration-class: expand\nCREATE SCHEMA seedmod;\nCREATE TABLE seedmod.thing (id int);\nINSERT INTO seedmod.thing VALUES (1);\n' | add_migration "$d" 0900_seed.sql
  expect_fail "DML in a migration" 'DML' "$d" mc

  d="$(fresh_copy m-destructive)"
  printf -- '-- migration-class: expand\nALTER TABLE kernel.setting DROP COLUMN value;\n' | add_migration "$d" 0900_seed.sql
  expect_fail "expand/contract: DROP COLUMN in an expand migration" 'EXPAND_DESTRUCTIVE' "$d" mc

  d="$(fresh_copy m-master-user)"
  mkdir -p "$d/infra/ecs"
  printf '{"containerDefinitions":[{"environment":[{"name":"EHR_DATABASE_URL","value":"postgres://rdsadmin@db.internal:5432/ehr"}]}]}\n' >"$d/infra/ecs/api-task.json"
  expect_fail "RDS master user in an application connection string" 'master/admin user' "$d" mc

  d="$(fresh_copy m-master-secret)"
  mkdir -p "$d/infra/ecs"
  printf '{"containerDefinitions":[{"secrets":[{"name":"EHR_DATABASE_URL","valueFrom":"arn:aws:secretsmanager:eu-west-1:1:secret:rds!db-master-abc"}]}]}\n' >"$d/infra/ecs/api-task.json"
  expect_fail "RDS master secret referenced by a task definition" 'RDS master secret' "$d" mc

  sql_case() { # sql_case <label> <pattern> <sql>
    local dd; dd="$(fresh_copy "sql-${1//[^A-Za-z0-9]/_}")"
    printf '%s\n' "$3" >"$dd/seed.sql"
    expect_fail "$1" "$2" "$dd" env MIGRATION_CHECK_SEED_SQL="$dd/seed.sql" bash scripts/ci/migration-check/migration-check.sh
  }
  sql_case "function-owner role can log in" 'check R-attributes FAILED' 'ALTER ROLE patient_scope_owner LOGIN;'
  sql_case "application role has BYPASSRLS" 'check X-bypassrls FAILED' 'ALTER ROLE app_api BYPASSRLS;'
  sql_case "audit-writing role lost transaction_timeout" 'check R-timeouts FAILED' 'ALTER ROLE app_worker RESET transaction_timeout;'
  sql_case "reporting_ro granted an object outside the C0/C1 list" 'check M-4-reporting FAILED' 'GRANT SELECT ON kernel.setting TO reporting_ro;'
  sql_case "application role owns a table" 'check R-no-owned-tables FAILED' 'ALTER TABLE kernel.setting OWNER TO app_api;'
  sql_case "administrator (RDS master user) owns an object" 'check X-admin-owns-nothing FAILED' 'CREATE TABLE public.admin_owned (i int);'
  sql_case "app_owner can INSERT into an audit table" 'check R-app-owner-no-audit-insert FAILED' 'CREATE SCHEMA audit; CREATE TABLE audit.seed_event (i int); ALTER TABLE audit.seed_event OWNER TO app_owner;'
fi

if [ "$JOB" = integration-db ]; then
  d="$(fresh_copy i-failing-suite)"
  printf -- '-- migration-class: expand\nCREATE SCHEMA seedmod;\nCREATE TABLE seedmod.thing (id uuid PRIMARY KEY);\n' | add_migration "$d" 0900_seed.sql
  expect_fail "a database suite fails on a schema defect" 'FAILED|suite db-foundation' "$d" env INTEGRATION_SUITES=db-foundation INTEGRATION_SKIP_N_MINUS_1=true bash scripts/ci/migration-check/integration-db.sh

  d="$(fresh_copy i-empty-suite)"
  find "$d/apps/worker/dist" -name '*.dbtest.js*' -delete
  expect_fail "empty suite (no database test file)" 'an empty suite fails' "$d" env INTEGRATION_SUITES=worker INTEGRATION_SKIP_N_MINUS_1=true bash scripts/ci/migration-check/integration-db.sh

  mkdir -p "$WORK/junit-skip" "$WORK/junit-zero"
  printf '<testsuites><testsuite name="s"><testcase name="a"/><testcase name="b"><skipped/></testcase></testsuite></testsuites>\n' >"$WORK/junit-skip/s.xml"
  printf '<testsuites><testsuite name="s" tests="0"></testsuite></testsuites>\n' >"$WORK/junit-zero/s.xml"
  expect_fail "a skipped test" 'skipped 1 test' "$CI_ROOT" node scripts/ci/migration-check/check-junit.mjs "$WORK/junit-skip" s
  expect_fail "a suite that ran zero tests" 'ran zero tests' "$CI_ROOT" node scripts/ci/migration-check/check-junit.mjs "$WORK/junit-zero" s

  d="$(fresh_copy i-n-minus-1 git)"
  printf -- '-- migration-class: expand\nCREATE FUNCTION kernel.seed_block() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$ BEGIN RAISE EXCEPTION '"'"'seeded incompatibility'"'"'; END $$;\nCREATE TRIGGER seed_block BEFORE INSERT ON kernel.idempotency_key FOR EACH ROW EXECUTE FUNCTION kernel.seed_block();\n' | add_migration "$d" 0900_seed.sql
  (cd "$d" && git add -A && git commit -q -m "seeded schema change")
  expect_fail "N-1: the previous release does not pass against the new schema" 'N-1: the previous release' "$d" env INTEGRATION_SUITES=db-foundation bash scripts/ci/migration-check/integration-db.sh
fi

echo "seeded violations: $bad not caught (results in $RESULTS)"
[ "$bad" -eq 0 ]
