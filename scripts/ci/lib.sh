# Shared helpers for scripts/ci. Source this file; do not execute it.
# shellcheck shell=bash
set -euo pipefail

CI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export CI_ROOT
REPORT_ROOT="${REPORT_ROOT:-$CI_ROOT/reports}"
CI_TOOLS_DIR="${CI_TOOLS_DIR:-${RUNNER_TEMP:-/tmp}/ci-tools}"
export PATH="$CI_TOOLS_DIR/bin:$PATH"

# report_dir <job>: create (empty) and print the report directory of a job.
report_dir() {
  local d="$REPORT_ROOT/$1"
  rm -rf "$d"
  mkdir -p "$d"
  echo "$d"
}

# require_tool <name>: a missing tool is a failure, never a skip.
require_tool() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "::error::required tool '$1' is not installed (run scripts/ci/install-tools.sh $1)" >&2
    exit 127
  }
}

# require_report <file>: a missing or empty report fails the check.
require_report() {
  [ -s "$1" ] || {
    echo "::error::report missing or empty: $1" >&2
    exit 1
  }
}
