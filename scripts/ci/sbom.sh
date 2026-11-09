#!/usr/bin/env bash
# SBOM: Syft, CycloneDX JSON, for the repository (lockfile-resolved packages). Missing, unparsable or
# component-less SBOM fails (DEVOPS-PLAN 5.1). Container/bundle SBOMs arrive with their build tickets.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tool syft
out="$(report_dir sbom)"
cd "$CI_ROOT"

syft --version >"$out/tool-version.txt"
SYFT_CHECK_FOR_APP_UPDATE=false syft scan "dir:$CI_ROOT" --config "$CI_ROOT/syft/syft.yaml" \
  --output "cyclonedx-json=$out/sbom.cdx.json" --quiet
require_report "$out/sbom.cdx.json"
node "$CI_ROOT/scripts/ci/check-sbom.mjs" "$out/sbom.cdx.json"
