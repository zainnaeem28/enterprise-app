#!/usr/bin/env bash
# QA-03 runner (ENV-INT/ci): builds nothing; starts the QA-05 stack from a COPY of tests/api/platform/lib with the QA-03 IdP
# control overlaid, runs the identity, authorization and security suites, writes raw reports, stops the stack, drops the database.
#   EHR_TEST_ADMIN_URL=postgres://… tests/api/identity/run.sh <outDir>
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$(mkdir -p "${1:?output directory}" && cd "$1" && pwd)"
LIB="$OUT/lib"
rm -rf "$LIB" && mkdir -p "$LIB" && cp "$ROOT"/tests/api/platform/lib/*.mjs "$LIB"/ && cp "$ROOT"/tests/api/identity/lib/idp-control.mjs "$LIB"/idp-control.mjs
# the copied lib resolves `root` from its own location only for pg; the repo root is passed explicitly
ln -sfn "$ROOT/node_modules" "$OUT/node_modules"
export QA_STACK_STATE="$OUT/state.json"
rm -f "$QA_STACK_STATE"
node "$LIB/stack-up.mjs" "$ROOT" "$QA_STACK_STATE" >"$OUT/stack.out" 2>&1 &
STACK=$!
for i in $(seq 1 120); do
  sleep 1
  if [ -f "$QA_STACK_STATE" ] && grep -q '"ready": true' "$QA_STACK_STATE"; then break; fi
  kill -0 $STACK 2>/dev/null || { echo "stack died"; tail -20 "$OUT/stack.out"; exit 2; }
done
cd "$ROOT"
node --version >"$OUT/tool-versions.txt"
node --test --test-concurrency=1 --test-reporter=spec --test-reporter-destination="$OUT/spec.txt" \
  --test-reporter=junit --test-reporter-destination="$OUT/junit.xml" \
  tests/api/identity/*.test.mjs tests/api/authorization/*.test.mjs tests/api/security/*.test.mjs
RC=$?
node "$LIB/stack-down.mjs" "$ROOT" "$QA_STACK_STATE" >"$OUT/stack-down.out" 2>&1
kill $STACK 2>/dev/null
exit $RC
