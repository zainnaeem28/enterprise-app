# Recovery Region: what runs there, what is degraded, how it catches up

Scope: a declared Region failover of production (home Region to the recovery Region). IaC is **authored, never applied** (R1 deploys nothing); nothing here was exercised by a task in the recovery Region. The rehearsal in `docs/runbooks/restore.md` section 6 proves it, and failures stay recorded as failures. Source of the grants: `infra/modules/aws-adapters/recovery.tf`, `infra/modules/secrets`, `infra/modules/storage`, production root `infra/accounts/production/adapters.tf`. The environment to give the recovery task definitions is the root output `recovery_environment`.

## 1. Outcome per service

| Service | Outcome in the recovery Region | What is there (IaC) |
| --- | --- | --- |
| Document upload | **Granted** | Region-bound quarantine bucket `<prefix>-docs-quarantine-dr` (KMS data key replica, TLS and KMS-only writes, 7-day expiry); api presign `PutObject` on `q/*`; worker scan promotion writes into the clean replica bucket (its policy now also denies unencrypted writes and any writer except the worker role). |
| Document download | Granted (earlier) | Clean replica bucket (RTC replication), data key replica. |
| Package / export | **Granted** | Region-bound `<prefix>-privacy-packages-dr` and `<prefix>-audit-exports-dr`, same hardening; only the worker writes. They start empty: a package is a 7-day regenerable download and an export is a copy of the audit archive. |
| Runtime integration secrets | **Replicated at creation; promoted at failover** | The application creates each `<env>/integration/...` secret with a replica in the recovery Region under `production-secrets-dr` (`AddReplicaRegions`, HEAAA-860). A worker check finds replicas that are not in sync (alarm `secret-replica-not-in-sync`). At failover the operator promotes each replica. See 2.2. |
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

### 2.2 Runtime integration secrets

What is in place: `EHR_SECRETS_REPLICA_REGION` and `EHR_SECRETS_REPLICA_KMS_KEY_ID` (production only, from `recovery_region` and `production-secrets-dr`) make the application create every new `<env>/integration/outbound|inbound/*` secret with a replica in the recovery Region. Later versions reach the replica through replication. No resource policy is attached to runtime secrets in either Region (SC-2: access is by the api and worker role policies). Production has never been deployed, so no existing secret needs a backfill.

What users see at failover: nothing extra for a replicated secret once it is promoted. Until it is promoted, a replica is read-only: reads work, but the application's `PutSecretValue` in the recovery Region fails (a new secret or a new version of an existing one). A secret that has no replica (see "Fallback") shows as needing re-authorisation: the port fails closed, a missing secret is an error, never a default, and inbound webhooks that need a verification key are refused until it exists again.

How it is queued: nothing is queued silently; outbound calls fail visibly and retry by the normal job policy.

Detection (automatic, before it is needed): the worker job `integration_core.check_secret_replicas` runs every 15 minutes in production, reads `ReplicationStatus` of every `<env>/integration/*` secret (metadata only, never the value) and publishes `SecretReplicaNotInSync` (the count, 0 included). The alarm `secret-replica-not-in-sync` (ticket) fires after two periods above 0, or when the check stops publishing. A replica is counted when it is missing, `Failed`, on a key other than `production-secrets-dr`, or `InProgress` for more than 60 minutes. Response to the alarm: find the named secrets in the worker log (`event=secret_replica_unhealthy`, with name, Region and status), repair each one while the home Region answers with `aws secretsmanager replicate-secret-to-regions --secret-id <name> --add-replica-regions Region=<recovery>,KmsKeyId=<production-secrets-dr ARN>` (operator role; add `--force-overwrite-replica-secret` only after checking that the recovery-Region secret of that name is a stale replica), and confirm the gauge returns to 0.

Failover: while the recovery Region is being brought up, for each `<env>/integration/*` secret run `aws secretsmanager stop-replication-to-replica --secret-id <name> --region <recovery>` (operator role). That makes the replica a standalone secret that the recovery-Region tasks can write. The recovery-Region task definitions must **not** set the two replica variables: they are listed in `recovery_environment.common_unset`, and the application refuses to start when the replica Region equals `AWS_REGION`. At a real home-Region loss, CloudWatch in the home Region may not answer, so use the alarm notifications already delivered (the ticket raised by `secret-replica-not-in-sync`, and whether it was resolved) to learn before promotion which secrets were missing a replica.

Fallback: a secret that was created before replication was configured, or whose replica is `Failed` or was named by an unresolved alarm, is not available in the recovery Region. While the home Region's Secrets Manager still answers (partial outage), copy it with `replicate-secret-to-regions` as above. In a full Region loss the connection owners re-enter the credentials in the recovery Region.

Failback: the home Region's secrets are authoritative. Secrets written in the recovery Region after promotion are re-entered by the owner (or re-replicated back), and stale replicas and promoted copies are removed by the operator.

Rehearsal: list `<env>/integration/*` (`aws secretsmanager list-secrets`, then `describe-secret`) and confirm every `ReplicationStatus` is `InSync`; promote one replica and write a test version in the recovery Region; also create a deliberately unreplicated test secret and confirm the gauge goes above 0, the alarm fires, and the gauge returns to 0 after repair.

### 2.3 SMS without a recovery-Region identity

What users see: the application refuses SMS, as it does whenever SMS is unconfigured. A message that has another channel can use it; an SMS-only message is not delivered while the mode lasts. Cognito's own SMS follows the identity module's Region and is unaffected by this section.

How it is queued: a refused send fails its job and follows the normal job retry and dead-job policy; nothing is silently marked sent. Whether a given message type retries until the home Region is back or goes dead is **not verified**: check the job type's policy during the rehearsal and, for a type that goes dead before failback, re-send from the dead-job list after failback.

Catch-up: when the home Region is back (or an identity is registered in the recovery Region and `recovery_sms_origination_identity_arn` is applied), pending retries send; review the dead-job list for SMS job types and re-send what is still wanted.

## 3. Failover order for these services

1. Apply the workload IaC in the recovery Region and read `recovery_environment` (output of the production root).
2. Pre-registered task-definition revisions: merge `common` into both services and `worker` into the worker; **unset** the names in `common_unset` (both services) and `worker_unset` (worker).
3. Promote the runtime integration secret replicas (2.2); copy any secret without a replica if the home Region still answers.
4. Smoke: upload a test file (scan tag appears, promotion lands in the clean replica), request a package, send a mail, read a replicated secret, observe the anchor alert as expected.
5. Failback: reverse the document copy (objects promoted into the clean replica during the failover are copied back to the home clean bucket before the home Region takes writes), restore the anchor variables, let the anchor job catch up (2.1), and clean up the promoted runtime secrets (2.2, Failback).

## 4. Not verified

Nothing in this runbook ran against a Region. In particular: the GuardDuty plan and its tag values in us-west-2, SES production access and DKIM verification there, the replica secret policy, the reverse document copy, and the catch-up of the anchor job after a long gap.
