#!/usr/bin/env bash
# Starts the fixture IdP, the REAL built API (apps/api/dist/src/main.js) and the built patient app (vite preview, /api proxied).
# usage: r12-launch.sh <repoRoot> <API_URL from r12-setup> <logdir>. Secrets are generated here per run and live only in the process env.
set -euo pipefail
ROOT=$1; DBURL=$2; LOGS=$3
WEB=127.0.0.1:4674
k() { openssl rand -hex 24; }
node "$ROOT/scripts/ci/local-idp.mjs" 9199 sub-ci-patient patient@example.org >"$LOGS/idp.json" 2>"$LOGS/idp.log" &
echo $! >"$LOGS/idp.pid"; sleep 2
E=$(cat "$LOGS/idp.json")
j() { node -e "console.log(JSON.parse(process.argv[1])[process.argv[2]])" "$E" "$1"; }
export EHR_INTEGRATIONS_HOST=integrations.localhost EHR_ENV=ci EHR_DEPLOYABLE=api EHR_DATABASE_URL="$DBURL" EHR_PORT=3510 EHR_MIN_CLIENT_RELEASE=1
export EHR_ORGANISATION_ID=00000000-0000-7000-8000-0000000000a1
SWEB=localhost:4675
node "$ROOT/docs/evidence/integration/M4/raw/int03-r8/ui/staff-idp.mjs" 9299 sub-ci-doctor doctor@example.com >"$LOGS/idp-staff.json" 2>"$LOGS/idp-staff.log" &
echo $! >"$LOGS/idp-staff.pid"; sleep 2
ES=$(cat "$LOGS/idp-staff.json")
js() { node -e "console.log(JSON.parse(process.argv[1])[process.argv[2]])" "$ES" "$1"; }
export EHR_STAFF_HOST=localhost EHR_PATIENT_HOST=127.0.0.1 EHR_ALLOWED_ORIGINS=http://$WEB,http://$SWEB
export EHR_OIDC_STATE_KEY=$(k) EHR_CSRF_KEY=$(k) EHR_RATE_KEY=$(k) EHR_MATCH_CHECK_KEY=$(k) EHR_CHECKIN_QR_KEY=$(k)
export EHR_PATIENT_OIDC_ISSUER=$(j issuer) EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT=$(j authorizationEndpoint) EHR_PATIENT_OIDC_TOKEN_ENDPOINT=$(j tokenEndpoint) EHR_PATIENT_OIDC_JWKS_URI=$(j jwksUri) EHR_PATIENT_OIDC_CLIENT_ID=$(j clientId)
export EHR_STAFF_OIDC_ISSUER=$(js issuer) EHR_STAFF_OIDC_AUTHORIZATION_ENDPOINT=$(js authorizationEndpoint) EHR_STAFF_OIDC_TOKEN_ENDPOINT=$(js tokenEndpoint) EHR_STAFF_OIDC_JWKS_URI=$(js jwksUri) EHR_STAFF_OIDC_CLIENT_ID=$(js clientId)
export EHR_STAFF_OIDC_CLIENT_SECRET=$(k) EHR_STAFF_OIDC_REDIRECT_URI=http://$SWEB/api/v1/auth/callback EHR_STAFF_WORKSPACE_DOMAIN=example.com
export EHR_PATIENT_OIDC_REDIRECT_URI=http://$WEB/api/v1/auth/callback
node "$ROOT/apps/api/dist/src/main.js" >"$LOGS/api-process.log" 2>&1 &
echo $! >"$LOGS/api.pid"
(cd "$ROOT/apps/patient" && API_ORIGIN=http://127.0.0.1:3510 exec pnpm exec vite preview --host 127.0.0.1 --port 4674 --strictPort) >"$LOGS/preview.log" 2>&1 &
echo $! >"$LOGS/web.pid"
(cd "$ROOT/apps/staff" && API_ORIGIN=http://localhost:3510 exec pnpm exec vite preview --host 127.0.0.1 --port 4675 --strictPort) >"$LOGS/staff-preview.log" 2>&1 &
echo $! >"$LOGS/staff-web.pid"
# the REAL worker process (apps/worker/dist/main.js): it must sync queue_api.task_type itself (R7-B1)
WDB=${DBURL/app_api/app_worker}
EHR_DEPLOYABLE=worker EHR_DATABASE_URL="$WDB" node "$ROOT/apps/worker/dist/main.js" >"$LOGS/worker-process.log" 2>&1 &
echo $! >"$LOGS/worker.pid"
sleep 4; curl -s -o /dev/null -w "readyz %{http_code}\n" http://127.0.0.1:3510/readyz
