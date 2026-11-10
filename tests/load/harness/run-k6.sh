#!/usr/bin/env bash
# Run k6 without automatic extension provisioning (k6 v1+ would otherwise download a custom,
# modified binary when a script imports k6/x/*; decision-log HEAAA-586 D-2 forbids that).
set -euo pipefail
export K6_BINARY_PROVISIONING=false
exec "${K6_BIN:-k6}" "$@"
