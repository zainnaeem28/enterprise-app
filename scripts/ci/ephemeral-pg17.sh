#!/usr/bin/env bash
# Private, throwaway PostgreSQL 17 for one integration-db run (no root, no container).
#   eval "$(scripts/ci/ephemeral-pg17.sh start)"   # exports EHR_TEST_ADMIN_URL etc.
#   scripts/ci/ephemeral-pg17.sh stop              # stop and delete the data directory
# Binaries come from the pinned npm package embedded-postgres (PostgreSQL 17.x).
# State and the superuser password live in $EPG_HOME (default: a fresh mktemp dir,
# mode 0700), never in the repository. Port is picked free per run.
set -euo pipefail
PKG_VERSION="${EPG_PKG_VERSION:-17.11.0-beta.19}"
STATE="${EPG_STATE:-${TMPDIR:-/tmp}/ehr-epg-$(id -un)-${EPG_RUN_ID:-${PAPERCLIP_RUN_ID:-$PPID}}}"

start() {
  umask 077
  mkdir -p "$STATE"; cd "$STATE"
  [ -d node_modules/embedded-postgres ] || { npm init -y >/dev/null; npm install --no-audit --no-fund --save-exact "embedded-postgres@$PKG_VERSION" >&2; }
  bin=$(echo "$STATE"/node_modules/@embedded-postgres/*/native/bin)
  port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  pw=$(node -e 'console.log(require("crypto").randomBytes(18).toString("hex"))')
  printf '%s' "$pw" > pwfile
  "$bin/initdb" -D data -U postgres --auth=scram-sha-256 --pwfile=pwfile >initdb.log 2>&1
  "$bin/pg_ctl" -D data -l pg.log -w -o "-p $port -c listen_addresses=127.0.0.1 -c unix_socket_directories=$STATE -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200" start >&2
  echo "$port" > port
  echo "export EPG_STATE='$STATE'"
  echo "export EHR_TEST_ADMIN_URL='postgres://postgres:$pw@127.0.0.1:$port/postgres'"
}
stop() {
  [ -d "$STATE/data" ] || exit 0
  bin=$(echo "$STATE"/node_modules/@embedded-postgres/*/native/bin)
  "$bin/pg_ctl" -D "$STATE/data" -m fast stop >&2 || true
  rm -rf "$STATE/data" "$STATE/pwfile"
}
"${1:-}"
