#!/usr/bin/env bash
# One full r12 UI run: stop old servers, fresh database, launch IdP + API + worker + patient app, run the journeys. usage: r12-run.sh <repoRoot> <uiDir>
set -u
ROOT=$1; U=$2
for f in api web idp worker; do [ -f "$U/$f.pid" ] && kill "$(cat "$U/$f.pid")" 2>/dev/null; done; sleep 2
node "$U/r12-setup.mjs" "$ROOT" 2>&1 | tail -1 >/tmp/r12setup.txt
node "$U/r12-tcount.mjs" "$ROOT" "templates after setup, BEFORE API boot (negative control: must be zero)" | tee "$U/template-counts.txt"
API=$(grep ^API_URL /tmp/r12setup.txt | cut -d= -f2)
bash "$U/r12-launch.sh" "$ROOT" "$API" "$U" 2>&1 | tail -2
node "$U/r12-tcount.mjs" "$ROOT" "templates after API boot (provisioned by main.ts)" | tee -a "$U/template-counts.txt"
export PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers LD_LIBRARY_PATH=/tmp/fe04-libs/usr/lib/x86_64-linux-gnu FONTCONFIG_FILE=/tmp/fe04-libs/fonts.conf
node "$U/r12-journey.mjs" "$ROOT" "$U" 2>&1 | grep -v "availability/search" | tee "$U/journey-run.txt"
