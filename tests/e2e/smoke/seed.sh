#!/usr/bin/env bash
# Seeded-violation proof for the browser, contract and budget jobs (F-09 acceptance). Each scenario breaks ONE thing in a
# COPY of the build output (or points the job at a stub server) and requires the job's entry point to exit non-zero and
# to name the expected reason. The repository and the real build are never modified.
#   seed.sh a11y-smoke | e2e-smoke | bundle-budget | contract
# Exit 0 only if every seeded defect was caught for the stated reason.
. "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/ci/lib.sh"
JOB="${1:?a11y-smoke|e2e-smoke|bundle-budget|contract}"
RESULTS="$REPORT_ROOT/seeded-$JOB.txt"
mkdir -p "$REPORT_ROOT"
: >"$RESULTS"
WORK="$(mktemp -d)"
LOGS="$REPORT_ROOT/seeded-$JOB-logs"
mkdir -p "$LOGS"
trap 'rm -rf "$WORK"; [ -z "${STUB_PID:-}" ] || kill "$STUB_PID" 2>/dev/null' EXIT
SMOKE="$CI_ROOT/tests/e2e/smoke"
cd "$CI_ROOT"
bad=0

expect_fail() { # expect_fail <label> <pattern> <command...>
  local label="$1" pattern="$2"
  shift 2
  local log="$LOGS/${label//[^A-Za-z0-9]/_}.log" rc=0
  "$@" >"$log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ] && grep -Eq -- "$pattern" "$log"; then
    printf 'PASS (rc=%s, matched /%s/)  %s\n' "$rc" "$pattern" "$label" | tee -a "$RESULTS"
  else
    printf 'FAIL (rc=%s, pattern /%s/ %s)  %s\n' "$rc" "$pattern" "$(grep -Eq -- "$pattern" "$log" && echo found || echo NOT found)" "$label" | tee -a "$RESULTS"
    tail -n 25 "$log" | sed 's/^/      /' | tee -a "$RESULTS"
    bad=$((bad + 1))
  fi
}
broken_dist() { # broken_dist <name>: copy of the built shell
  rm -rf "$WORK/$1"
  cp -a "$CI_ROOT/apps/staff/dist" "$WORK/$1"
  echo "$WORK/$1"
}
pw() { # pw <project> <dist> [extra playwright args]: the real job command against another build output
  local project="$1" dist="$2"
  shift 2
  SMOKE_PROJECT="$project" SMOKE_DIST_DIR="$dist" SMOKE_REPORT_DIR="$WORK/report-$project" NODE_PATH="$CI_ROOT/apps/staff/node_modules" \
    pnpm --filter @ehr/staff exec playwright test -c ../../tests/e2e/smoke/playwright.config.ts --project="$project" "$@"
}

case "$JOB" in
  a11y-smoke)
    d="$(broken_dist a11y)"
    sed -i 's#</body>#<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="><button></button></body>#' "$d/index.html"
    grep -q '<button></button>' "$d/index.html" || { echo "seed did not apply"; exit 1; }
    expect_fail "an image without alt text and a button without a name" 'image-alt|button-name' pw a11y "$d"
    expect_fail "no test selected (empty suite)" 'No tests found' pw a11y "$CI_ROOT/apps/staff/dist" --grep '@does-not-exist'
    mkdir -p "$WORK/empty"
    printf '{"stats":{"expected":0,"unexpected":0,"flaky":0,"skipped":0},"errors":[]}\n' >"$WORK/empty/r.json"
    expect_fail "an empty report" 'empty or shrunken suite' node "$SMOKE/check-report.mjs" "$WORK/empty/r.json" 8
    ;;
  e2e-smoke)
    d="$(broken_dist e2e)"
    sed -i 's/X-Client-Release/X-Client-Releas_/g' "$d"/assets/*.js
    expect_fail "the shell stops sending X-Client-Release" 'X-Client-Release' pw e2e "$d"
    d="$(broken_dist e2e3p)"
    sed -i 's#</head>#<script src="https://analytics.invalid/t.js"></script></head>#' "$d/index.html"
    expect_fail "the shell calls a third-party origin" 'another origin' pw e2e "$d"
    expect_fail "no test selected (empty suite)" 'No tests found' pw e2e "$CI_ROOT/apps/staff/dist" --grep '@does-not-exist'
    ;;
  bundle-budget)
    d="$(broken_dist bloat)"
    head -c 700000 /dev/urandom | base64 -w0 | sed 's/.*/window.__seedBloat="&";/' >"$d/assets/seed-bloat.js"
    sed -i 's#</head>#<script src="/assets/seed-bloat.js"></script></head>#' "$d/index.html"
    expect_fail "script weight over budget (gzip budget script)" 'total JS gzip' env BUNDLE_DIST_DIR="$d" node "$SMOKE/bundle-gzip.mjs" "$d"
    expect_fail "script weight over budget (Lighthouse CI)" 'resource-summary:script:size|Assertion failed' \
      env SMOKE_DIST_DIR="$d" LHCI_OUTPUT_DIR="$WORK/lhci-bloat" CHROME_PATH="${CHROME_PATH:-}" pnpm dlx "@lhci/cli@${LHCI_VERSION:-0.16.0}" autorun --config=lighthouserc.cjs
    mkdir -p "$WORK/lhci-empty"
    expect_fail "no Lighthouse report (empty run)" 'nothing or too little was measured' node "$SMOKE/check-lighthouse.mjs" "$WORK/lhci-empty" 3
    ;;
  contract)
    cat >"$WORK/stub.mjs" <<'STUB'
import { createServer } from 'node:http';
const mode = process.argv[3];
createServer((req, res) => {
  if (mode === '500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"boom":true}'); }
  else { res.writeHead(418, { 'content-type': 'text/plain' }); res.end('teapot'); } // a status the contract does not document
}).listen(Number(process.argv[2]), '127.0.0.1');
STUB
    run_contract() { REPORT_ROOT="$WORK/contract-report" bash "$SMOKE/contract/run.sh" "$1"; }
    node "$WORK/stub.mjs" 3991 500 &
    STUB_PID=$!
    sleep 1
    expect_fail "the API answers 500" 'not_a_server_error|Server error|FAILURES|failed' run_contract http://127.0.0.1:3991
    kill "$STUB_PID"
    node "$WORK/stub.mjs" 3992 418 &
    STUB_PID=$!
    sleep 1
    expect_fail "the API answers a status the contract does not document" 'status_code_conformance|Undocumented|FAILURES|failed' run_contract http://127.0.0.1:3992
    kill "$STUB_PID"
    STUB_PID=
    mkdir -p "$WORK/empty-inv"
    printf '{"routes":[],"failures":[]}\n' >"$WORK/empty-inv/inventory.json"
    expect_fail "no implemented operation (empty selection)" 'empty suite fails' node "$SMOKE/contract/select-operations.mjs" "$WORK/empty-inv/inventory.json" "$WORK/empty-inv/out"
    printf '{"routes":[{"method":"GET","path":"/api/v1/not-documented","controller":"X","handler":"y"}],"failures":[]}\n' >"$WORK/empty-inv/inventory2.json"
    expect_fail "an implemented route that is not documented" 'is not in the OpenAPI document' node "$SMOKE/contract/select-operations.mjs" "$WORK/empty-inv/inventory2.json" "$WORK/empty-inv/out2"
    ;;
  *) echo "unknown job $JOB" >&2; exit 2 ;;
esac
echo "seeded violations: $bad not caught (results in $RESULTS)"
[ "$bad" -eq 0 ]
