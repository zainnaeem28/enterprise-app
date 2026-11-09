#!/usr/bin/env bash
# Assume one GitHub-OIDC role (DEVOPS-PLAN 4.2, 7.1, 7.2). No action: the token is requested with curl and exchanged with
# `aws sts assume-role-with-web-identity`, then exported masked. The trust policy of the role (infra/modules/ci-trust)
# accepts only repo + environment + refs/heads/main + this workflow file while an unexpired approved-release record
# exists; AWS refuses everything else. Usage: aws-login.sh <role-arn> <session-name-prefix> [duration-seconds]
# Needs: id-token: write on the job, AWS_REGION. Nothing here is a secret; the credentials are masked and live in the job.
set -euo pipefail
role="${1:?role arn}"; prefix="${2:?session name prefix}"; duration="${3:-3600}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?id-token: write is not granted to this job}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?no OIDC request token}"
: "${AWS_REGION:?DEPLOY_AWS_REGION is not set}"
jwt="$(curl --fail --silent --show-error --retry 3 -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.amazonaws.com" | jq -er .value)"
echo "::add-mask::$jwt"
creds="$(aws sts assume-role-with-web-identity --role-arn "$role" \
  --role-session-name "${prefix}-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:-1}" --web-identity-token "$jwt" \
  --duration-seconds "$duration" --output json)"
for f in AccessKeyId SecretAccessKey SessionToken; do echo "::add-mask::$(jq -er ".Credentials.$f" <<<"$creds")"; done
{
  echo "AWS_ACCESS_KEY_ID=$(jq -er .Credentials.AccessKeyId <<<"$creds")"
  echo "AWS_SECRET_ACCESS_KEY=$(jq -er .Credentials.SecretAccessKey <<<"$creds")"
  echo "AWS_SESSION_TOKEN=$(jq -er .Credentials.SessionToken <<<"$creds")"
  echo "AWS_DEFAULT_REGION=$AWS_REGION"
} >>"${GITHUB_ENV:?}"
echo "assumed ${role##*/} (session expires $(jq -er .Credentials.Expiration <<<"$creds"))"
