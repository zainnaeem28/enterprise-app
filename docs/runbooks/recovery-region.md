# Recovery Region: what runs there, what is degraded, how it catches up

Scope: a declared Region failover of production (home Region to the recovery Region). IaC is **authored, never applied** (R1 deploys nothing); nothing here was exercised by a task in the recovery Region. The rehearsal in `docs/runbooks/restore.md` section 6 proves it, and failures stay recorded as failures. Source of the grants: `infra/modules/aws-adapters/recovery.tf`, `infra/modules/secrets`, `infra/modules/storage`, production root `infra/accounts/production/adapters.tf`. The environment to give the recovery task definitions is the root output `recovery_environment`.

## 1. Outcome per service

| Service | Outcome in the recovery Region | What is there (IaC) |
| --- | --- | --- |
| Document upload | **Granted** | Region-bound quarantine bucket `<prefix>-docs-quarantine-dr` (KMS data key replica, TLS and KMS-only writes, 7-day expiry); api presign `PutObject` on `q/*`; worker scan promotion writes into the clean replica bucket (its policy now also denies unencrypted writes and any writer except the worker role). |
| Document download | Granted (earlier) | Clean replica bucket (RTC replication), data key replica. |
| Package / export | **Granted** | Region-bound `<prefix>-privacy-packages-dr` and `<prefix>-audit-exports-dr`, same hardening; only the worker writes. They start empty: a package is a 7-day regenerable download and an export is a copy of the audit archive. |
| Runtime integration secrets | **Granted for new secrets; existing ones degraded** | api and worker may create, write and read `<env>/integration/...` in the recovery Region under `production-secrets-dr`. Secrets the application created in the home Region are **not** replicated: it creates them at run time without replicas. See 2.2. |
| Replicated secrets (VAPID, database) | Granted (earlier) + **resource policy now explicit** | A replica does not inherit its primary's resource policy, so the `secrets` module attaches the same policy (reader pin, organisation and TLS conditions) to each replica (`aws_secretsmanager_secret_policy.replica`). Whether AWS applies it exactly as authored is confirmed in the rehearsal. |
| E-mail (SES) | **Granted** | Domain identity and configuration set in the recovery Region; worker `SendEmail` on them. The identity has its own DKIM tokens: publish the three CNAMEs (`recovery_ses_dkim_tokens`) and request SES production access there before go-live. |
| SMS | **Granted if an identity is supplied, else degraded** | `recovery_sms_origination_identity_arn` (a purchase and a carrier registration, so an input). Supplied: the configuration set and `SendTextMessage` are granted and `recovery_environment.worker` carries the identity. Null: see 2.3. |
| Malware scanning | **Granted** | GuardDuty Malware Protection plan on the recovery quarantine bucket (`q/` prefix, tagging on), scan role extended by a second policy for the recovery bucket, managed rule and key replica. The tag contract is the same as in the home Region. |
| Audit anchor archive | **Degraded** (cannot reasonably run there in R1) | See 2.1. |

## 2. Degraded modes

### 2.1 Audit anchor archive (Object Lock)

Why it is not granted: the archive bucket and its key are in the log-archive account and bound to the home Region (key policy, `ViaService`). A recovery-Region archive means a second Object Lock bucket with its own compliance-mode retention in that account, a separate legal-retention decision, and a chain that would then live in two archives. That is not reasonable inside R1.

What users see: nothing. Anchors keep being produced in the database; no user-facing feature depends on the archive.

How data is queued: the anchor rows are the queue. The worker job `audit.archive_anchors` (every minute) selects every anchor without an `audit.anchor_archive_receipt`; with `EHR_S3_ANCHOR_ARCHIVE_BUCKET` and `EHR_S3_ANCHOR_ARCHIVE_KMS_KEY_ID` left unset (the recovery environment unsets them) the port refuses, the job fails and the anchor stays without receipt. The "anchor not archived" alert fires: acknowledge it as expected for the failover, do not silence it.

How it catches up after failback: when the home Region is back, restore the two variables on the worker and the same job copies every anchor that has no receipt (conditional put, `If-None-Match`; a repeat is harmless), recording a receipt for each. Then run the anchor-chain verification and compare the archive's object count with the anchors created during the failover. Until that is done, the failover period's audit chain is protected by the database only, not by the Object Lock copy: record this exposure window in the incident record. If the failover outlasts the retention expectation in the compliance register, raise it as a decision for the owner of that register.

### 2.2 Runtime integration secrets created before the failover

What users see: an integration connection that depends on a stored outbound or inbound secret shows as needing re-authorisation (the port fails closed: a missing secret is an error, never a default), and inbound webhooks that need a verification key are refused until it exists again. Connections whose secret is created in the recovery Region work from then on.

How it is queued: nothing is queued silently; outbound calls fail visibly and retry by the normal job policy.

First step of a failover while the home Region's Secrets Manager still answers (partial outage): copy the integration secrets with `aws secretsmanager replicate-secret-to-regions` for each `<env>/integration/*` secret, under `production-secrets-dr`. In a full Region loss that call is not possible: the connection owners re-enter the credentials in the recovery Region. After failback the home Region's secrets are authoritative; secrets created in the recovery Region are re-created there by the owner. Permanent fix (a follow-up ticket for the application): create runtime secrets with a replica in the recovery Region so IaC grants cover them.

### 2.3 SMS without a recovery-Region identity

What users see: the application refuses SMS, as it does whenever SMS is unconfigured. A message that has another channel can use it; an SMS-only message is not delivered while the mode lasts. Cognito's own SMS follows the identity module's Region and is unaffected by this section.

How it is queued: a refused send fails its job and follows the normal job retry and dead-job policy; nothing is silently marked sent. Whether a given message type retries until the home Region is back or goes dead is **not verified**: check the job type's policy during the rehearsal and, for a type that goes dead before failback, re-send from the dead-job list after failback.

Catch-up: when the home Region is back (or an identity is registered in the recovery Region and `recovery_sms_origination_identity_arn` is applied), pending retries send; review the dead-job list for SMS job types and re-send what is still wanted.

## 3. Failover order for these services

1. Apply the workload IaC in the recovery Region and read `recovery_environment` (output of the production root).
2. Pre-registered task-definition revisions: merge `common` into both services and `worker` into the worker; **unset** the names in `worker_unset`.
3. Copy runtime integration secrets if the home Region still answers (2.2).
4. Smoke: upload a test file (scan tag appears, promotion lands in the clean replica), request a package, send a mail, read a replicated secret, observe the anchor alert as expected.
5. Failback: reverse the document copy (objects promoted into the clean replica during the failover are copied back to the home clean bucket before the home Region takes writes), restore the anchor variables, let the anchor job catch up (2.1), and re-create runtime secrets (2.2).

## 4. Not verified

Nothing in this runbook ran against a Region. In particular: the GuardDuty plan and its tag values in us-west-2, SES production access and DKIM verification there, the replica secret policy, the reverse document copy, and the catch-up of the anchor job after a long gap.
