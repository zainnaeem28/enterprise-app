# Emulator tests and unconfigured AWS workflows (HEAAA-698)

Release 1 ends with an AWS-ready codebase on `main`; nothing is deployed and no AWS account exists. Two rules follow, and CI enforces both.

## 1. Emulator tests (`pnpm test:emulator`)

- Write a test as `<name>.emulator.test.ts` next to the code it covers. `pnpm test:emulator` (runner: `scripts/ci/run-emulator-tests.mjs`) finds every such file in the repository and runs it with the Node test runner (Node 24 strips TypeScript types, so use erasable syntax only and import workspace packages through their built `dist/`). With no matching file it passes and says so.
- The `emulator` job in `ci.yml` starts LocalStack community 4.9.2 (digest-pinned) as a service container and sets `AWS_ENDPOINT_URL=http://127.0.0.1:4566`, `AWS_ACCESS_KEY_ID=test`, `AWS_SECRET_ACCESS_KEY=test`, `AWS_REGION=us-east-1`, `AWS_S3_FORCE_PATH_STYLE=true`. The values are dummy and test-only. A test must read the endpoint from the environment and skip itself with a clear message when it is unset, so a developer without Docker gets a clean local run. In CI (`--require-endpoint`) a skipped test, or a matched file with zero cases, fails the job: a skipped suite is not evidence.
- Locally: `docker run --rm -p 127.0.0.1:4566:4566 -e SERVICES=s3,kms,secretsmanager,ses,sns,sqs localstack/localstack:4.9.2`, then export the variables above and run `pnpm test:emulator`.

| Slot                                 | In the emulator job                            |
| ------------------------------------ | ---------------------------------------------- |
| S3, KMS, Secrets Manager, SES, SNS   | Emulated by LocalStack (SNS covers SMS publish) |
| SQS                                  | Emulated (started for queue-shaped tests)       |
| Textract, Chime SDK, End User Messaging SMS (pinpoint-sms-voice-v2), GuardDuty Malware Protection for S3, Cognito | **Not emulated** by the community edition. Use in-repo fakes behind the port and unit tests; verification of real behaviour belongs on the go-live checklist (`docs/GO-LIVE.md`). |
| MinIO                                | Not used: LocalStack already serves S3.         |

Results are **emulator evidence only**. Never state that a cloud behaviour was verified from them.

## 2. AWS-touching workflows skip when unconfigured

`infra.yml` (plan, apply), `build-release.yml`, `deploy-staging.yml`, `deploy-production.yml`, `deploy-marketing.yml`, `audit-archive.yml`, `restore-test.yml`, `nightly.yml` and `bootstrap.yml` each have a gate that, when its configuration variable is not `true` (build-release: when no `RELEASE_*` variable is set), prints `::notice::not configured: <VAR>`, writes a "Not configured" job summary, and skips every job that could touch a cloud account. Consequences:

- The run is green but every real job shows **skipped**; the summary and notice say that nothing was deployed, applied, archived, restored or published. `build-release` on `main` without configuration builds and validates a **dry-run** manifest and publishes nothing; it never reports a release.
- A half-configured `build-release` (some `RELEASE_*` variables set, others missing) still fails, and `nightly`'s outcome job fails if a job did anything other than skip while unconfigured.
- Running from a ref other than `main` is still an error; that is misuse, not a missing configuration.
- `ci-status` (in `ci.yml`) depends only on the PR jobs, including `emulator`, and still treats a skipped required job as a failure. None of the AWS-touching workflows feed it, so a skipped deployment is never counted as a deployment.

Proof without GitHub: `node scripts/ci/check-aws-gates.mjs` extracts each gate script, runs it with the variable absent and set, and checks the notice, `enabled` output, exit code and that downstream jobs test the output. It runs in `workflow-hygiene`.
