#!/usr/bin/env bash
# Starts the fixture IdP, the REAL built API (apps/api/dist/src/main.js) and the built patient app (vite preview, /api proxied).
# usage: r10-launch.sh <repoRoot> <API_URL from r10-setup> <logdir>. Secrets are generated here per run and live only in the process env.
set -euo pipefail
ROOT=$1; DBURL=$2; LOGS=$3
WEB=127.0.0.1:4174
k() { openssl rand -hex 24; }
node "$ROOT/scripts/ci/local-idp.mjs" 9099 sub-ci-patient patient@example.org >"$LOGS/idp.json" 2>"$LOGS/idp.log" &
echo $! >"$LOGS/idp.pid"; sleep 2
E=$(cat "$LOGS/idp.json")
j() { node -e "console.log(JSON.parse(process.argv[1])[process.argv[2]])" "$E" "$1"; }
export EHR_ENV=ci EHR_DEPLOYABLE=api EHR_DATABASE_URL="$DBURL" EHR_PORT=3000 EHR_MIN_CLIENT_RELEASE=1
export EHR_ORGANISATION_ID=00000000-0000-7000-8000-0000000000a1
export EHR_STAFF_HOST=staff.invalid EHR_PATIENT_HOST=127.0.0.1 EHR_ALLOWED_ORIGINS=http://$WEB
export EHR_OIDC_STATE_KEY=$(k) EHR_CSRF_KEY=$(k) EHR_RATE_KEY=$(k) EHR_MATCH_CHECK_KEY=$(k) EHR_CHECKIN_QR_KEY=$(k)
for R in STAFF PATIENT; do
  export EHR_${R}_OIDC_ISSUER=$(j issuer) EHR_${R}_OIDC_AUTHORIZATION_ENDPOINT=$(j authorizationEndpoint) EHR_${R}_OIDC_TOKEN_ENDPOINT=$(j tokenEndpoint) EHR_${R}_OIDC_JWKS_URI=$(j jwksUri) EHR_${R}_OIDC_CLIENT_ID=$(j clientId)
done
export EHR_STAFF_OIDC_CLIENT_SECRET=$(k) EHR_STAFF_OIDC_REDIRECT_URI=http://staff.invalid/api/v1/auth/callback EHR_STAFF_WORKSPACE_DOMAIN=example.com
export EHR_PATIENT_OIDC_REDIRECT_URI=http://$WEB/api/v1/auth/callback
node "$ROOT/apps/api/dist/src/main.js" >"$LOGS/api-process.log" 2>&1 &
echo $! >"$LOGS/api.pid"
(cd "$ROOT/apps/patient" && API_ORIGIN=http://127.0.0.1:3000 exec pnpm exec vite preview --host 127.0.0.1 --port 4174 --strictPort) >"$LOGS/preview.log" 2>&1 &
echo $! >"$LOGS/web.pid"
# the REAL worker process (apps/worker/dist/main.js): it must sync queue_api.task_type itself (R7-B1)
WDB=${DBURL/app_api/app_worker}
EHR_DEPLOYABLE=worker EHR_DATABASE_URL="$WDB" node "$ROOT/apps/worker/dist/main.js" >"$LOGS/worker-process.log" 2>&1 &
echo $! >"$LOGS/worker.pid"
sleep 4; curl -s -o /dev/null -w "readyz %{http_code}\n" http://127.0.0.1:3000/readyz
