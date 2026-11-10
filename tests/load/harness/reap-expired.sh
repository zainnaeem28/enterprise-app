#!/usr/bin/env bash
# TTL reaper (scheduled): list loadtest resources whose `ttl` tag is in the past. It only
# REPORTS by default (exit 1 when something is expired); the scheduled pipeline then runs
# teardown.sh for the run id. Hard maximum lifetime is 24 hours (decision-log D-1).
# Needs read-only tagging access in the loadtest account.
set -euo pipefail
now=$(date -u +%s)
rows=$(aws resourcegroupstaggingapi get-resources --tag-filters Key=Environment,Values=loadtest \
  --query 'ResourceTagMappingList[].{arn:ResourceARN,tags:Tags}' --output json)
expired=$(jq -r --argjson now "$now" '
  .[] | (.tags | map({(.Key): .Value}) | add) as $t
  | select($t.ttl != null and ($t.ttl | fromdateiso8601) < $now)
  | "\($t.RunId // "unknown")\t\($t.ttl)\t\(.arn)"' <<<"$rows")
if [ -n "$expired" ]; then
  echo "EXPIRED loadtest resources (run_id, ttl, arn):"; echo "$expired"
  echo "$expired" | cut -f1 | sort -u | sed 's/^/expired-run-id=/'
  exit 1
fi
echo "no expired loadtest resources"
