#!/usr/bin/env bash
# Run one QA-07 case with unmodified k6 (harness/run-k6.sh). Exit status is k6's: a crossed threshold exits non-zero (99).
# usage: run-load.sh <perf-01|perf-02|perf-03|perf-04|perf-06|perf-07|perf-08|rec-04|rec-07> [extra k6 args]
# Required environment (ENV-LOAD only, see README): ENV_NAME=loadtest BASE_URL LOADTEST_HOSTS CANDIDATE_COMMIT SESSIONS_FILE IDS_FILE
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case_id="${1:?usage: run-load.sh <case> [k6 args]}"; shift
case "$case_id" in
  perf-01) script=perf-01-mixed.js ;;
  perf-02) script=perf-02-slot-search.js ;;
  perf-03) script=perf-03-rls.js ;;
  perf-04) script=perf-04-audit.js ;;
  perf-06) script=perf-06-video-join.js ;;
  perf-07) script=perf-07-booking-race.js ;;
  perf-08) script=perf-08-soak.js ;;
  rec-04)  script=rec-continuity.js; export REC_CASE=TC-REC-04 ;;
  rec-07)  script=rec-continuity.js; export REC_CASE=TC-REC-07 ;;
  *) echo "unknown case $case_id" >&2; exit 64 ;;
esac
export REPORT_DIR="${REPORT_DIR:-$here/reports/$case_id-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$REPORT_DIR"
export SCRIPT_REVISION="$(git -C "$here" rev-parse HEAD 2>/dev/null || echo unknown)"
export K6_VERSION="$("${K6_BIN:-k6}" version | head -1)"
echo "case=$case_id script=$script report_dir=$REPORT_DIR k6=$K6_VERSION script_revision=$SCRIPT_REVISION" | tee "$REPORT_DIR/run.txt"
set +e
(cd "$here/scenarios" && "$here/harness/run-k6.sh" run \
  --out "json=$REPORT_DIR/raw.json" --summary-export "$REPORT_DIR/summary-export.json" \
  --log-output "file=$REPORT_DIR/k6.log" --console-output "$REPORT_DIR/console.txt" \
  -e REPORT_DIR="$REPORT_DIR" "$@" "$script") 
rc=$?
echo "k6_exit=$rc" | tee -a "$REPORT_DIR/run.txt"
exit $rc
