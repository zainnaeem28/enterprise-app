#!/usr/bin/env bash
# Dependency scan: OSV-Scanner on the lockfile. Blocks on HIGH/CRITICAL with a fix, or unknown
# severity (DEVOPS-PLAN 5.1); osv/osv-scanner.toml holds dated, owned ignores.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tool osv-scanner
out="$(report_dir deps)"
cd "$CI_ROOT"
lockfile="${CI_LOCKFILE:-pnpm-lock.yaml}"
[ -s "$lockfile" ] || { echo "::error::lockfile $lockfile is missing or empty" >&2; exit 1; }

osv-scanner --version >"$out/tool-version.txt"
# osv-scanner exits 0 (clean) or 1 (vulnerabilities found); check-osv.mjs decides which findings
# block. Any other status is a tool error and fails the job.
rc=0
osv-scanner scan source --config "$CI_ROOT/osv/osv-scanner.toml" --lockfile "$lockfile" \
  --format json --output-file "$out/osv.json" || rc=$?
[ "$rc" -le 1 ] || { echo "::error::osv-scanner failed with status $rc" >&2; exit "$rc"; }
require_report "$out/osv.json"
node "$CI_ROOT/scripts/ci/check-osv.mjs" "$out/osv.json"
