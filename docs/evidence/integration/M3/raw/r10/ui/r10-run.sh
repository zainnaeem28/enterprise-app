#!/usr/bin/env bash
# One full r10 UI run: stop old servers, fresh database, launch IdP + API + worker + patient app, run the journeys. usage: r10-run.sh <repoRoot> <uiDir>
set -u
ROOT=$1; U=$2
for f in api web idp worker; do [ -f "$U/$f.pid" ] && kill "$(cat "$U/$f.pid")" 2>/dev/null; done; sleep 2
node "$U/r10-setup.mjs" "$ROOT" 2>&1 | tail -1 >/tmp/r10setup.txt
API=$(grep ^API_URL /tmp/r10setup.txt | cut -d= -f2)
bash "$U/r10-launch.sh" "$ROOT" "$API" "$U" 2>&1 | tail -2
export PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers LD_LIBRARY_PATH=/tmp/fe04-libs/usr/lib/x86_64-linux-gnu FONTCONFIG_FILE=/tmp/fe04-libs/fonts.conf
node "$U/r10-journey.mjs" "$ROOT" "$U" 2>&1 | grep -v "availability/search" | tee "$U/journey-run.txt"
