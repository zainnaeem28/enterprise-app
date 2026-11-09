# Restore, PITR and DR rehearsal automation (DO-08, HEAAA-111)

Authored, not applied, not run against AWS. Procedure and decisions: `docs/runbooks/restore.md`. Design: DEVOPS-PLAN 10.1-10.5, ARCHITECTURE 9.4. RPO 15 min and RTO 4 h are **targets**, not claims.

## Layout

| Path | What it is |
| --- | --- |
| `.github/workflows/restore-test.yml` | Monthly restore test, authored disabled (`RESTORE_TEST_ENABLED`). API calls only; the runner never touches the restored data |
| `verify-record.mjs`, `lib/record.mjs` | Checks the `restore-test` approved record (15.3) |
| `start-restore.mjs`, `lib/plan.mjs` | Chooses the restore point (latest, or random within 7 days) and starts the restore into the pinned boundary |
| `run-checks.mjs` | Starts the pinned task with no overrides and waits (own deadline) |
| `fetch-result.mjs`, `lib/result.mjs` | Fetches and strictly validates the PHI-free result; refuses anything outside the closed schema |
| `teardown.mjs` | Deletes the run's target, or every `rt-*` target older than 24 h |
| `consecutive-failures.mjs` | Two consecutive scheduled failures stop releases |
| `task/` | The in-VPC task: `run.mjs` (orchestration, injected I/O), `checks.mjs`, `restore-check.mjs` (entry), `tables.json` (proposal) |
| `lib/aws.mjs` | Allow-list in front of the AWS CLI: no IAM, no task-definition registration, no overrides, `rt-` targets only |
| `dr-rehearsal.sh` | Create / run / destroy / sweep the synthetic DR rehearsal stack in staging |
| `../../infra/modules/dr/restore-boundary` | The isolated `restore-test` VPC, endpoints and policies, key, roles, pinned task definition |
| `../../infra/modules/dr/rehearsal` (+ `root/`) | The `ENV-DR` stack, guarded to the staging account, `us-west-2` and synthetic snapshots |

## Environment `restore-test` variables

`RESTORE_AWS_REGION`, `RESTORE_ROLE_ARN`, `RESTORE_SOURCE_DB`, `RESTORE_SUBNET_GROUP`, `RESTORE_TARGET_SG`, `RESTORE_KMS_KEY_ARN`, `RESTORE_INSTANCE_CLASS`, `RESTORE_CLUSTER`, `RESTORE_TASK_DEFINITION_ARN`, `RESTORE_SUBNETS` (comma separated), `RESTORE_TASK_SG`, `RESTORE_RESULT_BUCKET`; and the repository variable `RESTORE_TEST_ENABLED`. None is a secret. The boundary module's outputs are the values for the first group.

## Checks (recorded in the DO-08 evidence comment)

```
node --test 'scripts/restore/test/*.test.mjs'
shellcheck -x scripts/restore/dr-rehearsal.sh infra/modules/dr/restore-boundary/tests/forbidden-resources.sh
actionlint .github/workflows/restore-test.yml && node scripts/ci/check-workflow-hygiene.mjs
for m in restore-boundary rehearsal; do (cd infra/modules/dr/$m && tofu fmt -check -recursive && tofu init -backend=false && tofu validate && tflint && tofu test -verbose); done
(cd infra/modules/dr/rehearsal/root && tofu init -backend=false && tofu validate)
infra/modules/dr/restore-boundary/tests/forbidden-resources.sh
trivy config --config trivy/trivy.yaml infra/modules/dr/<module>
```

`tofu test -verbose` prints the mock-provider plan; that is the plan artifact. A real `tofu plan` needs AWS credentials (`gh-ci-plan`, read-only) and is the job of `infra.yml`; the shared `kms` module reads the caller identity, so an offline plan is not possible. **No `apply` appears in any check or any file in this ticket except the rehearsal script, which only the staging rehearsal role can run.**

## Requests (outside the allowed paths)

Listed in `docs/runbooks/restore.md` section 9. The task entry point cannot run in an image until the SDK dependencies and the image contents exist; the orchestration is tested with injected dependencies.
