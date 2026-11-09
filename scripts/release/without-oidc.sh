#!/usr/bin/env bash
# Run a command with the job's OIDC request variables removed from ITS environment (and so from every child, e.g. a
# dependency's install script). A step-level `env: ACTIONS_ID_TOKEN_REQUEST_TOKEN: ''` does NOT do this: the runner
# re-injects the token (probe in the dry-run of HEAAA-89: 4350 characters visible). Usage: without-oidc.sh <command> [args]
set -euo pipefail
exec env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN "$@"
