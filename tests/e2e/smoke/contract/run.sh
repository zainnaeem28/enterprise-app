#!/usr/bin/env bash
# contract job (DEVOPS-PLAN 5.1 AL-07, TC-API-09): Schemathesis against the running API.
#   run.sh [base-url]        default http://127.0.0.1:3000 (the API container started by the job)
# Needs `schemathesis` on PATH (pinned in the workflow), the built API and the inventory report. Raw output:
# reports/contract/. Blocks on any response that violates its documented schema or status, an undocumented status
# or content type, a 5xx; and on an empty selection or an empty/failed Schemathesis run.
. "$(dirname "${BASH_SOURCE[0]}")/../../../../scripts/ci/lib.sh"
OUT="$(report_dir contract)"
BASE="${1:-${CONTRACT_BASE_URL:-http://127.0.0.1:3000}}"
HERE="$CI_ROOT/tests/e2e/smoke/contract"
cd "$CI_ROOT"
require_tool schemathesis

node apps/api/dist/src/platform/inventory-cli.js --report "$OUT/inventory.json" | tee "$OUT/inventory.txt"
node "$HERE/select-operations.mjs" "$OUT/inventory.json" "$OUT" | tee "$OUT/selection.txt"

schemathesis --version | tee "$OUT/schemathesis-version.txt"
# X-Client-Release: the API refuses a request without a supported portal release (28.6); the value is the shell's format.
schemathesis run "$OUT/openapi.implemented.json" \
  --url "$BASE" \
  --header "X-Client-Release: r1.000000000000" \
  --checks not_a_server_error,status_code_conformance,content_type_conformance,response_headers_conformance,response_schema_conformance \
  --max-examples "${SCHEMATHESIS_MAX_EXAMPLES:-25}" \
  --seed "${SCHEMATHESIS_SEED:-20261106}" \
  --workers 1 \
  --report junit,har --report-dir "$OUT/schemathesis" \
  2>&1 | tee "$OUT/schemathesis.txt"

# Empty-run guard: Schemathesis must have executed test cases for every selected operation.
node "$HERE/check-junit.mjs" "$OUT/schemathesis" "$OUT/selection.json"
