#!/usr/bin/env bash
# Build every configured image ONCE, scan it, write its SBOM and record it (digest = local image id until pushed).
# Usage: build-images.sh <out_dir> <release_number> <git_sha>     (docker, trivy, syft on PATH; no cloud credentials here)
# Fails on: a required Dockerfile missing; an image Trivy HIGH/CRITICAL with a fix; root user; no HEALTHCHECK; empty SBOM.
. "$(dirname "${BASH_SOURCE[0]}")/../ci/lib.sh"
require_tool docker; require_tool trivy; require_tool syft; require_tool jq
out="$1"; n="$2"; sha="$3"
mkdir -p "$out/sbom" "$out/scan"
cfg="$CI_ROOT/scripts/release/release.config.json"
tag="r${n}.${sha:0:12}"
created="$(git -C "$CI_ROOT" show -s --format=%cI "$sha")"
export TRIVY_SKIP_VERSION_CHECK=true TRIVY_DISABLE_TELEMETRY=true SYFT_CHECK_FOR_APP_UPDATE=false
rm -f "$out/images.json"

while IFS=$'\t' read -r name dockerfile required; do
  if [ ! -f "$CI_ROOT/$dockerfile" ]; then
    [ "$required" = "false" ] && { echo "image $name: no $dockerfile, recorded as not-built"; continue; }
    echo "::error::required image $name: $dockerfile does not exist" >&2; exit 1
  fi
  local_tag="ehr-release/$name:$tag"
  docker build --file "$CI_ROOT/$dockerfile" --tag "$local_tag" \
    --label "org.opencontainers.image.revision=$sha" --label "org.opencontainers.image.version=$tag" \
    --label "org.opencontainers.image.created=$created" --label "org.opencontainers.image.source=${GITHUB_SERVER_URL:-local}/${GITHUB_REPOSITORY:-local}" \
    "$CI_ROOT"
  user="$(docker image inspect --format '{{.Config.User}}' "$local_tag")"
  case "$user" in ""|0|root|0:*|root:*) echo "::error::image $name runs as root" >&2; exit 1;; esac
  [ "$(docker image inspect --format '{{if .Config.Healthcheck}}yes{{end}}' "$local_tag")" = yes ] \
    || { echo "::error::image $name has no HEALTHCHECK" >&2; exit 1; }
  trivy image --config "$CI_ROOT/trivy/trivy.yaml" --ignorefile "$CI_ROOT/trivy/.trivyignore" \
    --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --format json --output "$out/scan/trivy-image-$name.json" "$local_tag"
  require_report "$out/scan/trivy-image-$name.json"
  syft scan "docker:$local_tag" --output "cyclonedx-json=$out/sbom/$name.cdx.json" --quiet
  require_report "$out/sbom/$name.cdx.json"
  node "$CI_ROOT/scripts/ci/check-sbom.mjs" "$out/sbom/$name.cdx.json"
  id="$(docker image inspect --format '{{.Id}}' "$local_tag")"
  node "$CI_ROOT/scripts/release/record-image.mjs" --file "$out/images.json" --name "$name" --digest "$id" \
    --sbom "$out/sbom/$name.cdx.json" --sbom-sha256 "$(sha256sum "$out/sbom/$name.cdx.json" | cut -d' ' -f1)"
  echo "image $name: built $local_tag ($id), scanned, SBOM written"
done < <(jq -r '.images[] | [.name, .dockerfile, (.required|tostring)] | @tsv' "$cfg")
[ -s "$out/images.json" ] || { echo "::error::no image was built" >&2; exit 1; }
