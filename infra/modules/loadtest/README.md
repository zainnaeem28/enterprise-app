# loadtest (DO-11)

Ephemeral, production-equivalent load-test environment. One run = one `run_id`: create from this module, run the
tests (`tests/load/harness`), destroy. Authored and checked only; **nothing is applied** by this ticket.
Decisions: HEAAA-586 `decision-log` D-1 (environment, cost) and D-2 (k6).

- Composes `../network`, `../kms`, `../database`, `../storage`, `../compute`, `../edge` with the sizes in `profile.tf`.
  Sizing is not an input, so the environment cannot drift from production by configuration.
- Differences from production (all deliberate): identity (names, hosts, certs, keys, secret), `deletion_protection=false`
  and `force_destroy=true` (torn down every run), no cross-Region RDS backup replication and no backup copy vaults
  (synthetic data, and the log-archive vault must not receive loadtest recovery points), 7-day KMS deletion window.
- Synthetic data only: `seeder` one-off task (seed and counts recorded in the task definition); tags
  `DataClass=synthetic-only`, `owner`, `ttl`, `RunId`; service env `LOADTEST_SYNTHETIC_ONLY=true`, `INTEGRATIONS_MODE=stub`
  (the application tickets must honour these two; not verified here).
- Cost: budget per run (`run_cost_ceiling_usd`, 80 % actual and 100 % forecast alerts) plus `guard-cost.sh`.
- Lifetime: `expires_at` tag (at most 24 h after start), always-run `teardown.sh`, scheduled `reap-expired.sh`.
- `root/` is a thin root that wires the provider aliases for init/validate/tflint/trivy; it has no backend and is not applied.

## Limitations (open)

- **L1 (resolved by HEAAA-588).** `database` and `compute` previously keyed `for_each` on security-group ids and failed a fresh `plan`
  with "Invalid for_each argument". Both now take `map(string)` (logical name => id) with static keys; this module passes
  `module.compute.service_security_group_ids` and `{ database = module.database.security_group_id }`. A fresh-plan test lives in
  `../compute/examples/sg-wiring`. The checks here still replace those modules by fixed outputs (`tests/plan.tftest.hcl`).
- **L2.** The service task sizes and counts in `profile.tf` are placeholders: no production root instantiates `compute` yet, so there is
  no production value to copy. Database values are the production module defaults. `check-equivalence.mjs` must be run
  against the production plan's `profile` before the first real run; any unjustified difference fails.
- **L3.** Cost ceiling currency amount is not yet filled from a price list; the first real create needs it in the plan artifact.
- **L4.** The provider lock file is not committed: the authoring sandbox had no space to download the provider from the registry
  (a read-only local plugin directory with AWS provider 5.100.0 was used). Run `terraform providers lock` in CI.
- **L5.** Workflow wiring (create, always-run teardown, scheduled reaper) belongs in `.github/workflows`, outside this ticket's paths; request sent to the Orchestrator.
- **Round 2 notes.** `expires_at` is validated to at most 24 h after plan time. `reap-expired.sh` and `teardown.sh` query us-east-2, us-east-1 and us-west-2 and fail on any API error. `guard-cost.sh` needs `RunId` activated as a cost-allocation tag and lags up to a day (budget alarm is the early signal). HEAAA-587 wiring must add: `providers lock` check (no lock file yet), and gating the first real create on a passing `check-equivalence.mjs`. The plan artifact is from mock providers, so the environment is not yet shown to be creatable from IaC.
