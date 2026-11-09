# Restore, point-in-time recovery and DR rehearsal

Owner: DevOps Engineer. Authored for DO-08 (HEAAA-111) from DEVOPS-PLAN 10.1-10.5 and ARCHITECTURE 9.4. **Nothing in this runbook has been executed against AWS.** Every command is a template to be rehearsed (DEP-16); until then it is a claim about design, not evidence.

## 1. Targets and honest status

RPO 15 minutes and RTO 4 hours (PRD NFR-2, NFR-3) are **targets**. No backup, replication lag or restore time has been measured, because no environment exists. The first measured values come from the staging rehearsal (section 6) and the pre-R1 rehearsal. Do not quote either figure as achieved in any document until a rehearsal record in `OPERATIONS-HANDOFF.md` shows it. A rehearsal that misses a target stays recorded as a failure.

## 2. Who may do what

| Action | Authority | Where it runs |
| --- | --- | --- |
| Monthly restore test | Standing operations authority recorded in OPERATIONS_RECEIPT; the `restore-test` approved record (one year at most, renewed yearly) | GitHub environment `restore-test`, role `gh-restore-test`, boundary in the production account |
| PITR or backup restore during an incident | The incident commander declares; the operations owner is informed immediately | AWS-level break-glass roles (DEVOPS-PLAN 7.2), never the application admin screens |
| DR rehearsal stack | A person with the staging rehearsal role (`gh-rehearsal-staging`) after the staging account and SCP are proven | `staging` account, `us-west-2`, synthetic data only |
| Create or change the boundary (VPC, subnet group, security groups, key, endpoint policies, pinned task definition) | Human platform admin applying the approvals root after a reviewed pull request | Never a workflow |

The restore-test environment has production-level access controls and BAA coverage. Access to a restored target equals production access. Staging or demo approval never authorises it.

## 3. What QA and others may receive

Only the PHI-free result document: integers, SHA-256 digests, pass/fail/partial and timings, in a closed schema (`scripts/restore/lib/result.mjs`). The workflow summary and the artifact carry nothing else. **Row data, table contents, error messages from the database, usernames and passwords never leave the restore VPC.** QA reviews the counts, hashes and timings in `OPERATIONS-HANDOFF.md` (case type `OPS`); QA does not receive the restored data and the restore test is not a QA environment. If a result ever contains anything outside the schema the run fails and the file is replaced before upload.

## 4. Monthly restore test

Automated by `.github/workflows/restore-test.yml` (monthly, 02:17 UTC on the 2nd; manual dispatch for rehearsal). Authored **disabled**: it needs `RESTORE_TEST_ENABLED=true` set by a person after section 4.1.

### 4.1 Before it can be enabled (all by humans, in order)

1. The boundary `infra/modules/dr/restore-boundary` is instantiated by the approvals root (a request to the Orchestrator, section 9) and applied by a platform admin. Its outputs feed the `refs` of `gh-restore-test` (`restore_task_definition_arn`, `restore_passrole_arns`, `restore_subnet_group_arn`, `restore_kms_key_arn`).
2. The restore image (pinned by digest from the release manifest) contains `scripts/restore/task/`, `db/tools/` and the dependencies in `scripts/restore/README.md`.
3. The `restore-test` record is applied with `permitted_actions` including `restore-test`.
4. The environment `restore-test` holds the variables in `scripts/restore/README.md`; its deployment branch policy is `main`.
5. A baseline document may be published under `restore-test/baseline/latest.json` (section 4.3). Without it the run reports `partial`.

### 4.2 What one run does

1. Check the record (state, environment, action, window). Refuse on any mismatch.
2. Remove `rt-*` restore targets older than 24 hours (a leftover PHI copy is a finding).
3. Restore into a fresh private instance: the **latest restorable time** in one run, a **random time within the last 7 days** (cryptographic random, never in the last 5 minutes) in the other. Pinned subnet group, security group and KMS key; no public access; IAM database authentication off; tagged `purpose=restore-test`.
4. Start the pinned task **without overrides**. Inside the VPC it: finds its one target by tag; resets the master and every login role to fresh random passwords held only in memory and turns IAM authentication off, **before any check**; then runs the checks. If the reset cannot be proven, no check is attempted and the run fails.
5. Checks: credentials reset; migration set and hash (`migration.schema_migration`); catalogue and RLS checks (`db/tools/catalog-check.mjs`); row counts and sampled checksums of the tables in `scripts/restore/task/tables.json`; audit anchor chain to the restore point; a read-only application-role smoke.
6. The task writes the result document; the workflow fetches it, validates it strictly, writes the summary, and **always** deletes the target and its automated backups.
7. After a scheduled run, `consecutive-failures.mjs` reports whether the last two scheduled runs both failed.

Measured and recorded per run: restore duration (request to the task's start; an upper bound that includes the workflow's own seconds), credential-reset time, check time, and **data age at restore** (the measured RPO of the restore point). These are measurements of one run, not a statement about the 15-minute target.

### 4.3 Comparison baseline (Unverified until rehearsed)

Exact comparison needs the source's counts and checksums as of the restore point. For append-only tables (audit, anchors, migrations) the check is exact up to a baseline watermark; for mutable tables it is a **bounded-drift** check (`max_drift_ratio` per table), not equality. `tables.json` is a proposal that the Architect must agree. **No job produces the baseline yet.** Until one does, `schema-version`, `row-counts`, `checksums` and `audit-anchor-chain` report `partial` with reason `baseline_unavailable` or `merkle_recompute_unavailable`, and the overall result is `partial`, which the workflow treats as not passed. A missing check is never a pass.

### 4.4 When a run fails

1. Read the job summary (validated fields only). Do not try to look into the restored instance: the role cannot read it, and nobody needs production data to debug a count.
2. Confirm the target is gone: the workflow's teardown step is logged; run `node scripts/restore/teardown.mjs --stale` for anything older than 24 hours. A teardown that fails is escalated at once because a PHI copy exists.
3. Open a tracked finding with the run link and the failing check ids.
4. **Two consecutive scheduled failures stop releases** until the restore test passes again. The Release Reviewer reads the latest result (QUALITY-RELEASE-PLAN) and `consecutive-failures.mjs`.
5. CloudTrail events for restore API calls are sent to the security route (section 9, item 5). A restore outside the monthly window that nobody explains is a security incident.

## 5. Point-in-time recovery of the production database (incident)

Use when data was corrupted or deleted and the incident commander has declared it. **Rehearse this before it is needed; the command forms below are unverified.**

1. **Never restore over the production instance.** PITR always creates a new instance.
2. Decide the target time T with the incident commander and the operations owner. T is before the damage and not later than `LatestRestorableTime`. Record T, who chose it, and why.
3. Restore into the production account, in the data subnets, with the same KMS key and parameter group, a new identifier, and no application access:
   `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier <prod> --target-db-instance-identifier <new> --restore-time <T> --db-subnet-group-name <data subnets> --vpc-security-group-ids <isolated sg> --no-publicly-accessible` (break-glass role; the isolated group allows only the administrators doing the repair).
4. Verify before anyone is reconnected: schema version equals the deployed manifest's migration hash; catalogue and RLS checks pass (`db/tools/catalog-check.mjs`); the **audit anchor chain verifies up to T**; row counts of append-only tables equal the source up to T.
5. Reconcile what happened between T and now (the audit hot store follows the database; rows after T are lost from the restored copy). The operations owner and privacy officer decide how the gap is communicated; a gap in PHI access records is itself reportable.
6. Switch the application by updating the **stable secret or parameter name** that holds the endpoint and credential reference, then roll the services. Do not edit task definitions (a workflow cannot register them, DEVOPS-PLAN 7.5).
7. Keep the damaged instance isolated and stopped for forensics until the operations owner releases it.

**Region loss.** The same restore runs in the recovery Region from the cross-Region automated backup replication (`--source-db-instance-automated-backups-arn`), with the recovery-Region KMS key. Replication lag is **expected to be minutes and is not verified**: the rehearsal measures it. If it exceeds 15 minutes, switch to a cross-Region read replica (an added instance of cost; DEVOPS-PLAN 10.4).

## 6. DR rehearsal stack (`ENV-DR`)

A synthetic recovery-Region stack in the **staging** account under the production SCP, created from IaC and destroyed after every rehearsal. It is not the restore-test boundary and holds no PHI.

### 6.1 Before the rehearsal

- The staging account, SCP and approvals-staging root are applied and proven (DEVOPS-PLAN 7.5).
- A cross-Region copy of the **synthetic** `loadtest` snapshot exists in `us-west-2`, named with `-synthetic-` in the snapshot name. The module refuses any other snapshot, any other account and any other Region. **The snapshot size and the copy time are unverified; record both.**
- A var file (not committed) names the account, CIDR, snapshot ARN, rehearsal id and an `expires_at` no more than 24 hours ahead.

### 6.2 Running it

```
scripts/restore/dr-rehearsal.sh plan    --root infra/modules/dr/rehearsal/root --var-file <vars> --out <dir>
scripts/restore/dr-rehearsal.sh run     --root infra/modules/dr/rehearsal/root --var-file <vars> --steps <steps script> --out <dir>
scripts/restore/dr-rehearsal.sh destroy --root infra/modules/dr/rehearsal/root --var-file <vars>      # if a run was interrupted
scripts/restore/dr-rehearsal.sh sweep   --root infra/modules/dr/rehearsal/root --var-file <vars>      # destroys an expired stack
```

`run` applies the stack, runs the steps script, and **destroys the stack on every exit path** including failure and interruption. A destroy that fails is reported loudly and the stack is treated as still existing. The script records only event names and epoch seconds (`timeline.json`) and states that RPO and RTO are not claimed from it.

### 6.3 The timed procedure (the steps script; people, not automation)

Record a start time, then: declare the incident → activate the identity replicas → apply workload IaC in the recovery Region from the replicated state backend → restore the database from the replicated backup (here, the synthetic snapshot copy) and update the stable secret or parameter → verify the audit anchor chain → point services at the **pre-registered recovery-Region task-definition revisions** with the same image digests → switch CloudFront origins / Route 53 → smoke tests → reopen. For each component marked † in ARCHITECTURE 9.4 record its measured RPO. Check identity-replica sign-in with a passkey and handle TOTP-only users (ARCHITECTURE 9.4, P-7). **Failures stay recorded as failures.**

Pass condition for the pre-R1 rehearsal (DEVOPS-PLAN 10.4): total at most 4 hours, measured RPO for each † component, anchors verified, DNS switch and smoke pass. Estimated cost of one rehearsal day is US$100-300 (an estimate, not a measurement).

### 6.4 After

Confirm `destroy` finished and the staging account has no `dr-*` resources left; attach `timeline.json` and the people's timed notes to `OPERATIONS-HANDOFF.md`. Treat the rehearsal as evidence for DEP-16 only if the steps were actually performed.

## 7. Unverified (stated, not assumed)

- Every command and the whole procedure: nothing has run against AWS.
- That `ecs:RunTask` overrides cannot change an entry point (DPR-28 relies on it), and that the pinned task cannot be redirected by a tampered workflow beyond starting that task.
- Whether the `gh-restore-test` role can restore from an automated backup that is encrypted with the production key into the restore key (it has no `kms:Decrypt` on the source key today; section 9, item 3).
- Whether a replicated automated backup reports a latest restorable time (DPR-15) and the cross-Region replication lag.
- The ECR layer bucket name pattern in the S3 endpoint policy (`prod-<region>-starport-layer-bucket`).
- That RDS keeps no password hash the restored master could not override; the reset is checked by role-membership counts and the instance flag, not by reading hashes.
- The table list, the drift tolerances and the baseline (section 4.3).
- Restore duration for production-sized data; the 100-minute restore deadline and the 90-minute task deadline in the scripts are placeholders inside the 2-hour role session.
- The snapshot size and the cross-Region copy time for the rehearsal.

## 8. Residual risk

A tampered workflow that satisfies the OIDC conditions can still start the pinned task and request restores while the record is valid; the boundary limits what that reaches (no path to or read of the data) but not the cost or the existence of an extra PHI copy until teardown. The controls are the record expiry, CODEOWNERS review of `.github/`, CloudTrail alerts and the 24-hour teardown sweep.

## 9. Requests to the Orchestrator (outside this ticket's allowed paths)

1. **Approvals root (DO-04):** instantiate `infra/modules/dr/restore-boundary` in the production account and pass its outputs into the `refs` of the `ci_trust_production` module.
2. **Image and lockfile owners (F-lane):** add `@aws-sdk/client-rds` and `@aws-sdk/client-s3` to the workspace (with licence and reason), and build a restore image that contains `scripts/restore/task/`, `db/tools/`, `pg`, and the RDS CA bundle at `RDS_CA_BUNDLE`. Publish it through the release manifest so its digest can be pinned.
3. **`ci-trust` policy for `gh-restore-test` (DO-04):** add `s3:GetObject` on `restore-test/results/*` of the result bucket and `kms:Decrypt` on that bucket's key (so the workflow can read the PHI-free result), and `kms:Decrypt` through RDS on the source instance's key (restoring into another key). Until then `fetch-result.mjs` fails closed and the first real run will show it.
4. **Result bucket (DO-02 archive):** a `restore-test/results/` and `restore-test/baseline/` prefix in the log-archive bucket with a bucket policy allowing the task role and `gh-restore-test` only.
5. **Observability (DO-07):** subscribe the alert topic of the `security` route to `alert_topic_arn`; add a metric from the result (`RestoreTestLastSuccessAge`, restore duration, data age) once a publisher exists.
6. **Rehearsal workflow:** `.github/workflows/rehearsal.yml` (the file name `gh-rehearsal-staging` trusts) is not in DO-08's paths; it should call `scripts/restore/dr-rehearsal.sh`.
7. **Release workflows (DO-06):** the production `enabled` job should run `consecutive-failures.mjs` and refuse a release while it reports two consecutive failures.
8. **Audit module:** export `verifyChain(query)` (Merkle recomputation) so the anchor check can pass instead of reporting `partial`.
