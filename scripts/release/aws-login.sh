#!/usr/bin/env bash
# Assume the gh-build role with the job's GitHub OIDC token (DEVOPS-PLAN 4.2, 7.1). No action is used: the token is
# requested with curl and exchanged with `aws sts assume-role-with-web-identity`, then exported masked.
# Needs: ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN (job permission id-token: write), RELEASE_BUILD_ROLE_ARN, AWS_REGION.
# The trust policy accepts only repo + environment 'build' + refs/heads/main + this workflow file while an unexpired
# `ci` approved-release record exists; anything else is refused by AWS, not by this script.
set -euo pipefail
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?id-token: write is not granted to this job}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?no OIDC request token}"
: "${RELEASE_BUILD_ROLE_ARN:?repository variable RELEASE_BUILD_ROLE_ARN is not set}"
: "${AWS_REGION:?repository variable RELEASE_AWS_REGION is not set}"
jwt="$(curl --fail --silent --show-error --retry 3 -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.amazonaws.com" | jq -er .value)"
echo "::add-mask::$jwt"
creds="$(aws sts assume-role-with-web-identity --role-arn "$RELEASE_BUILD_ROLE_ARN" \
  --role-session-name "gh-build-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:-1}" --web-identity-token "$jwt" \
  --duration-seconds 3600 --output json)"
for f in AccessKeyId SecretAccessKey SessionToken; do echo "::add-mask::$(jq -er ".Credentials.$f" <<<"$creds")"; done
{
  echo "AWS_ACCESS_KEY_ID=$(jq -er .Credentials.AccessKeyId <<<"$creds")"
  echo "AWS_SECRET_ACCESS_KEY=$(jq -er .Credentials.SecretAccessKey <<<"$creds")"
  echo "AWS_SESSION_TOKEN=$(jq -er .Credentials.SessionToken <<<"$creds")"
  echo "AWS_DEFAULT_REGION=$AWS_REGION"
} >>"${GITHUB_ENV:?}"
echo "assumed gh-build (session expires $(jq -er .Credentials.Expiration <<<"$creds"))"
