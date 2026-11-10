#!/usr/bin/env bash
set -uo pipefail
ROOT=$1; ENGINE=$2; OUT=$3
mkdir -p "$OUT" "$ROOT/reports/qa-screens"
export QA_STACK_STATE="$ROOT/reports/qa-screens/stack.json"; rm -f "$QA_STACK_STATE"; rm -rf "$ROOT/reports/qa-screens/logs"
cd "$ROOT"
node /tmp/qa640/jlib/stack-up.mjs "$ROOT" "$QA_STACK_STATE" >"$OUT/stack.out" 2>&1 &
STACK=$!
for i in $(seq 1 150); do sleep 1; grep -q '"ready": true' "$QA_STACK_STATE" 2>/dev/null && break; kill -0 $STACK 2>/dev/null || { tail -5 "$OUT/stack.out" | cut -c1-300; exit 2; }; done
set +u; QA_LIBS_ROOT=/tmp/qa-ci-tools/root; . tests/e2e/harness/browsers-env.sh; export LD_LIBRARY_PATH=$LD_LIBRARY_PATH:/tmp/libs/usr/lib/x86_64-linux-gnu:/tmp/libs/usr/lib:/tmp/qa640/wk/usr/lib/x86_64-linux-gnu:/tmp/qa640/wk/usr/lib; export __EGL_VENDOR_LIBRARY_DIRS=/tmp/qa640/glvnd LIBGL_DRIVERS_PATH=/tmp/qa640/wk/usr/lib/x86_64-linux-gnu/dri
timeout 420 node /tmp/qa640/screens.mjs "$ROOT" "$OUT" "$ENGINE" 2>&1 | grep -v Skipping | tee "$OUT/run.txt"
RC=${PIPESTATUS[0]}
node /tmp/qa640/jlib/stack-down.mjs "$ROOT" "$QA_STACK_STATE" >"$OUT/stack-down.out" 2>&1
kill $STACK 2>/dev/null
cp -r "$ROOT/reports/qa-screens/logs" "$OUT/logs" 2>/dev/null
exit $RC
