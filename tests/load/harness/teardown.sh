#!/usr/bin/env bash
# Always-run teardown (CI `if: always()`): destroy this run's environment. Uses the same
# state and variables as the create step. Exit code is non-zero if anything remains.
set -euo pipefail
root="${1:?usage: teardown.sh <root-dir> [tofu args...]}"; shift
cd "$root"
${IAC_BIN:-tofu} destroy -auto-approve -input=false "$@"
