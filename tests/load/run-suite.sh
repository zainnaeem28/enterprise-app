#!/usr/bin/env bash
# Run the QA-07 cases in order through run-load.sh, never stopping at the first failure, then print one verdict table.
# Exit 0 only when every case ran AND passed; any FAIL or NOT_RUN (blocked input, missing check) exits non-zero. A not-run case is never a pass.
# TC-PERF-05 is Lighthouse (QA-06), not part of this suite.
# Real mode: environment as in README (ENV_NAME=loadtest BASE_URL LOADTEST_HOSTS CANDIDATE_COMMIT SESSIONS_FILE IDS_FILE; optional
#   VENDOR_SANDBOX=1 for perf-06, LOADTEST_RO_DATABASE_URL for the SQL reconciliations). Durations are the full ARCHITECTURE 9.1 ones.
# Mechanics mode (SUITE_MECHANICS=1): localhost fixture (selftest/fixture-api.mjs), FIXTURE_SELFTEST=1, tiny phases. MECHANICS ONLY,
#   NOT A CAPACITY RESULT: nothing measured describes the system.
# usage: run-suite.sh [case ...]   (default: perf-01 perf-02 perf-03 perf-04 perf-06 perf-07 perf-08 rec-04 rec-07)
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cases=("$@"); [ ${#cases[@]} -gt 0 ] || cases=(perf-01 perf-02 perf-03 perf-04 perf-06 perf-07 perf-08 rec-04 rec-07)
suite_dir="${REPORT_ROOT:-$here/reports/suite-$(date -u +%Y%m%dT%H%M%SZ)}"; mkdir -p "$suite_dir"
fixture_pid=""
cleanup() { [ -z "$fixture_pid" ] || kill "$fixture_pid" 2>/dev/null || true; }
trap cleanup EXIT

if [ "${SUITE_MECHANICS:-0}" = "1" ]; then
  label="MECHANICS ONLY, NOT A CAPACITY RESULT (localhost fixture, FIXTURE_SELFTEST)"
  export FIXTURE_SELFTEST=1 SELFTEST_STAGE_S="${SELFTEST_STAGE_S:-3}" RACE_ROUNDS="${RACE_ROUNDS:-2}" REC_DURATION_S="${REC_DURATION_S:-10}"
  export FIXTURE_PORT="${FIXTURE_PORT:-8097}" BASE_URL="http://127.0.0.1:${FIXTURE_PORT:-8097}" VENDOR_SANDBOX=1
  export CANDIDATE_COMMIT="${CANDIDATE_COMMIT:-$(git -C "$here" rev-parse HEAD 2>/dev/null || echo unknown)}"
  node "$here/selftest/fixture-api.mjs" >"$suite_dir/fixture.log" 2>&1 & fixture_pid=$!
  for _ in $(seq 1 50); do curl -fsS -o /dev/null "$BASE_URL/" 2>/dev/null && break; (echo >"/dev/tcp/127.0.0.1/$FIXTURE_PORT") 2>/dev/null && break; sleep 0.2; done
else
  label="real run on the loadtest environment (see per-case thresholds)"
  for v in ENV_NAME BASE_URL LOADTEST_HOSTS CANDIDATE_COMMIT SESSIONS_FILE IDS_FILE; do
    [ -n "${!v:-}" ] || { echo "run-suite: $v is not set; refusing to run (nothing was measured)" >&2; exit 78; }
  done
  [ -f "$SESSIONS_FILE" ] && [ -f "$IDS_FILE" ] || { echo "run-suite: SESSIONS_FILE/IDS_FILE not found" >&2; exit 78; }
fi
echo "suite: $label"; echo "suite: cases=${cases[*]} report_dir=$suite_dir"
declare -A verdict note; fail=0
mark() { verdict[$1]="$2"; note[$1]="${3:-}"; [ "$2" = PASS ] || fail=1; }
have_db() { [ -n "${LOADTEST_RO_DATABASE_URL:-}" ] && [ "${SUITE_MECHANICS:-0}" != 1 ]; }

for c in "${cases[@]}"; do
  rd="$suite_dir/$c"; export REPORT_DIR="$rd"; started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$c" = perf-06 ] && [ "${VENDOR_SANDBOX:-}" != 1 ]; then mark "$c" NOT_RUN "Blocked: VENDOR_SANDBOX=1 not set (video vendor sandbox)"; continue; fi
  [ "$c" = perf-07 ] && export RACE_MODE="${RACE_MODE:-distinct}"
  "$here/run-load.sh" "$c" >"$suite_dir/$c.out" 2>&1; rc=$?
  if [ $rc -ne 0 ]; then mark "$c" FAIL "k6 exit $rc (see $c.out)"; continue; fi
  ended="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; extra=""
  case "$c" in
    perf-04)
      if have_db; then
        node "$here/check-audit.mjs" --summary "$rd/TC-PERF-04.summary.json" --from "$started" --to "$ended" >"$suite_dir/$c.check.txt" 2>&1 \
          && extra="check-audit pass" || { mark "$c" FAIL "check-audit failed (see $c.check.txt)"; continue; }
      else mark "$c" NOT_RUN "k6 thresholds passed; check-audit needs LOADTEST_RO_DATABASE_URL (not run)"; continue; fi ;;
    perf-07)
      if have_db; then
        node "$here/check-exactly-one.mjs" --ids "$IDS_FILE" --expect 1 --out "$rd/exactly-one.json" >"$suite_dir/$c.check.txt" 2>&1 \
          && extra="check-exactly-one pass" || { mark "$c" FAIL "check-exactly-one failed (see $c.check.txt)"; continue; }
      else mark "$c" NOT_RUN "k6 thresholds passed; check-exactly-one needs LOADTEST_RO_DATABASE_URL (not run)"; continue; fi ;;
    rec-04|rec-07)
      rc_case=TC-REC-04; [ "$c" = rec-07 ] && rc_case=TC-REC-07
      if have_db; then
        node "$here/check-recovery.mjs" --case "$rc_case" --points "$rd/raw.json" --log "$rd/console.txt" --since "$started" --out "$rd/recovery.json" >"$suite_dir/$c.check.txt" 2>&1 \
          && extra="check-recovery pass; no disruption is injected by this workflow (OPS part is DevOps')" || { mark "$c" FAIL "check-recovery failed (see $c.check.txt)"; continue; }
      else mark "$c" NOT_RUN "k6 thresholds passed; check-recovery needs LOADTEST_RO_DATABASE_URL (not run); no disruption injected here"; continue; fi ;;
    perf-08) extra="k6 latency thresholds only; leak/queue-growth NOT judged (no check-soak)" ;;
  esac
  mark "$c" PASS "$extra"
done

{
  echo "## QA-07 load suite: $label"
  echo "| case | verdict | note |"; echo "|---|---|---|"
  for c in "${cases[@]}"; do echo "| $c | ${verdict[$c]} | ${note[$c]} |"; done
  echo; echo "TC-PERF-05 (LCP) is Lighthouse and is not part of this suite."
  [ "${SUITE_MECHANICS:-0}" != 1 ] || echo "Mechanics only: no capacity result; fixture latencies describe nothing about the system."
} | tee "$suite_dir/SUMMARY.md"
[ -z "${GITHUB_STEP_SUMMARY:-}" ] || cat "$suite_dir/SUMMARY.md" >>"$GITHUB_STEP_SUMMARY"
exit $fail
