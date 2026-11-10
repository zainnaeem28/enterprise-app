#!/usr/bin/env bash
# Create the synthetic DR rehearsal stack in the STAGING account, run the rehearsal steps, and ALWAYS destroy it
# (DEVOPS-PLAN 10.4, 3.5; infra/modules/dr/rehearsal). Not a deployment: it applies a short-lived synthetic stack from a
# reviewed root, under the rehearsal role, and records PHI-free timings. It is run by the rehearsal workflow (a separate
# ticket owns that file) or by a person with the staging rehearsal role. It refuses production by account and Region.
#
#   dr-rehearsal.sh plan    --root DIR --var-file FILE
#   dr-rehearsal.sh run     --root DIR --var-file FILE --steps SCRIPT [--out DIR]   apply -> steps -> destroy (trap)
#   dr-rehearsal.sh destroy --root DIR --var-file FILE
#   dr-rehearsal.sh sweep   --root DIR --var-file FILE --max-age-hours 24           destroy when the stack is older
#
# Needs: STAGING_ACCOUNT_ID (12 digits), AWS credentials of the staging rehearsal role in the environment, `tofu`, `aws`, `jq`.
# The state backend is configured by the root (-backend-config file in BACKEND_CONFIG, never committed).
set -euo pipefail

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
fail() { echo "::error::$*" >&2; exit 1; }
now() { date -u +%s; }

cmd="${1:-}"; [ -n "$cmd" ] || usage; shift
root=""; varfile=""; steps=""; out="rehearsal-out"; max_age=24
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) root="${2:?}"; shift 2 ;;
    --var-file) varfile="${2:?}"; shift 2 ;;
    --steps) steps="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --max-age-hours) max_age="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done
[ -d "$root" ] || fail "--root must be a directory"
[ -f "$varfile" ] || fail "--var-file must be a file"
: "${STAGING_ACCOUNT_ID:?STAGING_ACCOUNT_ID is not set}"
[[ "$STAGING_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || fail "STAGING_ACCOUNT_ID is not a 12-digit account ID"
region="${REHEARSAL_REGION:-us-west-2}"
[ "$region" = "us-west-2" ] || fail "the rehearsal runs in us-west-2 only (got $region)"
case "$max_age" in '' | *[!0-9]*) fail "--max-age-hours must be a whole number" ;; esac
[ "$max_age" -ge 1 ] && [ "$max_age" -le 24 ] || fail "--max-age-hours must be 1..24"

# Account check before anything else: the identity in the environment must be the staging account.
caller="$(aws sts get-caller-identity --query Account --output text)"
[ "$caller" = "$STAGING_ACCOUNT_ID" ] || fail "credentials are for account ${caller:0:4}..., not the staging account: refusing"
export AWS_DEFAULT_REGION="$region" AWS_REGION="$region"

tofu_init() {
  local args=(-input=false)
  [ -z "${BACKEND_CONFIG:-}" ] || args+=("-backend-config=$BACKEND_CONFIG")
  tofu -chdir="$root" init "${args[@]}" >/dev/null
}

# Every var file must carry the expected account and Region; the module's guard then checks them against the caller.
check_vars() {
  grep -Eq "^expected_account_id[[:space:]]*=[[:space:]]*\"${STAGING_ACCOUNT_ID}\"" "$varfile" \
    || fail "var file does not name the staging account as expected_account_id"
}

timeline="$out/timeline.json"
mark() { # mark <event>: append {event, epoch} to the timeline (no data, only event names and seconds)
  mkdir -p "$out"
  jq -nc --arg e "$1" --argjson t "$(now)" '{event: $e, epoch: $t}' >>"$out/timeline.ndjson"
}

summarise() {
  [ -f "$out/timeline.ndjson" ] || return 0
  jq -s '
    def span($a; $b): if $a != null and $b != null then $b - $a else null end;
    (map({(.event): .epoch}) | add) as $t
    | {schema: "ehr.dr-rehearsal-timeline/v1",
       events: $t,
       seconds: {
         apply: span($t.apply_start; $t.apply_end),
         steps: span($t.steps_start; $t.steps_end),
         destroy: span($t.destroy_start; $t.destroy_end),
         total: span($t.apply_start; ($t.destroy_end // $t.apply_end))
       },
       note: "IaC apply and database restore legs only. RPO and RTO are NOT claimed from this file; the timed rehearsal of docs/runbooks/restore.md is the evidence (DEP-16)."}' \
    "$out/timeline.ndjson" >"$timeline"
  echo "timeline written to $timeline"
}

destroy_stack() {
  mark destroy_start
  tofu -chdir="$root" destroy -input=false -auto-approve -var-file="$(realpath "$varfile")" || return 1
  mark destroy_end
}

case "$cmd" in
  plan)
    check_vars; tofu_init; mkdir -p "$out"
    set +e
    tofu -chdir="$root" plan -input=false -var-file="$(realpath "$varfile")" -out="$(realpath "$out")/rehearsal.tfplan" 2>&1 | tee "$out/plan.txt"
    rc="${PIPESTATUS[0]}"
    set -e
    [ "$rc" -eq 0 ] || fail "plan failed"
    ;;
  run)
    [ -x "$steps" ] || fail "--steps must be an executable file (the rehearsal procedure, docs/runbooks/restore.md section 5)"
    check_vars; tofu_init; mkdir -p "$out"
    applied=0
    # The stack is destroyed on every exit path once apply has started, including failure and interruption.
    cleanup() {
      local rc=$?
      trap - EXIT INT TERM
      if [ "$applied" -eq 1 ]; then
        if ! destroy_stack; then echo "::error::DESTROY FAILED: the rehearsal stack may still exist; run 'destroy' again and check the staging account" >&2; rc=1; fi
      fi
      summarise
      exit "$rc"
    }
    trap cleanup EXIT INT TERM
    mark apply_start; applied=1
    tofu -chdir="$root" apply -input=false -auto-approve -var-file="$(realpath "$varfile")"
    mark apply_end
    mark steps_start
    "$steps" "$out"
    mark steps_end
    ;;
  destroy)
    check_vars; tofu_init; mkdir -p "$out"; destroy_stack; summarise
    ;;
  sweep)
    check_vars; tofu_init; mkdir -p "$out"
    expires="$(tofu -chdir="$root" output -raw expires_at 2>/dev/null || true)"
    if [ -z "$expires" ]; then echo "no rehearsal stack in this state: nothing to sweep"; exit 0; fi
    exp_epoch="$(date -u -d "$expires" +%s)" || fail "expires_at in the state is not a timestamp"
    limit=$(( max_age * 3600 ))
    if [ "$(now)" -ge "$exp_epoch" ] || [ $(( exp_epoch - $(now) )) -gt "$limit" ]; then
      echo "stack expired (or expiry later than ${max_age} h away, which the rules do not allow): destroying"
      destroy_stack; summarise
    else
      echo "stack has not expired ($expires)"
    fi
    ;;
  *) usage ;;
esac
