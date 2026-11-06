#!/usr/bin/env bash
# SAST: Semgrep CE with the pinned, committed ruleset (semgrep/rules). No registry fetch, no metrics,
# no account. Fails on any ERROR finding, any finding under a sensitive path, a parse/scan error, or
# when zero files were scanned (check-semgrep.mjs).
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tool semgrep
out="$(report_dir sast)"
cd "$CI_ROOT"

semgrep --version >"$out/tool-version.txt"
semgrep scan --config semgrep/rules --metrics off --disable-version-check --quiet \
  --json --output "$out/semgrep.json" --sarif-output "$out/semgrep.sarif" \
  --exclude node_modules --exclude dist --exclude reports --exclude semgrep/rules \
  --exclude docs --exclude pnpm-lock.yaml .
require_report "$out/semgrep.json"
node "$CI_ROOT/scripts/ci/check-semgrep.mjs" "$out/semgrep.json" "$CI_ROOT/semgrep/sensitive-paths.txt"
