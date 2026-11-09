#!/usr/bin/env bash
# Run a command with every cloud credential and the OIDC request variables removed from ITS environment, so a
# dependency's install or build script cannot read them. Same idea as scripts/release/without-oidc.sh, widened to the
# AWS session this job exported after login. Usage: without-cloud.sh <command> [args]
set -euo pipefail
exec env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN "$@"
