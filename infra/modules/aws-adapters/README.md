# aws-adapters (AWS-DO-1, HEAAA-709)

Cloud side of every adapter in `docs/runbooks/AWS-ADAPTERS.md`. **Authored only, never applied** (owner ruling 2026-11-11: R1 deploys
nothing). Nothing here was checked against real AWS; tests run on mock/overridden providers and show the plan shape and the rendered
policy documents, not AWS behaviour. Real-service checks are on the go-live list (`docs/GO-LIVE.md`).

## What it makes

| Adapter / need                       | Resource                                                                                                                                    | Notes                                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy packages, audit exports (S3) | two buckets, SSE-KMS with the account data key, versioned, private, TLS-only, writes only by the worker role, lifecycle expiry              | privacy packages expire after 7 days (ruling C item 2 †); audit exports keep their unconfirmed 90 days (not covered by the ruling)                                                                                          |
| Documents (S3)                       | made by `modules/storage`; this module only names them and grants the roles                                                                 | the worker role is the clean-bucket writer                                                                                                                                                                                  |
| Anchor archive (Object Lock)         | bucket and bucket policy in `modules/archive` (log-archive root `archive.tf`, staging root `adapters.tf`)                                   | this module grants the worker cross-account `PutObject/GetObject/GetObjectVersion` on `anchors/*` and prefix-limited list; no delete, retention or legal hold                                                               |
| Sealer (KMS)                         | `aws_kms_key.payload`, rotation on                                                                                                          | key policy: api `GenerateDataKey` only, worker `Decrypt`/`DescribeKey` only, explicit Deny of the other half, every use needs the `ehr:ctx` context                                                                         |
| Secrets Manager                      | role policies on `<env>/integration/outbound/*` (api writes) and `inbound/*` (worker writes, api reads)                                     | runtime secrets are created by the app; the VAPID private key container is made by `modules/secrets` in the root. Explicit denies (SC-2, tested in `tests/policy.tftest.hcl`): see "Explicit denies on the app roles" below |
| E-mail                               | SES v2 domain identity (2048-bit DKIM), configuration set (TLS required, suppression list)                                                  | DNS records, production access: go-live                                                                                                                                                                                     |
| SMS                                  | End User Messaging configuration set                                                                                                        | the origination identity is an input (a purchase plus carrier registration); null keeps SMS unconfigured and the app refuses it                                                                                             |
| Malware scan                         | GuardDuty Malware Protection plan on the quarantine bucket, prefix `q/`, tagging on, scoped service role                                    | tag name and values unverified until a real scan                                                                                                                                                                            |
| Video                                | IAM only (no resource exists for Chime meetings); api `chime:CreateAttendee`, worker create/get/delete; failed-call metric filter and alarm | DL-1 C3 (video part) and C4. The dead `telehealth.close_meeting` job alarm (worker `job_dead` line, HEAAA-779) is in `alarms.tf`                                                                                            |
| OCR                                  | worker `textract:DetectDocumentText`                                                                                                        |                                                                                                                                                                                                                             |
| Patient identity                     | `modules/identity` (Cognito) is instantiated in the roots; this module passes its issuer and client id to the api as `EHR_PATIENT_OIDC_*`   | partner pool has no sign-in code in R1                                                                                                                                                                                      |
| Roles                                | `<env>-ehr-api-task`, `<env>-ehr-worker-task`, `<env>-ehr-task-execution`, `<env>-ehr-guardduty-s3-scan`                                    | role ARNs are built from fixed names, so storage, archive and KMS can name them without a dependency cycle                                                                                                                  |
| Environment                          | outputs `api_environment`, `worker_environment`, `worker_secret_references`                                                                 | the exact variable names of the runbook; tests fail if one goes missing                                                                                                                                                     |

## Wildcard resources (all AWS limits)

`ecr:GetAuthorizationToken` (no resource-level permission); `ses:GetAccount` and `sms-voice:DescribeAccountAttributes` (read-only, account
level); `textract:DetectDocumentText` and `chime:CreateMeeting` (no resource-level permission; limited by `aws:RequestedRegion`). Everything else
names a bucket prefix, key, secret path, identity or meeting ARN. Secret ARNs for the execution role end in `-??????` (the 6-character suffix AWS adds).

## Recovery Region (R1-GAP-4, authored only)

The payload key replica itself (`aws_kms_replica_key.payload_recovery`, provider `aws.recovery`, primary key's policy via `payload_key_policy_json`) is declared in the production root, `infra/accounts/production/adapters.tf`, not in this module. Authored only, not applied.

`recovery.tf`, active when `recovery_region` is set (production root only). IAM roles are global, and the payload key replica carries the
primary key policy that names these roles, so the primary roles double as the recovery roles: the trust policy also admits ECS tasks of the
recovery Region (same account), and a second inline policy `recovery-region` per role names the replicas only (documents replica bucket
read, data key replica decrypt through S3, payload key replica seal/open split as in the primary, the replicated VAPID secret and the
replicated image repository for the execution role). Since HEAAA-850 the same policy also covers the services that have a recovery-Region
counterpart: Region-bound quarantine, package and export buckets (`<name>-dr`, made here with `aws.recovery`), a GuardDuty plan on the recovery quarantine bucket,
the SES identity and configuration set, the SMS configuration set (sending when `recovery_sms_origination_identity_arn` is set), and create/read of the runtime
integration secrets under the recovery secrets key. The anchor archive is a documented degraded mode. Output `recovery_environment` is the override set for the recovery
task definitions; `docs/runbooks/recovery-region.md` holds the degraded modes. The caller must pass `providers = { aws.recovery = ... }`. The secret replica and its key (`production-secrets-dr`, single-Region) are made in
the production root through the `secrets` module (`recovery_region`, `replica_kms_key_arn`). **No compute is created.** The `secrets` module attaches the primary's resource policy to every
replica explicitly (a replica does not inherit it); that AWS applies it as authored is confirmed in the rehearsal.

## Not done here

- The compute module is not instantiated in the roots (it needs image digests); the roots expose `service_wiring`, the exact `services.*` and
  `execution_role_arn` values.
- SES bounce/complaint event destination and SNS signature check (no receipt route exists, INT-N2), SMS origination identity, DNS, SES/SMS production access.
- Recovery-Region compute (DEVOPS-PLAN 3.2), and in the recovery Region the Object Lock anchor archive (degraded mode, `docs/runbooks/recovery-region.md`), SMS unless `recovery_sms_origination_identity_arn` is given, and runtime secrets created before a failover (not replicated).
- IAM and key-policy writes need the human platform-admin apply (DEVOPS-PLAN 7.5); the `gh-tf-*` roles cannot create roles.

## Tests

`tofu test` in this directory: `tests/plan.tftest.hcl` (mock provider: variables per process, no emulator settings, SMS all-or-nothing,
bucket encryption and blocking, alarm) and `tests/policy.tftest.hcl` (real policy documents rendered under a throwaway provider
configuration with every resource overridden: no wildcard resource outside the three justified ones, api cannot open payloads, worker cannot seal,
anchors limited to put/get/get-version, outbound/inbound secret split).

## Decisions (for the reviewers; owner of each: DevOps, reviewed by Security Reviewer / DevOps Reviewer)

1. **Staging gets its own anchor archive** (GOVERNANCE, 1 day, no recovery vault) instead of writing into the production log-archive
   bucket, so test anchors are not locked there for the legal retention. Cost: one extra bucket, its replica and two keys in staging.
2. **Fixed role names** instead of passing role ARNs between modules: it removes the storage / KMS / archive dependency cycle at the price of
   a naming contract (asserted in `plan.tftest.hcl`).
3. **Key policy denies, identity policy allows** for the sealer: SC-2 and SC-3 hold even if a later identity policy is too broad.
4. **Delivery receipts are opt-in and the SMS event destination is not IaC.** `receipt_endpoint_url` (null by default) creates the SES event
   destination, a KMS-encrypted SNS topic per channel with a source-scoped publish policy, and an HTTPS subscription to the API route
   (`receipts.tf`). The pinned provider (`~> 5.80`) has no End User Messaging SMS event-destination resource, so that one step is a CLI
   command in the runbook until the provider is upgraded. Static plan shape only; the confirmation handshake and event names are unverified.
5. **api `GetObject` on the whole clean bucket** (key layout after promotion is not fixed in the code); quarantine and packages are prefix-limited (`q/`, `p/`).
6. Recovery policies are static plan-shape only: not applied, not exercised by a task in us-west-2.
7. Not run: `tofu plan/apply` (no account), checkov (the repository's policy scan is Trivy), any AWS call.

## Explicit denies on the app roles (SC-2)

Identity-policy Deny statements on the `api` and `worker` roles (ARCHITECTURE 25.9 item 6, HEAAA-870 D-4a). Secret ARNs use a Region wildcard, so one statement covers the home and the recovery Region.

| Sid                                     | Role        | Denied actions                                                                                                         | Resources                                   |
| --------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `ApiCannotWriteInboundSecrets`          | api         | `secretsmanager:CreateSecret`, `PutSecretValue`, `UpdateSecret`, `ReplicateSecretToRegions`                            | `<env>/integration/inbound/*`, all Regions  |
| `WorkerCannotWriteOutboundSecrets`      | worker      | the same four                                                                                                          | `<env>/integration/outbound/*`, all Regions |
| `CannotChangeSecretPolicyOrReplication` | api, worker | `secretsmanager:PutResourcePolicy`, `DeleteResourcePolicy`, `RemoveRegionsFromReplication`, `StopReplicationToReplica` | `*`                                         |
| `CannotChangeKeyPolicy`                 | api, worker | `kms:PutKeyPolicy`                                                                                                     | `*`                                         |

Replica promotion is an operator action (`docs/runbooks/recovery-region.md` 2.2), never an app-role action. A later grant (HEAAA-860) adds only the Allow for the right class. The tests also assert no Allow in `api`, `worker`, `recovery_api` or `recovery_worker` reaches a denied action on a denied resource. Not authored against real AWS; the deny behaviour is on the go-live list.
