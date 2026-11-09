#!/usr/bin/env bash
# integration-db job (DEVOPS-PLAN 4.2, 5.1, 5.2). On a PostgreSQL 17 server (EHR_TEST_ADMIN_URL):
#   1. the database-backed suites of every workspace (db-foundation, kernel, api, worker) against migrations from empty;
#      each writes JUnit XML; a missing, empty, failing or skipped suite fails (check-junit.mjs);
#   2. the upgrade path: migrate from the previous release tag, then the candidate (n-minus-1.sh), and the previous
#      release's own database suites against the candidate schema (N-1 compatibility, DEVOPS-PLAN 8.1 rule 2).
# Raw reports: reports/integration-db/. INTEGRATION_SUITES (seeded-violation proof only) limits step 1.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
OUT="$(report_dir integration-db)"
JUNIT="$OUT/junit"
mkdir -p "$JUNIT"
cd "$CI_ROOT"
failed=0
SUITES="${INTEGRATION_SUITES:-db-foundation kernel api worker}"

for s in $SUITES; do
  run_db_suite "$CI_ROOT" "$s" "$JUNIT" "$OUT/$s.txt" || { echo "::error::suite $s FAILED"; failed=1; }
done
# shellcheck disable=SC2086
node "$MC_DIR/check-junit.mjs" "$JUNIT" $SUITES || failed=1

if [ "${INTEGRATION_SKIP_N_MINUS_1:-false}" != "true" ]; then
  bash "$MC_DIR/n-minus-1.sh" "$OUT" || failed=1
fi

git rev-parse HEAD >"$OUT/candidate-commit.txt"
node -v >"$OUT/versions.txt"
[ "$failed" -eq 0 ] || { echo "::error::integration-db FAILED"; exit 1; }
echo "integration-db passed"
