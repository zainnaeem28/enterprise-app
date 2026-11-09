#!/usr/bin/env bash
# Install Chromium (headless shell) for Playwright without root, plus the shared libraries it needs, into $CI_TOOLS_DIR.
# Usage: scripts/ci/install-browser.sh ; then: eval "$(scripts/ci/install-browser.sh --env)"
# Library packages come from the Debian archive through apt (signature-verified by apt), unpacked with dpkg -x, not installed.
set -euo pipefail
t="${CI_TOOLS_DIR:-/tmp/ci-tools}"
if [ "${1:-}" = "--env" ]; then
  echo "export PLAYWRIGHT_BROWSERS_PATH=$t/browsers LD_LIBRARY_PATH=$t/root/usr/lib/x86_64-linux-gnu\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"; exit 0
fi
[ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || { echo "Linux x86_64 only" >&2; exit 1; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pwv="$(grep -m1 '"@playwright/test"' "$here/../../apps/staff/package.json" | sed 's/.*: *"\(.*\)".*/\1/')"   # same version the apps pin
mkdir -p "$t/pw" "$t/apt/state/lists/partial" "$t/apt/cache/archives/partial" "$t/debs" "$t/root"
( cd "$t/pw" && [ -f package.json ] || npm init -y >/dev/null; npm install --save-exact --ignore-scripts "@playwright/test@$pwv" >/dev/null )
( cd "$t/pw" && PLAYWRIGHT_BROWSERS_PATH="$t/browsers" npx playwright install chromium-headless-shell )
A="-o Dir::State=$t/apt/state -o Dir::Cache=$t/apt/cache -o Debug::NoLocking=1"
PK="libnspr4 libnss3 libglib2.0-0t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libdbus-1-3 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libxcb1 libxkbcommon0 libasound2t64 libatspi2.0-0t64"
apt-get $A update >/dev/null 2>&1 || true
L="$(apt-get $A -s install $PK | awk '/^Inst/{print $2}')"
( cd "$t/debs" && apt-get $A download $L >/dev/null && for f in *.deb; do dpkg -x "$f" "$t/root"; done )
echo "browser ready; run: eval \"\$($0 --env)\""
