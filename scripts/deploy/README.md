# Deploy workflows (DO-06, HEAAA-97)

Consumer side of the release contract that `scripts/release` (DO-05) produces. Source: DEVOPS-PLAN 4.2, 6.2, 7.2, 7.4, 7.5, 8, 9, 15.3; DPR-33, DPR-35, DPR-37..39.

**Authored disabled. Nothing here has run against any environment.** No secret, account id or ARN is in any workflow; all environment values are GitHub _environment variables_ (names below). Each workflow starts with an `enabled` job that fails unless a person sets `DEPLOY_<ENV>_ENABLED=true` _and_ the run is on `refs/heads/main`; every other job `needs` it. A role is additionally denied by AWS until the matching approved-release record is applied by a human (ci-trust, DO-04).

## Workflows

| File                                      | Trigger                  | Role(s) assumed (OIDC, per job)                                                                       | Record read                              |
| ----------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `.github/workflows/deploy-production.yml` | `workflow_dispatch` only | `gh-deploy-production` (deploy), `gh-observe-production` (observe), `gh-recover-production` (recover) | `/approved/release`, `/approved/recover` |
| `.github/workflows/deploy-staging.yml`    | `workflow_dispatch` only | `gh-deploy-staging`                                                                                   | `/approved/staging-release`              |
| `.github/workflows/deploy-marketing.yml`  | `workflow_dispatch` only | `gh-deploy-marketing-<env>`                                                                           | `/approved/marketing-<env>`              |

Production: concurrency group `production-release`, `cancel-in-progress: false`; sequence verify → backup freshness → (snapshot if the release adds a migration) → migrate → worker → api → portal switch → smoke → **observe (read-only job)** → recover (only if rollout started and a prior job failed, only if the `recover` record allows it). `staging-release` and `marketing-release` groups are separate (DPR-12: marketing is not part of the product sequence).

## Verification chain (first thing every job does)

`verify-release.mjs` refuses unless **all** hold: the manifest bytes hash to the dispatch input; the manifest is valid, `mode: publish`, images signed with SBOM + provenance and referenced by digest; the record read from the account has `state: approved`, the same `environment`, `manifest_hash`, every required action in `permitted_actions` (`migrate` is required exactly when the release adds a migration), a `g3_reference`, an approver, and is inside `not_before`/`expires`; the rollback target is present unless `first_release` (15.3); `min_client_release` = previous released number, or the release's own number for the first release (`resolveMinClientRelease`, DO-05). A migration file edited after release is refused. The same script runs offline in `dry-run.mjs`.

## Scripts

`verify-release`, `resolve-taskdefs` (exactly one ACTIVE revision per family whose image equals the manifest digest; the migration task definition is pinned by ARN; **no workflow registers a task definition**, 7.5), `backup-gate` (freshness, restore point, manual snapshot), `run-migration` (one-off task, no `--overrides`, aborts on non-zero), `rollout` (start gate api ≤ 6 / worker ≤ 3 except rollback; worker then api; waits for steady state), `portal-switch` (entry document + `release.json` only, invalidate only those), `smoke` (anonymous `/healthz`, `/readyz`, `release.json`), `observe` (9.2 thresholds, `DEPLOY_READ_ONLY=1`), `set-release-config` (integer parameters only, never `/approved/*`), `staging-floor` (DPR-33), `publish-marketing`, `aws-login.sh` (OIDC without an action), `without-cloud.sh` (strips AWS and OIDC variables from build commands), `policy-scan.mjs`, `dry-run.mjs`.

## Environment variables (GitHub environment `production` / `staging` / `marketing-*`; none is a secret)

`DEPLOY_AWS_REGION`, `DEPLOY_ROLE_ARN`, `DEPLOY_OBSERVE_ROLE_ARN`, `DEPLOY_RECOVER_ROLE_ARN`, `DEPLOY_CLUSTER`, `DEPLOY_API_SERVICE`, `DEPLOY_WORKER_SERVICE`, `DEPLOY_API_FAMILY`, `DEPLOY_WORKER_FAMILY`, `DEPLOY_MIGRATION_TASKDEF_ARN` (pinned, DPR-39), `DEPLOY_SUBNETS`, `DEPLOY_SECURITY_GROUPS`, `DEPLOY_DB_INSTANCE`, `DEPLOY_BACKUP_MAX_AGE_MINUTES`, `DEPLOY_SNAPSHOT_TIMEOUT_MINUTES`, `DEPLOY_MIN_CLIENT_PARAM`, `DEPLOY_PORTAL_BUCKET`, `DEPLOY_PORTAL_NAME`, `DEPLOY_PORTAL_DISTRIBUTION`, `DEPLOY_API_URL`, `DEPLOY_PORTAL_URL`, `DEPLOY_LB`, `DEPLOY_TG`, `DEPLOY_ALARM_PREFIX`, `DEPLOY_OBSERVE_MINUTES`; marketing: `DEPLOY_SITE_FILTER`, `DEPLOY_SITE_DIR`, `DEPLOY_SITE_BUCKET`, `DEPLOY_SITE_DISTRIBUTION`. Repository variables: `DEPLOY_PRODUCTION_ENABLED`, `DEPLOY_STAGING_ENABLED`, `DEPLOY_MARKETING_ENABLED`.

## Conditions before staging is enabled (C-14)

DPR-37 (staging Terraform apply role `gh-tf-staging`), DPR-38 (named creator of the loadtest/bootstrap/ENV-DR stacks: `gh-rehearsal-staging`) and DPR-39 (migration task definition pinned by ARN, gate-check read actions and the `gh-nightly-staging` row) are authored in `infra/modules/ci-trust` (DO-04). They are _authored_, not applied or proven; the staging proofs of 7.5 must pass before any `DEPLOY_*_ENABLED` is set. The plan text correction is routed to the Solution Architect Reviewer (not this ticket).

## Permissions this workflow needs (R1-GAP-5, HEAAA-785)

Authored in `infra/modules/ci-trust` (`policies.tf`, new `refs` fields in `variables.tf`); proved only by `tofu validate` and `tofu test` with mock providers (rendered policy, not AWS behaviour). Every grant is dropped while its ref is unset, so nothing is granted until the production/staging roots pass the ARNs. The roots (`production_refs`, `staging` refs) must be given: `release_config_parameter_arns`, `db_instance_arns`, `portal_bucket_arn`, `portal_distribution_arns`, `release_store_read_arn`.

1. **Closed (IaC).** `gh-deploy-staging` / `gh-deploy-production`: `ssm:GetParameter` and `ssm:PutParameter` on `refs.release_config_parameter_arns` only (never `/approved/*`, which stays an explicit deny). The parameters are `String`, so no KMS grant is needed.
2. **Closed (IaC).** `gh-deploy-production`: `rds:DescribeDBInstances` on `refs.db_instance_arns`; `rds:DescribeDBSnapshots` on `snapshot:release-*-pre-migration`; `rds:CreateDBSnapshot` only when the record permits `migrate`.
3. **Closed (IaC).** `gh-deploy-*` and `gh-recover-production`: `s3:PutObject` on `<portal bucket>/live/*`, `s3:GetObject` on `releases/*` (portal bucket and release store), `cloudfront:CreateInvalidation` on `refs.portal_distribution_arns`.
4. **Partly closed.** `s3:GetObject` on `<release store>/manifests/*` is granted when `refs.release_store_read_arn` is set, so a rollback target older than 30 days could be read. **Remaining:** the workflows still use `gh run download` (workflow files are outside this ticket's paths), and the release store lives in another account, so its bucket policy must also allow the role (not in these paths). Until both are done, artifact retention (a repository setting) still limits the rollback target.
5. **Partly closed.** `portal-switch.mjs` takes `--source-bucket` and copies `releases/<sha>/…` from the release store into `live/<portal>/…` of the portal bucket (dry-run test in `test/cli.test.mjs`). **Remaining:** `deploy-production.yml` and `deploy-staging.yml` do not pass `--source-bucket` or a variable for it yet (workflow files are outside this ticket's paths: a follow-up that adds `DEPLOY_RELEASE_STORE_BUCKET`), so `portal-switch` still fails on a missing source key until then.

## Limits

Not executed against AWS or GitHub environments: login, `ssm`, `ecs run-task`/`update-service`, `rds`, CloudWatch queries, `s3`/CloudFront, `gh run download`, environment-scoped variables, concurrency queueing. Verified only offline (unit tests with stubs, the stub-manifest dry run, `actionlint` without shellcheck, hygiene and policy scans). Metric names for audit-write failures, booking invariant, alert latency and queue age are taken from the alarms of DEVOPS-PLAN 11.3 (`describe-alarms` by prefix); the alarms themselves are not yet defined in IaC. The 9.2 thresholds are the plan's starting values; the G3 package sets final ones. `e2e` and the ZAP baseline are not run by `deploy-staging.yml` (nightly/staging suites, other tickets). Staging `infra` plan/apply belongs to `infra.yml` (DO-08).

Local checks: `node --test scripts/deploy/test/*.test.mjs`, `node scripts/deploy/policy-scan.mjs`, `node scripts/ci/check-workflow-hygiene.mjs`, `actionlint .github/workflows/*.yml`, `node scripts/deploy/dry-run.mjs --manifest m.json --record r.json`.

## Marketing: what is published

`deploy-marketing.yml` rebuilds the site from the manifest's `git_sha` at deploy time (`pnpm build`), so the published
bytes are not an attested artifact digest as they are for the portals. Acceptable for a site without PHI; the G3
package for marketing must say so.

## Observation: exit codes

`observe.mjs` exits 2 and writes `breach=true` only when an abort threshold is reached; that is the only signal the
`recover` job accepts (still gated by the human-approved recover record). Credential, transport or argument errors exit
1 and leave the decision to a person. The window is limited to 270 minutes (the 18000 s role session).
