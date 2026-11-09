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

# semgrep is a Python package: pip (sha256 verified from tools.lock) installs the hash-locked set
# scripts/ci/semgrep-requirements.txt into an isolated --target dir; no venv/ensurepip required.
install_semgrep() {
  local pline pver psha purl pipwhl
  pline="$(grep -E '^pip ' "$lock" || true)"
  [ -n "$pline" ] || { echo "::error::pip is not in $lock" >&2; exit 1; }
  read -r _ pver psha purl <<<"$pline"
  pipwhl="$tools_dir/dl/pip-$pver-py3-none-any.whl"
  curl --fail --silent --show-error --location --retry 3 --output "$pipwhl" "$purl"
  [ "$(sha256sum "$pipwhl" | cut -d' ' -f1)" = "$psha" ] || { echo "::error::sha256 mismatch for pip $pver" >&2; exit 1; }
  python3 -c 'import sys; sys.exit(0 if sys.version_info[:2]==(3,13) else 1)' || {
    echo "::error::semgrep install needs CPython 3.13 (wheels in semgrep-requirements.txt are cp313)" >&2
    exit 1
  }
  rm -rf "$tools_dir/semgrep-site"
  python3 -I "$pipwhl/pip" install --disable-pip-version-check --no-input --only-binary=:all: --require-hashes \
    --target "$tools_dir/semgrep-site" -r "$here/semgrep-requirements.txt" >"$tools_dir/dl/semgrep-pip.log" 2>&1 \
    || { cat "$tools_dir/dl/semgrep-pip.log" >&2; exit 1; }
  cat >"$tools_dir/bin/semgrep" <<WRAP
#!/usr/bin/env bash
export PYTHONPATH="$tools_dir/semgrep-site\${PYTHONPATH:+:\$PYTHONPATH}"
export SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0
exec python3 -I -c 'import sys; sys.path.insert(0, "$tools_dir/semgrep-site"); sys.argv[0]="semgrep"; from semgrep.console_scripts.pysemgrep import main; sys.exit(main())' "\$@"
WRAP
  chmod +x "$tools_dir/bin/semgrep"
}

for tool in "$@"; do
  if [ "$tool" = semgrep ]; then
    read -r _ version sha _ < <(grep -E '^semgrep ' "$lock" || echo "x - - -")
    [ "$version" != "-" ] || { echo "::error::semgrep is not in $lock" >&2; exit 1; }
    install_semgrep
    grep -q "^semgrep==$version " "$here/semgrep-requirements.txt" && grep -q "$sha" "$here/semgrep-requirements.txt" \
      || { echo "::error::semgrep-requirements.txt does not match tools.lock semgrep $version" >&2; exit 1; }
    echo "installed semgrep $version (hash-locked wheel set, semgrep wheel sha256 $sha)"
    continue
  fi
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
