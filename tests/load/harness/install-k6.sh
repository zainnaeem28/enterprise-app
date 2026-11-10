#!/usr/bin/env bash
# Install the pinned, unmodified k6 release and verify its checksum. Never builds k6 and
# never lets k6 provision an extension binary (an xk6 build would be a modified binary).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=k6.version
source "$here/k6.version"
dest="${1:?usage: install-k6.sh <dest-dir>}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/k6.tgz" "https://github.com/grafana/k6/releases/download/${version}/k6-${version}-linux-amd64.tar.gz"
echo "${linux_amd64_sha256}  $tmp/k6.tgz" | sha256sum -c -
mkdir -p "$dest"
tar -xzf "$tmp/k6.tgz" --strip-components=1 -C "$dest" --wildcards '*/k6'
"$dest/k6" version
echo "Run k6 only with K6_BINARY_PROVISIONING=false (see run-k6.sh)."
