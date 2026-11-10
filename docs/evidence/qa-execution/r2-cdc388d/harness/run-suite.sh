#!/usr/bin/env bash
# usage: run-suite.sh <root> <qaName: qa04|qa05> <libdir relative> <outdir> <test files...>
set -uo pipefail
ROOT=$1; QA=$2; LIBREL=$3; OUT=$4; shift 4
mkdir -p "$OUT" "$ROOT/reports/$QA"
export QA_STACK_STATE="$ROOT/reports/$QA/stack.json"; rm -f "$QA_STACK_STATE"
cd "$ROOT"
node "$ROOT/$LIBREL/stack-up.mjs" "$ROOT" "$QA_STACK_STATE" >"$OUT/stack.out" 2>&1 &
STACK=$!
for i in $(seq 1 150); do sleep 1; grep -q '"ready": true' "$QA_STACK_STATE" 2>/dev/null && break; kill -0 $STACK 2>/dev/null || { tail -20 "$OUT/stack.out"; exit 2; }; done
node --version >"$OUT/tool-versions.txt"
node --test --test-concurrency=1 --test-reporter=spec --test-reporter-destination="$OUT/spec.txt" --test-reporter=junit --test-reporter-destination="$OUT/junit.xml" "$@"
RC=$?
node "$ROOT/$LIBREL/stack-down.mjs" "$ROOT" "$QA_STACK_STATE" >"$OUT/stack-down.out" 2>&1
kill $STACK 2>/dev/null
cp -r "$ROOT/reports/$QA/logs" "$OUT/" 2>/dev/null
exit $RC
