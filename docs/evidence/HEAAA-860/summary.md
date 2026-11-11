# HEAAA-860 evidence: runtime integration secrets with a recovery-Region replica

Spec: HEAAA-870 decision-log rev 2 (b5781f53), "Implementation spec for HEAAA-860". No hosted CI (owner ruling B): every check below was run locally on the submitted head; the submit-check report lists the commands and results.

Base: `origin/dev` 86baf44 plus `origin/HEAAA-875-sc2-secret-denies` 1506510 merged (HEAAA-875 is `done` but its branch was not yet on `dev`; the D-4a denies are present and unchanged).

## Citations the spec asked for (D-4b)

- **Condition key.** AWS Service Authorization Reference, Secrets Manager (`list_secretsmanager`): `secretsmanager:AddReplicaRegions` — "Filters access by the list of Regions in which to replicate the secret", type `ArrayOfString`; listed for both `CreateSecret` and `ReplicateSecretToRegions`. So the condition is documented for these actions and is used. `ForAllValues:StringEquals` passes when the key is absent, so the grant also has `Null` = `false`.
- **ListSecrets scoping.** Same reference: `ListSecrets` — "Resource types" empty, "Condition keys" empty, access level List. It supports no resource-level scoping, so Resource is `*`.
- **DescribeSecret.** Resource type `Secret*`, so it is scoped to `<env>/integration/*`.
- **ListSecrets has no ReplicationStatus.** The SDK type `SecretListEntry` (client-secrets-manager) has no `ReplicationStatus`, so the check calls `DescribeSecret` per secret.
- **KMS.** The replica key needs `kms:GenerateDataKey` and `kms:Decrypt`. Both roles' recovery-Region inline policies (`recovery.tf`, `SecretsKeyRecoveryThroughSecretsManager`, `kms:ViaService` = `secretsmanager.<recovery>.amazonaws.com`) already grant them on `production-secrets-dr`; that key's policy delegates to IAM (`modules/kms`, `AccountRootAdministration`). No key-policy change was needed. Not verified against a real replication (stubbed tests and `tofu test` only).

## Additions beyond the listed allowed paths (needed for correctness)

- `packages/kernel/src/aws/config.ts` + `index.ts`: one shared `secretReplicaFromEnv` (all-or-none, Region != `AWS_REGION`, key ARN in the replica Region) instead of two copies in api and worker.
- `packages/kernel/src/logging/redact.ts`: `region` added to the safe field names. Without it the logger replaced the Region with `[redacted]` in `secret_replication_failed` / `secret_replica_unhealthy`.
- `infra/modules/aws-adapters/outputs.tf`: `recovery_environment.common_unset` lists the two replica variables. Without it the recovery task definitions (which merge over the production environment) would carry them and refuse to start (replica Region = `AWS_REGION`).
- `apps/worker/src/main.ts`, `compose.ts`, `job-registry.ts` (`workerCrontab`): the crontab line is added only with the replica configured.
- The production root (`infra/accounts/production`) does not instantiate the `observability` module, so there is nothing to wire; the `observability` example now sets `secret_replica_monitoring = true`. The instantiation must set it where `recovery_region` is set (noted in GO-LIVE).

## Not done / limits

- Nothing ran against AWS or LocalStack; replication behaviour is taken from the AWS documentation.
- The rehearsal items (GO-LIVE recovery evidence i-iii) are for the rehearsal; (iii) is the HEAAA-875 Security Reviewer PASS.
