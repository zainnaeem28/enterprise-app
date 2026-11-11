# aws-adapters (AWS-DO-1, HEAAA-709)

Cloud side of every adapter in `docs/runbooks/AWS-ADAPTERS.md`. **Authored only, never applied** (owner ruling 2026-11-11: R1 deploys
nothing). Nothing here was checked against real AWS; tests run on mock/overridden providers and show the plan shape and the rendered
policy documents, not AWS behaviour. Real-service checks are on the go-live list (`docs/GO-LIVE.md`).

## What it makes

| Adapter / need | Resource | Notes |
|---|---|---|
| Privacy packages, audit exports (S3) | two buckets, SSE-KMS with the account data key, versioned, private, TLS-only, writes only by the worker role, lifecycle expiry | expiry days are placeholders (no approved retention) |
| Documents (S3) | made by `modules/storage`; this module only names them and grants the roles | the worker role is the clean-bucket writer |
| Anchor archive (Object Lock) | bucket and bucket policy in `modules/archive` (log-archive root `archive.tf`, staging root `adapters.tf`) | this module grants the worker cross-account `PutObject/GetObject/GetObjectVersion` on `anchors/*` and prefix-limited list; no delete, retention or legal hold |
| Sealer (KMS) | `aws_kms_key.payload`, rotation on | key policy: api `GenerateDataKey` only, worker `Decrypt`/`DescribeKey` only, explicit Deny of the other half, every use needs the `ehr:ctx` context |
| Secrets Manager | role policies on `<env>/integration/outbound/*` (api writes) and `inbound/*` (worker writes, api reads) | runtime secrets are created by the app; the VAPID private key container is made by `modules/secrets` in the root |
| E-mail | SES v2 domain identity (2048-bit DKIM), configuration set (TLS required, suppression list) | DNS records, production access: go-live |
| SMS | End User Messaging configuration set | the origination identity is an input (a purchase plus carrier registration); null keeps SMS unconfigured and the app refuses it |
| Malware scan | GuardDuty Malware Protection plan on the quarantine bucket, prefix `q/`, tagging on, scoped service role | tag name and values unverified until a real scan |
| Video | IAM only (no resource exists for Chime meetings); api `chime:CreateAttendee`, worker create/get/delete; failed-call metric filter and alarm | DL-1 C3 (video part) and C4. The dead `telehealth.close_meeting` job alarm (worker `job_dead` line, HEAAA-779) is in `alarms.tf` |
| OCR | worker `textract:DetectDocumentText` | |
| Patient identity | `modules/identity` (Cognito) is instantiated in the roots; this module passes its issuer and client id to the api as `EHR_PATIENT_OIDC_*` | partner pool has no sign-in code in R1 |
| Roles | `<env>-ehr-api-task`, `<env>-ehr-worker-task`, `<env>-ehr-task-execution`, `<env>-ehr-guardduty-s3-scan` | role ARNs are built from fixed names, so storage, archive and KMS can name them without a dependency cycle |
| Environment | outputs `api_environment`, `worker_environment`, `worker_secret_references` | the exact variable names of the runbook; tests fail if one goes missing |

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
replicated image repository for the execution role). The secret replica and its key (`production-secrets-dr`, single-Region) are made in
the production root through the `secrets` module (`recovery_region`, `replica_kms_key_arn`). **No compute is created.** Whether the
replicated secret needs its own resource policy in the recovery Region is not verified.

## Not done here

- The compute module is not instantiated in the roots (it needs image digests); the roots expose `service_wiring`, the exact `services.*` and
  `execution_role_arn` values.
- SES bounce/complaint event destination and SNS signature check (no receipt route exists, INT-N2), SMS origination identity, DNS, SES/SMS production access.
- Recovery-Region compute (DEVOPS-PLAN 3.2), and in the recovery Region: document upload, package and export buckets, runtime integration secrets, SES/SMS sending, the anchor archive and malware scanning (see `recovery.tf` header for why each is absent).
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
4. **No SNS topic or event destination for SES receipts**: nothing consumes them yet (AWS-ADAPTERS.md "Receipts"); adding an unverified
   topic would only look complete.
5. **api `GetObject` on the whole clean bucket** (key layout after promotion is not fixed in the code); quarantine and packages are prefix-limited (`q/`, `p/`).
6. Recovery policies are static plan-shape only: not applied, not exercised by a task in us-west-2.
7. Not run: `tofu plan/apply` (no account), checkov (the repository's policy scan is Trivy), any AWS call.
