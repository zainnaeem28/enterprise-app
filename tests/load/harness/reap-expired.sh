#!/usr/bin/env bash
# TTL reaper (scheduled): list loadtest resources whose `ttl` tag is in the past. It only
# REPORTS by default (exit 1 when something is expired); the scheduled pipeline then runs
# teardown.sh for the run id. Hard maximum lifetime is 24 hours (decision-log D-1).
# Needs read-only tagging access in the loadtest account.
# Checks us-east-2, us-east-1 and us-west-2; any failed API call fails the reaper.
set -euo pipefail
. "$(dirname "$0")/lib-tagged.sh"
now=$(date -u +%s)
rows=$(tagged_resources Key=Environment,Values=loadtest)
expired=$(jq -r --argjson now "$now" '
  .[] | (.tags | map({(.Key): .Value}) | add) as $t
  | select($t.ttl != null and ($t.ttl | fromdateiso8601) < $now)
  | "\($t.RunId // "unknown")\t\($t.ttl)\t\(.region)\t\(.arn)"' <<<"$rows")
if [ -n "$expired" ]; then
  echo "EXPIRED loadtest resources (run_id, ttl, region, arn):"; echo "$expired"
  echo "$expired" | cut -f1 | sort -u | sed 's/^/expired-run-id=/'
  exit 1
fi
echo "no expired loadtest resources"
