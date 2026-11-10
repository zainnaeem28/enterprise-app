#!/usr/bin/env bash
# Cost guard (run between test stages and on a schedule during a run). Stops the run when
# the spend tagged to it reaches the per-run ceiling, and reports it; it never raises the
# ceiling. Needs ce:GetCostAndUsage in the loadtest account.
set -euo pipefail
run_id="${1:?usage: guard-cost.sh <run_id> <ceiling_usd> <start YYYY-MM-DD>}"; ceiling="${2:?}"; start="${3:?}"
end=$(date -u -d tomorrow +%F)
spend=$(aws ce get-cost-and-usage --time-period "Start=$start,End=$end" --granularity DAILY --metrics UnblendedCost \
  --filter "{\"Tags\":{\"Key\":\"RunId\",\"Values\":[\"$run_id\"]}}" \
  --query 'sum(ResultsByTime[].Total.UnblendedCost.Amount)' --output text)
echo "run $run_id spend so far: $spend USD (ceiling $ceiling USD; Cost Explorer lags up to a day)"
awk -v s="$spend" -v c="$ceiling" 'BEGIN{exit !(s+0 >= c+0)}' && { echo "CEILING REACHED: stop the run and report to the Orchestrator" >&2; exit 1; } || true
