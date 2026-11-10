# Load-test workflow (DO-11 follow-up B, HEAAA-589)

Files: `.github/workflows/loadtest-run.yml` (create, test, always-run teardown) and `.github/workflows/loadtest-reaper.yml`
(scheduled TTL reaper). They use `tests/load/harness/{guard-cost,seed,teardown,reap-expired}.sh` and `infra/modules/loadtest/root`.
**Authored and linted only. Nothing is applied, no account is configured, nothing is purchased.**

## Behaviour

- `loadtest-run`: `workflow_dispatch` only (no push or pull_request trigger). Inputs: `run_id`, `ttl_hours` (1-24), `run_cost_ceiling_usd`,
  `confirm_apply` (must repeat `run_id`). Order: validate inputs, cost guard, fetch variables, init + provider lock, plan,
  `check-equivalence.mjs` against production's profile (a difference fails the run), apply, seed, cost guard, scenarios (QA-07 adds them), cost guard,
  `teardown.sh` with `if: always()` (also after failed apply or failed tests; verifies no resource tagged with the RunId remains in the three Regions).
- Concurrency group `loadtest-stack` (shared by both workflows), `cancel-in-progress: false`, so there are never two stacks and a cancel cannot skip teardown.
- `loadtest-reaper`: cron every 2 h (and manual). `reap-expired.sh` lists resources past their `ttl` tag; each run id found is destroyed with `teardown.sh`. Any API error fails the job.

## Credentials and permissions

- Workflow permissions default to none; the job adds `id-token: write` and `contents: read`. Actions are pinned to commit SHAs.
- AWS access is OIDC only (`aws-actions/configure-aws-credentials`). No long-lived keys. The origin-verify secret is generated per run and masked.
- Inputs reach the shell only through `env`; they are validated by regex before use.
- GitHub environment **`loadtest`**: must be configured with required reviewers (the existing approval path) so that apply/spend waits for approval; this
  task grants none. Environment **`loadtest-reaper`**: no reviewers (a leak must be cleaned up unattended); its role must be destroy/read-only.
  The role trust policies must restrict `sub` to `repo:<org>/<repo>:environment:loadtest` and `...:environment:loadtest-reaper`.

## Configuration still required (blockers for a real run)

Environment variables (not secrets): `LOADTEST_AWS_ROLE_ARN`, `LOADTEST_REAPER_AWS_ROLE_ARN`, `LOADTEST_STATE_BUCKET`
(S3 state, versioned/encrypted, one key per run), `LOADTEST_TFVARS_S3_URI` (JSON with the non-secret module inputs: certificates, hosts, log
destinations, role ARNs, digest-pinned images, seeder, budget emails), `LOADTEST_PROD_PROFILE_S3_URI` (production plan `profile` output).
Also: the roles themselves and the state bucket (infrastructure not created here), `RunId` as an active cost-allocation tag, and HEAAA-588 for a plan-clean module.

## Known limits

- Not executed: the workflows have not run. Checked with actionlint 1.7.12 (clean) and a YAML parse plus `bash -n` of every `run` script. yamllint and shellcheck were not available in the authoring sandbox.
- The state backend is injected at run time as `backend_override.tf` because the thin root has no backend.
- Cost Explorer lags up to a day; the per-run budget alarm is the early signal (see `infra/modules/loadtest/README.md`).
- The reaper destroys with placeholder values for variables that only satisfy validation; destroy relies on state. Untested against real state.
- No QA-07 scenarios yet; the "Run load scenarios" step is a placeholder.
- Not-configured behaviour (HEAAA-712): both workflows start with a `gate` job that checks the variables above (the reaper also needs `LOADTEST_REAPER_ENABLED` = `'true'`). When any is absent the gate prints a `not configured` notice and a job summary saying that nothing was created, seeded or measured, and the real job is skipped. A skipped run is never a pass for a load test; it makes no AWS call.
- Tooling follows the other workflows: OpenTofu is installed from the pinned, sha256-verified release (no third-party action), AWS credentials come from `scripts/deploy/aws-login.sh` (OIDC), and only allow-listed actions are used. The tofu version is therefore fixed in the workflow, not a repository variable.
- Interfaces (HEAAA-712): the module is updated to the INT04-F37 compute/edge interfaces; it takes an extra `integrations_certificate_arn` (ACM, us-east-1) and `waf_log_group_arn_integrations` (replaces `waf_log_group_arn_regional`). Add both to the `LOADTEST_TFVARS_S3_URI` JSON.
- Set `LOADTEST_REAPER_ENABLED` when the loadtest stack is applied (G3).
