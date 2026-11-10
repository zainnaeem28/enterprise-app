#!/usr/bin/env bash
# Start or stop the built API in a container (DEVOPS-PLAN 5.1: "the API container"). The repository has no Dockerfile yet
# (container-scan says so), so the container is the pinned Node image running the built workspace read-only; the same
# entry point (`apps/api/dist/src/main.js`) and configuration variables as the future image.
#   api-container.sh start [database]   waits for /readyz = 200;   api-container.sh stop   (writes the log)
. "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/ci/lib.sh"
NODE_IMAGE="${API_NODE_IMAGE:-node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9}"
NAME=ehr-api-ci
LOG_DIR="${API_LOG_DIR:-$REPORT_ROOT/api}"
case "${1:-}" in
  start)
    DB="${2:-ehr}"
    mkdir -p "$LOG_DIR"
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    # The API refuses to start without its full identity configuration (HEAAA-639 / QS-01: the container env predated it). Keys are
    # random per run and live only in this process and the container; endpoints are synthetic and never contacted by readiness.
    key() { openssl rand -hex 24; }
    idp=http://127.0.0.1:9199
    # Admin realm: a throwaway self-signed root made now (not the committed CI fixture root, so no fixture flag is needed) and a random AAGUID.
    root_pem="$(openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout /dev/null \
      -subj "/CN=ehr-ci-smoke-throwaway-root" -days 1 2>/dev/null)"
    aaguid="$(cat /proc/sys/kernel/random/uuid)"
    docker run -d --name "$NAME" --network host \
      -v "$CI_ROOT:/app:ro" -w /app \
      -e EHR_ENV=ci -e EHR_DEPLOYABLE=api \
      -e "EHR_DATABASE_URL=postgres://app_api@127.0.0.1:55432/$DB" \
      -e EHR_MIN_CLIENT_RELEASE=1 -e EHR_PORT=3000 \
      -e EHR_ORGANISATION_ID=00000000-0000-7000-8000-0000000000a1 \
      -e "EHR_ADMIN_ATTESTATION_ROOTS_PEM=$root_pem" -e "EHR_ADMIN_ALLOWED_AAGUIDS=$aaguid" -e "EHR_ADMIN_DECOY_KEY=$(key)$(key)" \
      -e EHR_STAFF_HOST=staff.ci.test -e EHR_PATIENT_HOST=localhost -e EHR_ALLOWED_ORIGINS=https://staff.ci.test \
      -e "EHR_OIDC_STATE_KEY=$(key)" -e "EHR_CSRF_KEY=$(key)" -e "EHR_RATE_KEY=$(key)" \
      -e "EHR_MATCH_CHECK_KEY=$(key)" -e "EHR_CHECKIN_QR_KEY=$(key)" \
      -e EHR_STAFF_OIDC_CLIENT_ID=ci-staff -e "EHR_STAFF_OIDC_CLIENT_SECRET=$(key)" \
      -e EHR_STAFF_OIDC_REDIRECT_URI=https://staff.ci.test/api/v1/auth/callback -e EHR_STAFF_WORKSPACE_DOMAIN=example.com \
      -e "EHR_PATIENT_OIDC_ISSUER=$idp" -e "EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT=$idp/authorize" \
      -e "EHR_PATIENT_OIDC_TOKEN_ENDPOINT=$idp/token" -e "EHR_PATIENT_OIDC_JWKS_URI=$idp/jwks" \
      -e EHR_PATIENT_OIDC_CLIENT_ID=ci-patient -e EHR_PATIENT_OIDC_REDIRECT_URI=http://localhost:3000/api/v1/auth/callback \
      "$NODE_IMAGE" node apps/api/dist/src/main.js >/dev/null
    for _ in $(seq 1 60); do
      [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/readyz)" = 200 ] && { echo "API ready (container $NAME, image $NODE_IMAGE)"; exit 0; }
      sleep 1
    done
    docker logs "$NAME" >"$LOG_DIR/api-container.log" 2>&1
    echo "::error::the API container did not become ready; log: $LOG_DIR/api-container.log" >&2
    tail -n 30 "$LOG_DIR/api-container.log" >&2
    exit 1
    ;;
  stop)
    mkdir -p "$LOG_DIR"
    docker logs "$NAME" >"$LOG_DIR/api-container.log" 2>&1 || true
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    ;;
  *) echo "usage: api-container.sh start [database] | stop" >&2; exit 2 ;;
esac
