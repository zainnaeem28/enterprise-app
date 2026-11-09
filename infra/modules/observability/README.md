# observability module (DO-07, authored, not applied)

Telemetry, alarms, dashboards, synthetic checks and PHI scrubbing as code (DEVOPS-PLAN 11.1-11.4, 12; PRD NFR-1..4, NFR-20, NFR-21).
Nothing here has been applied. `tofu plan` runs offline (`examples/plan`, fake credentials, all account calls skipped) and `tofu test` runs on a mock provider.

## What it creates

| Area | Resources | File |
| --- | --- | --- |
| Routes | SNS topics `page`, `ticket`, `security` (KMS-encrypted), policy, email subscriptions | `sns.tf` |
| Catalogue and SLOs | Alert catalogue (owner, impact, first step, runbook for every alert), fixed SLO table | `catalog.tf` |
| Alarms | ALB 5xx, unhealthy target, latency, multi-window error-budget burn (14.4x / 6x, composite), DB, queue, outbox, integrations, audit pipeline, staff-scope drift, backup health, certificates, WAF, PHI-in-logs, canaries | `alarms.tf` |
| Event alerts | GuardDuty high, CloudTrail logging changes, root login, break-glass use, migration task failure, ECS deployment failure, RDS events; cost budgets | `events.tf` |
| PHI scrubbing | Log data-protection policy (audit + de-identify) per application log group, findings log group; ADOT collector config with key allowlist and PHI value blockers | `dataprotection.tf`, `adot.tf`, `adot/` |
| Synthetic checks | Read-only CloudWatch Synthetics canaries (script in `canary/`), cost output | `canaries.tf` |
| Backup lag | Lambda + schedule publishing `BackupReplicaLagSeconds` (DPR-15) | `backup_lag.tf`, `lambda/` |
| Dashboard | One metric-only operations dashboard | `dashboard.tf` |

Application side: `apps/api/src/telemetry/` (config, allowlist, scrubbing exporter wrapper). The key allowlist is one list in two places (`adot/allowed-attributes.json` and `allowlist.ts`); a test fails if they differ.

## Rules this module enforces

- Every alarm, rule and subscription takes its description from the catalogue, so owner, impact, first diagnostic step and runbook link exist for every alert. Test: `every_alert_has_owner_impact_first_step_runbook`.
- SLO targets are constants (99.9 %, p95 500 ms, slot search p95 1 s, LCP 2.5 s, RPO 15 min, RTO 4 h). No variable lowers them. Burn thresholds derive from the availability target.
- No canary writes data. There is no input or code path for a write canary, so production writes stay off until DEVOPS-PLAN 16 item 12 is decided; staging write journeys belong to the QA harness. Canary URLs are validated as https with no query string; frequency is 1, 5 or 15 minutes.
- No telemetry attribute outside the allowlist leaves the API process (span exporter wrapper; spans only) or the task (collector). Values shaped like canaries, emails, SSNs, phone numbers, card numbers, tokens or dates of birth are redacted. PHI canary test: `tests/phi-canary-scan.mjs`.
- No paid paging service is selected. Delivery is SNS email to named people. `paging_status` reports `availability_claimed = false` until a rota is named (C-18, D-29).
- Backup-lag alarm actions are disabled until the first replica reports (`backup_replica_first_report_seen`), as DEVOPS-PLAN 11.3 requires.

## Checks (run from this directory; see the DO-07 evidence for the recorded output)

```
tofu fmt -check -recursive
tofu init -backend=false && tofu validate
tflint
tofu test
(cd examples/plan && tofu init -backend=false && tofu plan -out=observability.tfplan && tofu show -json observability.tfplan > observability.plan.json)
node tests/phi-canary-scan.mjs examples/plan/observability.plan.json --self-test
checkov -d . --framework terraform --skip-path examples --skip-path tests
trivy config examples/plan
(cd lambda && python3 -m unittest test_backup_lag)
```

## Wiring requests (outside this ticket's allowed paths; through the Orchestrator)

1. **Compute (DO-03)**: add the sidecar from output `adot_container_definition`, give the containers `app_otel_environment`, add `adot_task_role_policy_json` to the task role and `ssm:GetParameters` on `adot_collector_config_parameter_arn` plus `kms:Decrypt` on the key to the execution role. Container health, CPU and memory for the sidecar are placeholders.
2. **API package**: add the OpenTelemetry SDK packages (with licence and reason) to `apps/api/package.json` and call `startTelemetry(process.env, createSdk)` before the app module loads. `createSdk` must pass the trace exporter through `wrapExporter`.
3. **API tests**: `apps/api` runs `dist/test/**` only; `src/telemetry/telemetry.test.ts` needs adding to that glob.
4. **KMS (DO-01)**: the key policy must allow CloudWatch, EventBridge, Budgets and RDS to use the key for the SNS topics (`kms_key_policy_requirements`).
5. **Runbooks**: catalogue links point at anchors in `docs/runbooks/OPERATIONS-RUNBOOKS.md` (`runbook_base`). That document does not exist yet; each anchor is the catalogue id.
6. **Application metrics**: queue age, dead letters, outbox age, audit, scope drift, vendor circuit/failure rate, slot search and restore test metrics under `EHR/Application` must be emitted by the application and jobs. Names and dimensions are in `alarms.tf`.
7. **us-east-1 instance**: instantiate the module a second time there with `enable_core = false`. It holds the CloudFront-scope WAF alarm (the plan precondition enforces the Region) and the `root-login`, `break-glass-use` and `cloudtrail-change` rules, because CloudTrail records root console sign-in and global-endpoint STS events in us-east-1. Whether break-glass `AssumeRole` calls through a regional STS endpoint appear in the workload Region is Unverified; the primary instance keeps its own copy of the same rules.
8. **Silent emitters**: the `metrics-silent-*` alarms need the application to publish `QueueOldestJobAgeSeconds`, `OutboxOldestUnsentAgeSeconds`, `StaffScopeDriftCount` and `QueueDeadLetterJobs` every period (zero when idle). They are created inactive; set `app_metrics_heartbeat_enabled = true` once that is wired.

## Unverified (stated, not assumed)

- Managed data-identifier names in the log policy and that the service accepts the policy document as written.
- That the pinned ADOT image includes the `redaction`, `probabilistic_sampler`, `awsxray` and `awsemf` components, and that `redaction` treats resource attributes as assumed.
- That `DescribeDBInstanceAutomatedBackups` returns a latest restorable time for a replicated backup (DPR-15); staging rehearsal decides.
- CloudWatch Synthetics runtime name (`syn-nodejs-puppeteer-9.1`) and the HTTPS-only handler; Lambda and artifact cost beyond the verified US$0.0012 per run.
- Thresholds the plan leaves open are placeholders with variables: outbox age (300 s), integration failure rate (25 %), audit anchor lateness (300 s), WAF spike (500 per 5 minutes), trace sampling (10 %).
- Alert delivery: SNS email subscriptions must be confirmed and a named person must acknowledge a test alert. Not executed; blocks the go-live claim, not the build (C-18).
- The Workspace admin change alert and the release-workflow-failure alert are catalogue entries raised outside AWS (`source = external:...`); this module cannot create them.
- The `phi_pattern_in_logs` alarm reads a metric filter on the findings log group (`PhiFindingEvents`, no dimensions) instead of the service metric `AWS/Logs LogEventsWithFindings`, whose dimension set was not confirmed. That the data-protection policy actually writes findings to that group is Unverified until staging.
- Telemetry scrubbing in the API process covers spans (names, attributes, events, links, resource, status message). Metrics and logs are covered by the collector allowlist, the log data-protection policy and the logger allowlist (NFR-18), not by this wrapper.
- Nothing in this module has run against AWS.
