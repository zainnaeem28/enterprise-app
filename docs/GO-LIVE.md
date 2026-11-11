# Go-live: what a person must do, and what is still not done

Task HEAAA-714 (AWS-DO-3) · Owner ruling 2026-11-11 (HEAAA-33, HEAAA-697) · Author: DevOps Engineer

**Status of everything in this file: NOT DONE.** Release 1 ends with an AWS-ready codebase on `main`. Nothing is deployed, no AWS
account exists, no credential, purchase or person was available, and no cloud service was called. Every AWS behaviour named here is
**unverified**: the only evidence the repository holds is unit tests and integration tests against local emulators (LocalStack),
which show that requests are well formed, not how real AWS behaves. Without configuration the application keeps its ports
**refusing** (never faking).

Names below come from these sources. Some are on branches that were not yet on `main` when this file was written; a name that is
not found when you work through this file is a defect of this file, so report it:

| Source | Where | Content used |
| --- | --- | --- |
| `docs/runbooks/AWS-ADAPTERS.md` | branches `HEAAA-700` … `HEAAA-707` (AWS-BE-1..4); latest complete text on `HEAAA-707-aws-video-ocr-scan` | adapter variables, selection rules, IAM actions |
| `infra/modules/aws-adapters` | branch `HEAAA-709-aws-iac` (AWS-DO-1) | the IaC output that produces those variables |
| `docs/runbooks/emulator-tests.md`, workflow gates | branch `HEAAA-698-emulator-ci` (AWS-CI-1) | emulator job, "not configured" skips |
| `infra/modules/loadtest`, `loadtest-run.yml`, `loadtest-reaper.yml`, `docs/loadtest-workflow.md` | branch `HEAAA-712-loadtest-restore` (AWS-DO-2) | load-test stack and its variables |
| `infra/accounts/README.md`, `infra/bootstrap/README.md`, `infra/approvals/README.md`, `scripts/deploy/README.md`, `scripts/bootstrap/README.md`, `docs/runbooks/restore.md`, `.github/workflows/*.yml` | `main` | accounts, order, approvals, release and deploy |
| `docs/DELIVERY-PLAN.md` conditions register C-01..C-22, `docs/DEVOPS-PLAN.md`, `docs/security/TC-PEN-01-scope-and-rules-of-engagement.md` | `main` | checklist items |

Rule for every step: a person does it, in their own authenticated session. No agent holds an AWS identity, and no step here may be
done by weakening a check. A skipped workflow is never a pass.

## Part 1. Deployment steps (a person performs these, later)

### 1.1 AWS organisation, accounts, administrators, Region (C-01, C-21, C-12)

1. Decide and record: the home Region, the recovery Region, the named platform administrators, the owner of the management-account SCPs,
   the Identity Center home Region and break-glass availability (DEVOPS-PLAN 16 items 9, 14, 18, 21).
2. Create the AWS Organization and its management account. Sign the AWS BAA and confirm every service used is HIPAA-eligible
   (checklist items 3 and 4) **before any PHI-capable resource is made**.
3. Identity Center: one human role named `platform-admin-apply` (the only principal exempt from the control-plane SCP, pattern in
   `platform_admin_role_arn_pattern` of `infra/accounts/management`). Break-glass roles per DEVOPS-PLAN 7.2.
4. Accounts (one OpenTofu root each under `infra/accounts/`): `management`, `tooling`, `log-archive`, `staging`, `production`, `marketing`.
   Account e-mail addresses, the organisation ID and `apply_role_arn` values are inputs; none is committed.
5. Confirm the us-east-1 exemption list in `infra/accounts/management/main.tf` against the real Chime SDK control plane and Cognito
   custom domains (C-12). `attach_scps` defaults to `false`; set it to `true` only after that check.

### 1.2 Bootstrap and apply order of the roots (humans, `platform-admin-apply`)

From `infra/accounts/README.md` ("Bootstrap order"). The pipelines never apply the management root.

| Step | Root | Action |
| --- | --- | --- |
| 1 | `infra/accounts/management` | enable the SCP policy type (`aws organizations enable-policy-type --policy-type SERVICE_CONTROL_POLICY`); apply with **local** state (temporarily drop the `backend "s3"` block, do not commit that); creates OUs and accounts including `tooling`; `attach_scps = false` |
| 2 | `infra/bootstrap` | in `tooling`, apply with local state, then `tofu init -migrate-state` into the bucket it made (versioned, SSE-KMS, native `use_lockfile`, recovery-Region replica) |
| 3 | `infra/accounts/management` | `tofu init -migrate-state -backend-config=backend.hcl` |
| 4 | the other `infra/accounts/*` roots, then `infra/approvals` | `tofu init -backend-config=backend.hcl` in each; `backend.hcl` holds the `backend_config_hint` output and is never committed. `infra/approvals` has its own state bucket and key |
| 5 | `infra/accounts/log-archive` | includes `archive.tf` (the audit-anchor archive, Object Lock) from AWS-DO-1 |
| 6 | `infra/accounts/staging`, then `infra/accounts/production` | include `adapters.tf` (module `infra/modules/aws-adapters`); staging has its own anchor archive (GOVERNANCE, 1 day) |
| 7 | `infra/accounts/marketing` | no path to production data |

Review `tofu plan` output before any apply. After the first apply by a human, later workload-root changes go through `infra.yml`
(section 1.4). IAM and key-policy writes always need the human platform-admin apply (the `gh-tf-*` roles cannot create roles).
Compute is not instantiated in the roots (it needs image digests); each root exposes `service_wiring`, the exact `services.*` and
`execution_role_arn` values to feed the compute module once the first release exists.

Parts of the IaC that need supplying by a person: SES domain DNS (DKIM tokens are the output `ses_dkim_tokens`), the SMS origination
identity (`sms_origination_identity_arn`, a purchase and carrier registration; null keeps SMS refused), VAPID keys
(`vapid_public_key`, `vapid_subject`, the private key's secret container `vapid_private_key_secret_name`), `security_contact_email`,
`patient_auth_domain`, `patient_oidc_*`, `chime_media_region`, retention periods (the day counts in the modules are **placeholders**, no
retention is approved: checklist item 13).

### 1.3 Approval records (`infra/approvals`) and GitHub roles

`infra/approvals` owns the GitHub OIDC providers, every `gh-*` role, the permission boundary and the `/approved/*` records
(DEVOPS-PLAN 4.1 A2, 7.4, 7.5). Every record is empty, so every role is denied by default in AWS.

1. A pull request adds a record to the matching `*_records` variable (schema and limits in `infra/modules/ci-trust`). CODEOWNERS
   approval by a human who is not the author, then a human `platform-admin-apply` apply. Remove the record and apply to revoke.
2. Records and what they enable:

| Record | Enables | Read by |
| --- | --- | --- |
| `/approved/staging-release` | role `gh-deploy-staging` | `deploy-staging.yml` |
| `/approved/release`, `/approved/recover` | `gh-deploy-production`, `gh-observe-production`, `gh-recover-production` | `deploy-production.yml` |
| `/approved/marketing-<env>` | `gh-deploy-marketing-<env>` | `deploy-marketing.yml` |
| `bootstrap-<env>` (two distinct approvers, expires within 24 h) | `gh-bootstrap-<env>` | `bootstrap.yml` |
| `/approved/audit-archive` (two distinct approvers, expires within 24 h) | `gh-audit-archive` | `audit-archive.yml` |
| restore-test record (one year at most) | `gh-restore-test` | `restore-test.yml` |

   The release record carries `state: approved`, `environment`, `manifest_hash`, `permitted_actions` (`migrate` exactly when the release
   adds a migration), `g3_reference`, approver, `not_before`/`expires`. Staging approval never authorises production.
3. Two-person records need a second human (checklist item 5). Until one exists, `bootstrap` and `audit-archive` cannot run.

### 1.4 GitHub environments and variables

Nothing below is a secret. Repository variables switch a workflow on; each workflow also refuses unless run from `main`. When its
variable is not `true` the run prints `::notice::not configured: <VAR>` and every cloud job is **skipped** (HEAAA-698).

| Workflow (file) | Repository variable that enables it | GitHub environment | Other variables |
| --- | --- | --- | --- |
| `infra.yml` plan (pull request) | `INFRA_PLAN_ENABLED` | `infra-plan` | `INFRA_PLAN_TARGETS`, `INFRA_AWS_REGION`, `INFRA_STATE_BUCKET`, `INFRA_STATE_REGION`, `INFRA_STATE_KMS_KEY_ARN` |
| `infra.yml` apply (dispatch: `target`, `approved_plan_sha256`) | `INFRA_APPLY_ENABLED` | `staging-infra`, `production-infra` | `INFRA_APPLY_ROLE_ARN`, `INFRA_PROVIDER_ROLE_ARN`, plus the state variables above |
| `build-release.yml` (push to `main`) | any `RELEASE_*` set (none set = dry-run manifest, nothing published; some set = fails) | `build` | `RELEASE_AWS_REGION`, `RELEASE_BUILD_ROLE_ARN`, `RELEASE_ECR_REGISTRY`, `RELEASE_ECR_REPOSITORY_PREFIX`, `RELEASE_STORE_BUCKET`, `RELEASE_SIGNING_KEY_ARN` |
| `deploy-staging.yml` | `DEPLOY_STAGING_ENABLED` | `staging` | `DEPLOY_*` below |
| `deploy-production.yml` | `DEPLOY_PRODUCTION_ENABLED` | `production` | `DEPLOY_*` below, `DEPLOY_OBSERVE_ROLE_ARN`, `DEPLOY_RECOVER_ROLE_ARN`, `DEPLOY_LB`, `DEPLOY_TG`, `DEPLOY_ALARM_PREFIX`, `DEPLOY_OBSERVE_MINUTES` |
| `deploy-marketing.yml` | `DEPLOY_MARKETING_ENABLED` | `marketing-staging`, `marketing-production` | `DEPLOY_SITE_FILTER`, `DEPLOY_SITE_DIR`, `DEPLOY_SITE_BUCKET`, `DEPLOY_SITE_DISTRIBUTION` |
| `bootstrap.yml` | `BOOTSTRAP_ENABLED` | `bootstrap-<env>` | `BOOTSTRAP_AWS_REGION`, `BOOTSTRAP_ROLE_ARN`, `BOOTSTRAP_CLUSTER`, `BOOTSTRAP_TASK_DEFINITION_ARN`, `BOOTSTRAP_SUBNETS`, `BOOTSTRAP_SECURITY_GROUP`, `BOOTSTRAP_LOG_GROUP`, `BOOTSTRAP_LOG_STREAM_PREFIX` |
| `audit-archive.yml` | `AUDIT_ARCHIVE_ENABLED` | `audit-archive` | `AUDIT_ARCHIVE_AWS_REGION`, `AUDIT_ARCHIVE_ROLE_ARN`, `AUDIT_ARCHIVE_CLUSTER`, `AUDIT_ARCHIVE_TASK_DEFINITION_ARN`, `AUDIT_ARCHIVE_SUBNETS`, `AUDIT_ARCHIVE_SECURITY_GROUP`, `AUDIT_ARCHIVE_LOG_GROUP`, `AUDIT_ARCHIVE_LOG_STREAM_PREFIX` |
| `restore-test.yml` (monthly, 05:17 UTC on the 2nd; dispatch `mode`) | `RESTORE_TEST_ENABLED` | `restore-test` | `RESTORE_AWS_REGION`, `RESTORE_ROLE_ARN`, `RESTORE_SOURCE_DB`, `RESTORE_SUBNET_GROUP`, `RESTORE_TARGET_SG`, `RESTORE_KMS_KEY_ARN`, `RESTORE_INSTANCE_CLASS`, `RESTORE_CLUSTER`, `RESTORE_TASK_DEFINITION_ARN`, `RESTORE_SUBNETS`, `RESTORE_TASK_SG`, `RESTORE_RESULT_BUCKET` |
| `nightly.yml` | `NIGHTLY_ENABLED` | `nightly-staging` | `NIGHTLY_STAGING_URLS`, `NIGHTLY_AWS_REGION`, `NIGHTLY_ROLE_ARN`, `NIGHTLY_DB_INSTANCE`, `NIGHTLY_BACKUP_VAULT` (optional `NIGHTLY_BACKUP_MAX_AGE_MINUTES`, `NIGHTLY_RECOVERY_POINT_MAX_AGE_HOURS`) |
| `loadtest-run.yml` (dispatch only), `loadtest-reaper.yml` (cron 2 h) | gate checks the variables; reaper also `LOADTEST_REAPER_ENABLED` = `true` | `loadtest` (needs required reviewers), `loadtest-reaper` | `LOADTEST_AWS_ROLE_ARN`, `LOADTEST_REAPER_AWS_ROLE_ARN`, `LOADTEST_STATE_BUCKET`, `LOADTEST_TFVARS_S3_URI`, `LOADTEST_PROD_PROFILE_S3_URI` |

`DEPLOY_*` (environment `staging` / `production` / `marketing-*`): `DEPLOY_AWS_REGION`, `DEPLOY_ROLE_ARN`, `DEPLOY_CLUSTER`,
`DEPLOY_API_SERVICE`, `DEPLOY_WORKER_SERVICE`, `DEPLOY_API_FAMILY`, `DEPLOY_WORKER_FAMILY`, `DEPLOY_MIGRATION_TASKDEF_ARN` (pinned by ARN),
`DEPLOY_SUBNETS`, `DEPLOY_SECURITY_GROUPS`, `DEPLOY_DB_INSTANCE`, `DEPLOY_BACKUP_MAX_AGE_MINUTES`, `DEPLOY_SNAPSHOT_TIMEOUT_MINUTES`,
`DEPLOY_MIN_CLIENT_PARAM`, `DEPLOY_PORTAL_BUCKET`, `DEPLOY_PORTAL_NAME`, `DEPLOY_PORTAL_DISTRIBUTION`, `DEPLOY_API_URL`, `DEPLOY_PORTAL_URL`.
Most values are outputs of the applied roots. Staging cannot be enabled until the conditions in `scripts/deploy/README.md` (C-14,
DPR-37..39) are applied and proven, and the permission gaps listed there (SSM parameters, RDS snapshot, portal bucket copy,
CloudFront invalidation, release-manifest retention) are closed by an IaC change.

Create each GitHub environment with required reviewers who are not the author. On a private personal-account repository, rulesets and
required review answered 403 (C-13): reviewer and CODEOWNERS rules are then procedural only; the AWS-side deny by default is what holds.

### 1.5 Release, deploy, smoke, observe, rollback

1. **Release.** `build-release.yml` on `main` builds, signs (`RELEASE_SIGNING_KEY_ARN`), writes SBOM and provenance, and emits
   `release-manifest.json` (artifact `release-artifacts-<run id>`). Its sha256 is the `manifest_hash`.
2. **Staging.** Dispatch `deploy-staging.yml` with `manifest_hash`, `build_run_id`, optional `rollback_rehearsal` (deploying an older
   number on purpose). Staging first, always; do a rollback rehearsal here.
3. **Production.** After exact-environment G3 and the `/approved/release` record applied: dispatch `deploy-production.yml` with
   `manifest_hash`, `build_run_id`, and `previous_build_run_id` (the rollback target; empty only for the first release). Concurrency group
   `production-release`. Sequence: verify → backup freshness → snapshot (if a migration) → migrate → worker → api → portal switch →
   smoke (`/healthz`, `/readyz`, `release.json`) → observe (read-only) → recover (only if the rollout began, a prior job failed, and
   the `recover` record allows it).
4. **Marketing.** `deploy-marketing.yml` with `target`, `manifest_hash`, `build_run_id`. Separate from the product sequence.
5. **Rollback.** Only the approved recover path. The recover job runs when `observe.mjs` exits 2 (`breach=true`). An application rollback
   is not proof the database was restored: database recovery is `docs/runbooks/restore.md` (PITR or backup restore, by the incident
   commander, with the AWS break-glass role). RPO 15 min and RTO 4 h are **targets**; no value has been measured.
6. **Restore proof.** Enable `restore-test.yml` (section 4.1 of `docs/runbooks/restore.md`) and record the first result in
   `OPERATIONS-HANDOFF.md`.

## Part 2. AWS adapter configuration table

The application selects each adapter from environment variables. Rule (`packages/kernel/src/aws/config.ts`): none set = the refusing port
stays, one `not configured` log line; all set = the AWS adapter is built; some set = startup fails (`AwsConfigError`, names the variables,
never a value). The IaC column is the output of `infra/modules/aws-adapters` (branch `HEAAA-709-aws-iac`) fed into the compute module
(`services.*.environment` / `secret_references`); nothing here has been applied.

Never set in AWS: `EHR_AWS_ENDPOINT_URL`, `EHR_AWS_S3_FORCE_PATH_STYLE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (emulator only; the task role is used).

| Adapter | Variables (all together) | Process | Comes from |
| --- | --- | --- | --- |
| Region (all) | `AWS_REGION` | api, worker | `api_environment` / `worker_environment` |
| Documents object store (S3) | `EHR_S3_DOCS_QUARANTINE_BUCKET`, `EHR_S3_DOCS_CLEAN_BUCKET`, `EHR_S3_DOCS_KMS_KEY_ID` | api, worker | `modules/storage` bucket names; account data key |
| Privacy package store | `EHR_S3_PACKAGE_BUCKET`, `EHR_S3_PACKAGE_KMS_KEY_ID` | api, worker | output `package_bucket_name`; data key |
| Audit export sink | `EHR_S3_EXPORT_BUCKET`, `EHR_S3_EXPORT_KMS_KEY_ID` | worker | output `export_bucket_name`; data key |
| Audit anchor archive (Object Lock) | `EHR_S3_ANCHOR_ARCHIVE_BUCKET`, `EHR_S3_ANCHOR_ARCHIVE_KMS_KEY_ID` | worker | `modules/archive` (`log-archive/archive.tf`, staging `adapters.tf`) |
| Secret store (Secrets Manager) | `EHR_SECRETS_PREFIX` (environment name); optional `EHR_SECRETS_KMS_KEY_ID` | api, worker | `var.env`; secrets key |
| Payload sealer / opener (KMS) | `EHR_KMS_PAYLOAD_KEY_ID`; worker optional `EHR_KMS_PAYLOAD_PREVIOUS_KEY_IDS` | api (seal), worker (open) | output `payload_key_arn`; `payload_previous_key_arns` |
| E-mail (SES v2) | `EHR_SES_FROM_ADDRESS`; optional `EHR_SES_CONFIGURATION_SET` | worker | `ses_from_address`; output `ses_configuration_set_name` |
| SMS (End User Messaging) | `EHR_SMS_ORIGINATION_IDENTITY`; optional `EHR_SMS_CONFIGURATION_SET` | worker | `sms_origination_identity_arn` (a purchase); null = SMS refused |
| Security notice (B2-9) | `EHR_SECURITY_CONTACT_EMAIL` (also needs `EHR_SES_FROM_ADDRESS`) | worker | `security_contact_email` |
| Web Push (VAPID, not AWS) | `EHR_VAPID_PUBLIC_KEY`, `EHR_VAPID_PRIVATE_KEY`, `EHR_VAPID_SUBJECT` | worker | public key and subject as variables; private key injected by secret name (`worker_secret_references`, `vapid_private_key_secret_name`) |
| Video (Chime SDK Meetings) | `EHR_CHIME_MEDIA_REGION` | api (join token), worker (create, close) | `chime_media_region`; IAM only |
| Malware scan (GuardDuty tag reader) | `EHR_MALWARE_SCAN=guardduty` + the two documents bucket variables | worker | plan `guardduty_plan_arn` on the quarantine bucket |
| OCR (Textract) | `EHR_OCR=textract` + the two documents bucket variables | worker | worker role `textract:DetectDocumentText` |
| Patient identity (Cognito) | `EHR_PATIENT_OIDC_ISSUER`, `..._JWKS_URI`, `..._AUTHORIZATION_ENDPOINT`, `..._TOKEN_ENDPOINT`, `..._CLIENT_ID`, `..._REDIRECT_URI` | api | `modules/identity` pool and client; `patient_auth_domain` |

Video and OCR also need an enabled `integration_core.connection` row (`video`/`chime`, `ocr`/`textract`); e-mail, SMS and push need one of
their kind. The adapters ignore the row's credentials. Roles: `<env>-ehr-api-task`, `<env>-ehr-worker-task`, `<env>-ehr-task-execution`,
`<env>-ehr-guardduty-s3-scan` (fixed names, asserted in `tests/plan.tftest.hcl`). The api cannot open payloads and the worker cannot seal.

## Part 3. Go-live checklist

Every item is **NOT DONE**. "Owner" is who must act; "Unblocks" is what stays blocked or unverified until then. Condition IDs are
from the register in `docs/DELIVERY-PLAN.md`.

| # | Item | Owner | Status | Unblocks |
| --- | --- | --- | --- | --- |
| 1 | AWS organisation, accounts, named platform admins, SCP owner, home and recovery Region (C-01, C-21, C-12) | Product owner | NOT DONE | everything in Part 1; every real-service check |
| 2 | Cost approval for infrastructure, SES/SMS, Chime, Textract, GuardDuty, load-test stack (C-12, C-17, D-25) | Product owner | NOT DONE | first apply of any root; load and restore cases |
| 3 | AWS BAA signed (C-11) | Product owner | NOT DONE | any PHI in AWS |
| 4 | HIPAA-eligible service list confirmed for Chime SDK, Cognito, Textract, GuardDuty Malware Protection, SES, End User Messaging (and its Region availability); push-service BAA ruling (NFR-19 V-07) | Product owner, counsel | NOT DONE | choosing services as final; the push channel |
| 5 | Second human and a GitHub Team/organisation plan with rulesets and required review (C-13, RK-5) | Product owner | NOT DONE | real two-person approvals, `bootstrap`, `audit-archive`, branch protection beyond procedure |
| 6 | TC-PERF on a production-equivalent `loadtest` stack (C-17); k6 AGPL licence decision (C-22) | Product owner, counsel | NOT DONE | performance evidence; no load case is run smaller to claim a pass |
| 7 | TC-REC: restore, PITR and DR rehearsal in staging; first measured RPO and RTO | DevOps, operations owner | NOT DONE | any RPO/RTO claim; enabling `restore-test.yml` |
| 8 | TC-PEN-01 independent penetration test within 30 days of the first production deploy (RA-PEN-01). Scope draft: `docs/security/TC-PEN-01-scope-and-rules-of-engagement.md`; tester, window, budget, targets, signatory all OPEN | Product owner, Cybersecurity | NOT DONE | security acceptance after deploy; needs a deployed staging for the target URLs |
| 9 | Human assistive-technology checks (screen reader, keyboard, zoom) and real-device checks (phones, tablets) | QA, Product owner | NOT DONE | accessibility and device acceptance; automation (axe) is not a substitute |
| 10 | Real adapters verified on staging, section "Real-service checks" below | DevOps, QA | NOT DONE | each adapter in Part 2 as "verified" |
| 11 | Clinician safety reviewer named (D-12a, C-03) | Product owner | NOT DONE | red-flag alert and consent-gate rules (RA-R1-07, RA-R1-08); every rule text and threshold |
| 12 | Counsel on the meaning of deletion (D-8, C-05) | Product owner, counsel | NOT DONE | deletion requests (nothing is deleted today); TC-PR-03 |
| 13 | Retention periods for audit, log, backup, export, flow-log and anchor data (C-20) | Product owner, counsel | NOT DONE | replacing the placeholder day counts in the IaC; TC-AU-09, TC-DOC-07 |
| 14 | Operating states and state privacy rules (D-2, C-06) | Product owner | NOT DONE | real licensing-state values; telehealth rules (TC-TH-06..08) |
| 15 | Proxy rules (D-7, C-04) | Product owner | NOT DONE | link creation, verification, age-out, revocation (RA-R1-20b, AC-32) |
| 16 | On-call rota (D-29, C-18) | Product owner, operations owner | NOT DONE | alert-delivery evidence and the go-live itself; 99.9 % stays a target |
| 17 | CMS runtime versus SaaS CMS (C-19) | Product owner | NOT DONE | FE-16 marketing CMS path; cost of the marketing account |
| 18 | Google Workspace test tenant (C-10) for staff identity and calendar | Product owner | NOT DONE | real Google sign-in and calendar sync checks |
| 19 | UMLS licence (C-09) | Product owner | NOT DONE | real terminology content, TC-CL-04 |
| 20 | Production GitHub environments, reviewers and the approved-release records (section 1.3 and 1.4); staging conditions C-14 (DPR-37..39) applied and proven | Platform admin, second human | NOT DONE | every `*_ENABLED` variable |
| 21 | SES domain DNS (DKIM, SPF, DMARC), SES production access, SMS origination identity and carrier registration (10DLC or toll-free where required), VAPID keys | DevOps, Product owner | NOT DONE | e-mail, SMS, push |
| 22 | Network and edge items: ACM certificates, Cognito custom domain, WAF logging, budget e-mails (inputs of the compute, edge and loadtest modules) | DevOps | NOT DONE | public endpoints |
| 23 | Staging proofs of DEVOPS-PLAN 7.5 and TC-SEC-11 (rotation, `secretsmanager:KmsKeyId` conditions, `RunTask` override detection, key policies without root delegation) | DevOps, Security | NOT DONE | the first `bootstrap` run (G-6 in `scripts/bootstrap/README.md`) |
| 24 | Exact-environment G3 and OPERATIONS_RECEIPT | Product owner | NOT DONE | any production mutation |

### Real-service checks (all NOT DONE; nothing here was observed)

Run on staging with synthetic data, record in the G3 package, never in this file as passed until a dated record exists.

- **S3 and KMS:** presigned PUT refused when headers differ; Object Lock retention on the anchor bucket; no delete path for the worker;
  SSE-KMS on every write; key policy and `kms:EncryptionContextKeys` conditions; the api role cannot Decrypt the payload key; a rotated key
  still opens old blobs (`EHR_KMS_PAYLOAD_PREVIOUS_KEY_IDS`).
- **Secrets Manager:** create-then-put race, `ClientRequestToken` idempotency, `AWSPREVIOUS` read of the calendar channel key.
- **SES:** verified identity, production access, DKIM/SPF/DMARC, real bounce and complaint event shape.
- **SMS:** registered origination identity out of the sandbox, a real delivery.
- **Push:** a message delivered to a real browser.
- **Chime:** a real meeting with two attendees and no recording; real join-token lifetime and revocation after `DeleteMeeting`.
- **GuardDuty:** real scan tag values for clean, EICAR and unsupported files; latency against the 30-minute wait.
- **Textract:** accuracy on real insurance cards and ID documents; multi-page PDFs.
- **Cognito:** sign-in end to end, passkey, MFA, replica.

### Ports that still refuse by design

Each stays refusing until its configuration group (Part 2) is complete. This is the intended behaviour, not a defect. Source:
`apps/api/src/composition.ts`, `apps/worker/src/compose.ts`, AWS-BE-3 and AWS-BE-4 sections of `docs/runbooks/AWS-ADAPTERS.md`.

| Port | Refuses with | Becomes real when |
| --- | --- | --- |
| Documents object store, privacy package store (api) | upload and download URL refused | the S3 groups are set |
| Secret store, payload sealer (api, calendar and integration) | secret write refused | `EHR_SECRETS_PREFIX`, `EHR_KMS_PAYLOAD_KEY_ID` |
| Worker `secret_store`, `payload_opener`, `calendar_channel_key` | job handler fails at the port | same variables on the worker |
| Anchor archive (worker) | anchor not archived, alert | `EHR_S3_ANCHOR_ARCHIVE_*` and the Object Lock bucket |
| Video vendor | join answers 503 `telehealth.vendor_unavailable` | `EHR_CHIME_MEDIA_REGION`, `video` connection row |
| E-mail, SMS, push gateway adapters | `no adapter` | their groups and connection rows |
| Security notice (`security_notice`) | notice not sent | `EHR_SECURITY_CONTACT_EMAIL`, `EHR_SES_FROM_ADDRESS` |
| Malware scan | scanner missing is an error, never `clean` | `EHR_MALWARE_SCAN=guardduty` |
| OCR | suggestions `skipped` | `EHR_OCR=textract` |
| Calendar OAuth (`refusingOAuth`), calendar webhook URL | calendar link unavailable | a Google Workspace OAuth client (C-10) and the webhook URL option |
| Approval evidence verifier (`refusingVerifier`) | `no_verifier_configured`, nothing accepted | the identity verifier is supplied |
| `compliance_alerts` (worker) | refused without API ports | composed with the built API ports |

Known gaps with no code yet, so they stay on this list rather than being configured:

- Delivery receipts (INT-N2): **the end-to-end path does not record receipts yet.** What exists: the inbound route `POST /webhooks/sns/receipts` (SNS signature version 2, pinned certificate and subscribe host, TopicArn allowlist, freshness and replay checks, SES and SMS event mapping) and the IaC (`infra/modules/aws-adapters/receipts.tf`, opt-in with `receipt_endpoint_url`). What is missing: (1) the worker never registers the receipt handler (`registerReceiptHandlers` in `apps/worker/src/jobs/notifications/receipt.ts` has no caller; `apps/worker/src/compose.ts` registers only the Google push handler), so nothing writes `notifications.delivery_receipt`; (2) no payload opener/sealer is composed in `main.ts` and no KMS sealer exists in the repository, so a verified message is answered 503 at the store (nothing is stored unsealed) and the worker has no opener to read stored payloads; (3) the pinned AWS provider has no SMS event-destination resource (`docs/evidence/HEAAA-773/provider-schema-pinpointsmsvoicev2.txt`), so that one destination is a CLI step in the runbook; (4) the SES/SMS event shapes and the SNS confirmation handshake are from documentation, unverified; (5) `receipt_endpoint_url` is not set in the account roots (needs the integrations host name). **Tested only with self-generated certificates and signatures, a fake database and `tofu validate`/`tofu test`; never against SNS, SES or End User Messaging, and not run against PostgreSQL.** `docs/runbooks/AWS-ADAPTERS.md` "Receipts" has the detail.
- The partner identity pool has no sign-in code in R1 (partner portal is R2).
- The `telehealth.close_meeting` dead-job alarm is configured on the worker's generic `job_dead` line, but no `telehealth.close_meeting` job type exists in the repository yet, so it fires only once that job is added.
- The payload KMS key replica is `aws_kms_replica_key.payload_recovery` in `infra/accounts/production/adapters.tf` (same policy, `aws.recovery`); authored only, not applied.
- Recovery-Region role policies and the VAPID secret replica are now IaC (`infra/modules/aws-adapters/recovery.tf`, production root) but **authored only,
  never applied**. Remaining: nothing was exercised by a task in the recovery Region; upload, package/export, runtime integration secrets, SES/SMS,
  the anchor archive and malware scanning are not granted there (no replica or Region-bound); whether the secret replica needs its own resource
  policy is unverified; the recovery runbook still creates the compute during a declared failover.
- Chime offers no per-token lifetime: the "short-lived" bound is only in our own record.
- Load scenarios (QA-07) are wired into `loadtest-run.yml` between the two cost guards through `tests/load/run-suite.sh` (perf-01..04, 06..08, rec-04, rec-07; TC-PERF-05 stays with Lighthouse). **Mechanics only, not a capacity result:** the suite was run only against the localhost fixture at tiny scale (`tests/load/evidence/suite-mechanics-HEAAA-776.txt`); the workflow was never run (no AWS account, no hosted CI) and no NFR-6..9 result exists. A case that cannot run is `NOT_RUN` and fails the job, never a pass. Remaining: the seeder does not yet emit the sessions and ids files or the API URL (variables `LOADTEST_BASE_URL`, `LOADTEST_HOSTS`, `LOADTEST_SESSIONS_S3_URI`, `LOADTEST_IDS_S3_URI`); perf-06 needs `LOADTEST_VENDOR_SANDBOX=1`; the SQL reconciliations (`check-audit`, `check-exactly-one`, `check-recovery`) need `LOADTEST_RO_DATABASE_URL_SECRET_ID`; TC-REC-04/07 disruptions are DevOps' OPS part and are not injected; perf-08 leak/queue-growth has no checker.
- Bootstrap interface points and deploy permission gaps (`scripts/bootstrap/README.md`, `scripts/deploy/README.md`): G-1 (token-secret delete), G-2 (task log read, rotation), G-4 (record field names) and deploy permission gaps 1-3 are now IaC in `infra/modules/ci-trust` (authored, `tofu test` with mock providers only, never applied; the production/staging roots must still pass the new `refs`). Remaining: G-3 and the result field names depend on the bootstrap task (not built); G-5 (audit archive task and `audit_archiver` grants) is application and database work; deploy gaps 4-5 need workflow edits (`gh run download` retention, a release-store source bucket variable for `portal-switch --source-bucket`) and a cross-account bucket policy; G-6 needs an AWS account and a second human (TC-SEC-11).

## Evidence rules

- Emulator results (`pnpm test:emulator`, the `emulator` job in `ci.yml`, LocalStack 4.9.2) are **emulator evidence only**. Textract, Chime,
  End User Messaging SMS, GuardDuty Malware Protection for S3 and Cognito are not emulated; unit tests with SDK stubs cover them.
- `tofu validate`, `tofu test` (mock providers) and policy scans show plan shape and rendered policy, not AWS behaviour.
- A skipped workflow is never a deployment, a load test or a restore. `ci-status` does not count AWS workflows.
- Staging or demo approval never authorises production. A change to scope or revision reopens the affected review and G3.
