#!/usr/bin/env bash
# Shared helper (sourced): list tagged loadtest resources in every Region the module uses.
# us-east-2 is the primary; us-east-1 holds CloudFront and the CloudFront-scope WAF;
# us-west-2 holds the KMS replica key and the replicated bucket. A failed call in any
# Region is a failure of the caller, never an empty result.
LOADTEST_REGIONS=(us-east-2 us-east-1 us-west-2)

# tagged_resources <tag-filter...>  -> JSON array of {arn,tags,region}; returns non-zero on any API error
tagged_resources() {
  local r out all='[]'
  for r in "${LOADTEST_REGIONS[@]}"; do
    out=$(aws resourcegroupstaggingapi get-resources --region "$r" --tag-filters "$@" \
      --query 'ResourceTagMappingList[].{arn:ResourceARN,tags:Tags}' --output json) || {
      echo "tagging API call failed in $r" >&2; return 1; }
    all=$(jq -c --arg r "$r" --argjson a "$all" '$a + map(. + {region:$r})' <<<"$out") || return 1
  done
  printf '%s\n' "$all"
}
