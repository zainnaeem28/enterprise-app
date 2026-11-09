#!/usr/bin/env bash
# Install pinned scanner binaries listed in scripts/ci/tools.lock after verifying their sha256.
# Usage: scripts/ci/install-tools.sh <tool> [<tool>...]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tools_dir="${CI_TOOLS_DIR:-${RUNNER_TEMP:-/tmp}/ci-tools}"
lock="${TOOLS_LOCK:-$here/tools.lock}"
mkdir -p "$tools_dir/bin" "$tools_dir/dl"

[ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || {
  echo "::error::tools.lock pins Linux x86_64 binaries only" >&2
  exit 1
}
[ "$#" -gt 0 ] || { echo "usage: $0 <tool>..." >&2; exit 2; }

for tool in "$@"; do
  line="$(grep -E "^${tool} " "$lock" || true)"
  [ -n "$line" ] || { echo "::error::$tool is not in $lock" >&2; exit 1; }
  read -r _ version sha url <<<"$line"
  file="$tools_dir/dl/$(basename "$url")"
  curl --fail --silent --show-error --location --retry 3 --output "$file" "$url"
  actual="$(sha256sum "$file" | cut -d' ' -f1)"
  if [ "$actual" != "$sha" ]; then
    echo "::error::sha256 mismatch for $tool $version: expected $sha, got $actual" >&2
    exit 1
  fi
  case "$file" in
    *.tar.gz) tar -xzf "$file" -C "$tools_dir/bin" "$tool" ;;
    *) install -m 0755 "$file" "$tools_dir/bin/$tool" ;;
  esac
  chmod +x "$tools_dir/bin/$tool"
  echo "installed $tool $version (sha256 $sha verified)"
done
