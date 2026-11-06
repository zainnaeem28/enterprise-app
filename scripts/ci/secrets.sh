#!/usr/bin/env bash
# Secret scan (gitleaks). Pull request: the commits of the PR. Push to main: full history.
# Both: the working tree. Any finding fails; a missing report fails.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tool gitleaks
out="$(report_dir secrets)"
cfg="$CI_ROOT/gitleaks/gitleaks.toml"
cd "$CI_ROOT"

gitleaks version >"$out/tool-version.txt"

log_opts=()
if [ -n "${SECRETS_RANGE:-}" ]; then
  log_opts=(--log-opts "$SECRETS_RANGE")
elif [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
  log_opts=(--log-opts "${PR_BASE_SHA:?PR_BASE_SHA is required on pull_request}..${PR_HEAD_SHA:?PR_HEAD_SHA is required on pull_request}")
fi

echo "gitleaks git ${log_opts[*]:-(full history)}"
gitleaks git --config "$cfg" --redact --no-banner --exit-code 1 \
  --report-format json --report-path "$out/gitleaks-git.json" "${log_opts[@]}" "$CI_ROOT"
require_report "$out/gitleaks-git.json"

echo "gitleaks dir (working tree)"
gitleaks dir --config "$cfg" --redact --no-banner --exit-code 1 \
  --report-format json --report-path "$out/gitleaks-tree.json" "$CI_ROOT"
require_report "$out/gitleaks-tree.json"
echo "secret scan: no findings"
