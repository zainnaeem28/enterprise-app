# AWS adapters runbook

This file is referenced from the `aws-adapters` module and `docs/GO-LIVE.md`. It currently holds the **Receipts** section only; the other adapter notes are in `infra/modules/aws-adapters/README.md`.

## Receipts

Delivery receipts for e-mail (SES) and SMS (End User Messaging SMS) reach the API as Amazon SNS HTTPS notifications.

**Flow.** SES configuration-set event destination (events `DELIVERY`, `BOUNCE`, `COMPLAINT`) and the SMS configuration-set event destination each publish to
their own SNS topic. Each topic has an HTTPS subscription to `POST https://<integrations host>/webhooks/sns/receipts`
(`apps/api/src/modules/integrations-host`). The route verifies the message, maps the event to `{providerMessageId, eventId, status, occurredAt}`, seals it and
stores it through integration-core's inbound path with source `email` or `sms`, type `delivery_receipt`, event ID = the SNS `MessageId`. The worker's
`notifications.on_receipt` then writes the append-only `notifications.delivery_receipt` row, idempotent by `(organisation, notification, vendor_event_id)`.
Only those four fields are kept: no address, phone number or bounce diagnostic is stored or logged.

**Verification (every message, no exceptions).**

| Rule | Behaviour |
| --- | --- |
| `SignatureVersion` | only `2` (SHA256 with RSA); `1` is refused (401) |
| `TopicArn` | must be in `EHR_SNS_RECEIPT_TOPICS`; checked before any certificate fetch |
| `SigningCertURL` | `https` on exactly `sns.<EHR_SNS_RECEIPT_REGION>.amazonaws.com`, no port or credentials, path `/SimpleNotificationService-<id>.pem`, no query |
| certificate | inside its validity period, RSA, optionally chained to `EHR_SNS_TRUST_ANCHORS_PEM`; fetched without redirects, 5 s, 16 KB, cached 1 h |
| `Timestamp` | not older than `EHR_SNS_RECEIPT_MAX_AGE_SECONDS` (default 3600) and not more than 5 min ahead |
| replay | a stored `MessageId` is answered 200 and does nothing; across processes the inbound unique key (source, `MessageId`) makes it a duplicate |
| `SubscriptionConfirmation` | after signature check, `SubscribeURL` must be the pinned host with `Action=ConfirmSubscription` and this message's `TopicArn` and `Token`; then requested once |
| `UnsubscribeConfirmation` | acknowledged (200), logged by class, never re-subscribed automatically |

Answers: 200 stored/duplicate/ignored/confirmed, 400 malformed, 401 failed verification (not stored), 404 route not configured, 503 store or fetch failed (SNS retries).
SES events other than the three, and SMS non-final states (`TEXT_PENDING`, `TEXT_QUEUED`, `TEXT_SUCCESSFUL`, `TEXT_UNKNOWN`), are acknowledged and not stored.
SMS `TEXT_DELIVERED` is `delivered`; `TEXT_INVALID`, `TEXT_INVALID_MESSAGE`, `TEXT_UNREACHABLE`, `TEXT_CARRIER_UNREACHABLE`, `TEXT_BLOCKED`, `TEXT_CARRIER_BLOCKED`, `TEXT_SPAM`, `TEXT_TTL_EXPIRED` are `failed`.

**Configuration (API process).** All four unset: the route answers 404. Otherwise `EHR_SNS_RECEIPT_REGION` and `EHR_SNS_RECEIPT_TOPICS`
(`<TopicArn>=email,<TopicArn>=sms`) are required and a bad value stops the start with its name. The `aws-adapters` module emits both in `api_environment` when `receipt_endpoint_url` is set.

**Infrastructure.** `infra/modules/aws-adapters/receipts.tf` (set `receipt_endpoint_url = "https://<integrations host>/webhooks/sns/receipts"`): encrypted topics with a
publish policy limited to the account and the configuration set, the SES event destination, and the HTTPS subscriptions (raw message delivery off, auto-confirm off).

**SMS event destination (manual, once).** The pinned Terraform provider cannot create it. After the module is applied, with the `sms` topic ARN from output `receipt_topic_arns`:

```sh
aws pinpoint-sms-voice-v2 create-event-destination \
  --configuration-set-name <env>-ehr-sms --event-destination-name <env>-ehr-receipts \
  --matching-event-types TEXT_DELIVERED TEXT_INVALID TEXT_INVALID_MESSAGE TEXT_UNREACHABLE TEXT_CARRIER_UNREACHABLE TEXT_BLOCKED TEXT_CARRIER_BLOCKED TEXT_SPAM TEXT_TTL_EXPIRED \
  --sns-destination TopicArn=<sms topic arn>
```

**Before this works for real (all unverified, nothing was run against AWS).**

- The API must be reachable from SNS on the integrations host and able to reach `sns.<region>.amazonaws.com` (certificate and confirmation GETs) from its subnets.
- The payload sealer for inbound messages is not composed in `main.ts` yet: until it is, a verified message is answered 503 at the store (nothing is stored unsealed).
- The SES/SMS event field names and event types are taken from the vendors' documentation, never seen in a real delivery. The SNS signing rules are implemented from the SNS documentation and tested only against signatures generated in the test suite.
- After the first apply each subscription is `PendingConfirmation` until the running API answers its `SubscriptionConfirmation`.
- The SNS topic key policy lets `ses.amazonaws.com` and `sms-voice.amazonaws.com` use the key for this account only; whether those services need more is untested.

## IAM: explicit denies on the app roles

The `api` and `worker` task roles carry explicit Deny statements (SC-2), in addition to having no matching Allow. The module README ("Explicit denies on the app roles") has the full table.

| Role | Denied (all Regions unless noted) |
| --- | --- |
| `api` | `CreateSecret`, `PutSecretValue`, `UpdateSecret`, `ReplicateSecretToRegions` on `<env>/integration/inbound/*` (Sid `ApiCannotWriteInboundSecrets`) |
| `worker` | the same four on `<env>/integration/outbound/*` (Sid `WorkerCannotWriteOutboundSecrets`) |
| both | `PutResourcePolicy`, `DeleteResourcePolicy`, `RemoveRegionsFromReplication`, `StopReplicationToReplica` on `*` (Sid `CannotChangeSecretPolicyOrReplication`); `kms:PutKeyPolicy` on `*` (Sid `CannotChangeKeyPolicy`) |

Replica promotion (`recovery-region.md` 2.2) is run by an operator identity, never by an app role.
