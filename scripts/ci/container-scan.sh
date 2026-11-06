#!/usr/bin/env bash
# Container scan: Trivy config scan of Dockerfiles/Terraform (always) and Trivy image scan of every
# image built from a Dockerfile in the repository. When the repository has no Dockerfile the image
# scan has nothing to scan: that is written to the report and the job summary as NOT PERFORMED, and
# is never reported as an image pass. Blocks: HIGH/CRITICAL with a fix, root user, missing HEALTHCHECK.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tool trivy
out="$(report_dir container-scan)"
cd "$CI_ROOT"

trivy --version >"$out/tool-version.txt"
export TRIVY_SKIP_VERSION_CHECK=true TRIVY_DISABLE_TELEMETRY=true

trivy config --config "$CI_ROOT/trivy/trivy.yaml" --ignorefile "$CI_ROOT/trivy/.trivyignore" \
  --format json --output "$out/trivy-config.json" "$CI_ROOT"
require_report "$out/trivy-config.json"
node "$CI_ROOT/scripts/ci/check-trivy-config.mjs" "$out/trivy-config.json"

mapfile -t dockerfiles < <(git ls-files -z '*Dockerfile' '*Dockerfile.*' '*.dockerfile' | tr '\0' '\n' | sort)
if [ "${#dockerfiles[@]}" -eq 0 ]; then
  msg="IMAGE SCAN NOT PERFORMED: the repository contains no Dockerfile yet. Config scan ran; no image was scanned."
  echo "$msg" | tee "$out/IMAGE-SCAN-NOT-PERFORMED.txt"
  echo "::notice title=container-scan::$msg"
  exit 0
fi

require_tool docker
for df in "${dockerfiles[@]}"; do
  name="$(echo "$df" | tr '/.' '--' | tr 'A-Z' 'a-z')"
  tag="ci-scan/${name}:${GITHUB_SHA:-local}"
  docker build --file "$df" --tag "$tag" "$(dirname "$df")"
  trivy image --config "$CI_ROOT/trivy/trivy.yaml" --ignorefile "$CI_ROOT/trivy/.trivyignore" \
    --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
    --format json --output "$out/trivy-image-${name}.json" "$tag"
  require_report "$out/trivy-image-${name}.json"
done
echo "container scan: ${#dockerfiles[@]} image(s) scanned, no blocking findings"
