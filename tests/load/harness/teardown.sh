#!/usr/bin/env bash
# Always-run teardown (CI `if: always()`): destroy this run's environment. Uses the same
# state and variables as the create step. After destroy, every Region (us-east-2, us-east-1,
# us-west-2) is queried for resources tagged with this RunId; exit is non-zero if any remain
# or if a query fails.
set -euo pipefail
root="${1:?usage: teardown.sh <root-dir> <run_id> [tofu args...]}"; run_id="${2:?run_id required}"; shift 2
here="$(cd "$(dirname "$0")" && pwd)"; . "$here/lib-tagged.sh"
cd "$root"
${IAC_BIN:-tofu} destroy -auto-approve -input=false "$@"
rc=0
left=$(tagged_resources Key=RunId,Values="$run_id") || rc=1
if [ "$rc" -eq 0 ] && [ "$(jq length <<<"$left")" -gt 0 ]; then
  echo "TEARDOWN INCOMPLETE: resources still tagged RunId=$run_id (region, arn):" >&2
  jq -r '.[] | "\(.region)\t\(.arn)"' <<<"$left" >&2; rc=1
fi
[ "$rc" -eq 0 ] && echo "teardown verified: no resources tagged RunId=$run_id in ${LOADTEST_REGIONS[*]}"
exit "$rc"
