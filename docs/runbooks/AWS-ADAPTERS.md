# AWS adapters: configuration and emulator evidence

Owner ruling 2026-11-11: R1 ends with an AWS-ready codebase; nothing is deployed. Every adapter is chosen by environment variables.
This page is the single list of those names. Other adapter tickets (video, email, SMS, OCR, malware scan, identity) add their own
section below the S3 one; keep the three rules.

## Selection rules (all adapters)

| State of the group's variables | Result |
|---|---|
| none set | the REFUSING port stays; one `not configured` log line (`adapter`, `vars`) |
| all set | the AWS adapter is built (`configured` log line) |
| some set | startup fails with `AwsConfigError`: it names the missing and present variables, never a value |

Code: `packages/kernel/src/aws/config.ts` (`awsSettings`, `createS3Client`, `selectByEnv`).

## Shared settings

| Variable | Required | Meaning |
|---|---|---|
| `AWS_REGION` | when any AWS adapter is configured | region of the clients |
| `EHR_AWS_ENDPOINT_URL` | no | endpoint override for an emulator or VPC endpoint (implies path-style addressing) |
| `EHR_AWS_S3_FORCE_PATH_STYLE` | no | `true` to force path-style without an endpoint |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | emulator only | read by the SDK's default chain; in AWS the task role supplies credentials |

## S3 (AWS-BE-1)

| Group (adapter) | Variables (all required together) | Process |
|---|---|---|
| Documents object store: presigned PUT/GET; worker head/read/put/remove | `EHR_S3_DOCS_QUARANTINE_BUCKET`, `EHR_S3_DOCS_CLEAN_BUCKET`, `EHR_S3_DOCS_KMS_KEY_ID` | api, worker |
| Privacy package store: presigned GET; worker put/remove | `EHR_S3_PACKAGE_BUCKET`, `EHR_S3_PACKAGE_KMS_KEY_ID` | api, worker |
| Audit export sink | `EHR_S3_EXPORT_BUCKET`, `EHR_S3_EXPORT_KMS_KEY_ID` | worker |
| Audit anchor archive (Object Lock) | `EHR_S3_ANCHOR_ARCHIVE_BUCKET`, `EHR_S3_ANCHOR_ARCHIVE_KMS_KEY_ID` | worker |

Behaviour:

- Presigned URLs live at most 900 s (the code refuses more; the callers use 60 s for downloads). An upload URL signs `Content-Type`,
  `Content-Length` and the SSE-KMS headers (`x-amz-server-side-encryption`, `...-aws-kms-key-id`), so the bucket refuses a request
  that differs. Downloads are `attachment`. Keys are random paths (`q/<hex>`, `p/<hex>`); a key with spaces, `@`, `..` or `//` is refused.
- Every worker write is SSE-KMS.
- Presigning is asynchronous (credentials come from the SDK chain); the API ports return `T | Promise<T>`.
- Export sink: chunk `n` of export `E` is `audit-exports/E/chunk-00000n.ndjson` (a repeat overwrites the same key). `finalize` checks that
  every chunk exists and writes `audit-exports/E/manifest.json`; the manifest key is the export's object key. A single concatenated
  object was not chosen because multipart parts below 5 MiB are impossible. Decision recorded for reviewers; revisit if the download
  flow needs one object.
- Anchor archive: `PutObject` with `If-None-Match: *` and `ChecksumSHA256`; HTTP 412 -> `exists`; a response without a real version id
  is an error (versioning must be on). `listVersions` pages `ListObjectVersions` (delete markers skipped), `getVersion` reads one
  `VersionId`. The adapter has no delete or overwrite path. Object Lock (compliance mode, default retention) and versioning are
  bucket settings owned by the bucket's IaC, not by this code.
- Required IAM, when the buckets exist: api `s3:PutObject`/`s3:GetObject` on the documents and package buckets (presigning signs with the
  task role) and `kms:GenerateDataKey`/`kms:Decrypt` on their keys; worker adds `s3:DeleteObject`, `s3:ListBucketVersions`,
  `s3:GetObjectVersion`, `s3:PutObject` on the archive (no `s3:DeleteObjectVersion`, no `s3:BypassGovernanceRetention`).

## Secrets Manager and KMS (AWS-BE-2)

| Group (adapter) | Variables | Process |
|---|---|---|
| Secret store: outbound `put` (api), inbound verification keys `keys` (api), calendar channel key, secret reader, inbound writer (worker) | `EHR_SECRETS_PREFIX` (required; the environment name, e.g. `prod`); `EHR_SECRETS_KMS_KEY_ID` (optional; CMK for newly created secrets, default is the account's `aws/secretsmanager` key) | api, worker |
| Payload sealer (api) / opener (worker) | `EHR_KMS_PAYLOAD_KEY_ID` (required; key id, ARN or alias); worker only: `EHR_KMS_PAYLOAD_PREVIOUS_KEY_IDS` (optional, comma separated; keys whose old blobs may still be opened) | api (seal), worker (open) |

Secret names (built in code, a caller cannot choose another prefix):

- `<prefix>/integration/outbound/<connectionId>/<name>`: written by the api, read by the worker.
- `<prefix>/integration/inbound/<name>`: written by the worker only; read by the api by this fixed name (webhook keys, the calendar
  channel key `google-calendar-channel-key`, current then `AWSPREVIOUS`) and by the worker.

Behaviour:

- Every write makes a new secret version. `ClientRequestToken` is `sha256(secretName, clientToken)` in hex, so a retry returns the same
  version. The secret is created on first write (`CreateSecret`, then `PutSecretValue` if a concurrent writer won). Values are limited to 64 KiB.
- A secret value never appears in a log line or an error: errors carry the secret name and the failure class (for example
  `AccessDeniedException`).
- Sealed payloads: `GenerateDataKey` (AES_256) per payload, AES-256-GCM, 12-byte random iv. The KMS `EncryptionContext` is
  `{"ehr:ctx": <context>}` where the context string is the caller's purpose + record id (`inbound:<source>\n<event id>`,
  `secret_change:<request id>`, per SC-3); organisation scoping comes from the record id and the key policy. The context and the embedded key id are
  also GCM additional authenticated data. Blob: `EHK1 | keyId | wrapped data key | iv | tag | ciphertext`. The plaintext data key is
  zeroed after each call and never stored. Tag verification is Node/OpenSSL GCM (constant time); the code compares no secret bytes.
- Opening: the embedded key id must be the configured key or one in `EHR_KMS_PAYLOAD_PREVIOUS_KEY_IDS` (aliases are resolved once
  with `kms:DescribeKey`), otherwise the blob is refused before KMS is asked. A wrong context, a flipped byte, a truncated blob and a
  wrong key all return the same `KmsEnvelopeError` (`open_failed`/`malformed`/`untrusted_key`), with no detail about which.
- Rotation: change `EHR_KMS_PAYLOAD_KEY_ID` to the new key and put the old one in `EHR_KMS_PAYLOAD_PREVIOUS_KEY_IDS` on the worker.
  Drop it once no sealed job older than the queue retention exists.

IAM actions the adapters need (exact list; `<prefix>` is `EHR_SECRETS_PREFIX`, `PK` is the payload key ARN):

| Role | Action | Resource |
|---|---|---|
| api | `secretsmanager:CreateSecret`, `secretsmanager:PutSecretValue` | `arn:aws:secretsmanager:<region>:<acct>:secret:<prefix>/integration/outbound/*` |
| api | `secretsmanager:GetSecretValue` | `arn:aws:secretsmanager:<region>:<acct>:secret:<prefix>/integration/inbound/*` |
| api | `kms:GenerateDataKey` | `PK`, with condition `kms:EncryptionContextKeys` = `ehr:ctx` |
| api, worker (only if `EHR_SECRETS_KMS_KEY_ID`) | `kms:GenerateDataKey`, `kms:Decrypt` (via Secrets Manager, `kms:ViaService`) | the secrets key |
| worker | `secretsmanager:GetSecretValue` | `...:secret:<prefix>/integration/*` |
| worker | `secretsmanager:CreateSecret`, `secretsmanager:PutSecretValue` | `...:secret:<prefix>/integration/inbound/*` |
| worker | `kms:Decrypt` | `PK` and any previous payload key, with condition `kms:EncryptionContextKeys` = `ehr:ctx` |
| worker | `kms:DescribeKey` | only if an alias is configured: the key behind it |

The api role gets no `kms:Decrypt` on the payload key and no write on `inbound/*` (SC-2, SC-3); the worker gets no `kms:GenerateDataKey`.
`CreateSecret` needs `secretsmanager:TagResource` only if the IaC adds tags to the created secrets; this code adds none. Secret policies and
rotation lambdas belong to the IaC, not to this code.

## Notifications: e-mail, SMS, push, security notice (AWS-BE-3)

Code: `apps/worker/src/aws/notify-adapters.ts` (SES, End User Messaging SMS, security notice), `web-push.ts` (push), `receipt-events.ts`
(event mappers). The providers sit behind the existing `EmailAdapter`/`SmsAdapter`/`PushAdapter` of `jobs/notifications`, which
integration-core's `VendorGateway` wraps (log, retry, circuit). A vendor is swapped by registering another `ProviderClient`; the
PHI-free template allowlist stays upstream and is untouched. The gateway still needs an enabled `integration_core.connection` row of the
kind (`email`, `sms`, `push`); the adapter ignores its credentials (AWS uses the task role).

| Group (adapter) | Variables | Process |
|---|---|---|
| E-mail (SES v2) | required: `EHR_SES_FROM_ADDRESS`; optional: `EHR_SES_CONFIGURATION_SET` | worker |
| SMS (End User Messaging) | required: `EHR_SMS_ORIGINATION_IDENTITY` (phone number, pool or sender ID, name or ARN); optional: `EHR_SMS_CONFIGURATION_SET` | worker |
| Security notice (B2-9 `security_notice` port) | required: `EHR_SECURITY_CONTACT_EMAIL`; also needs `EHR_SES_FROM_ADDRESS` (start fails naming it if absent) | worker |
| Push (Web Push, VAPID; not AWS) | required together: `EHR_VAPID_PUBLIC_KEY`, `EHR_VAPID_PRIVATE_KEY`, `EHR_VAPID_SUBJECT` (`mailto:` or `https:`) | worker |

The selection rules above apply to each row. With a row unset the gateway has no adapter for that kind and refuses the call (`no adapter`);
the security notice stays the refusing `security_notice` port. `EHR_VAPID_PRIVATE_KEY` is a secret: inject it from Secrets Manager into the
task environment; never commit it.

Behaviour and decisions:

- **Push is R1** (docs/intake/04-INTEGRATIONS-AND-DATA.md: Web Push R1; ARCHITECTURE 22: Web Push for portal users). The "defer Web Push to R2" trim lever in
  ARCHITECTURE is an owner option only, not taken. The subscription (`to` = the browser's `PushSubscription.toJSON()` string) comes from
  a browser, so only https endpoints on the push-service hosts (FCM, Mozilla, Apple, Windows) are contacted. A 404/410 is
  `subscription_gone` (not retried). Open item: NFR-19 V-07 needs the owner's ruling on whether a BAA is needed for the push services.
- **At-least-once.** SES and End User Messaging accept no idempotency token and have no lookup by our reference, so the adapters declare
  `supportsIdempotencyToken = false` (the gateway records a pending call first) and cannot de-duplicate a retry after a timeout: a message may
  be sent twice. Our token is sent as the tag `ehr_ref` (SES) or `Context.ehr_ref` (SMS) so a duplicate is traceable. Web Push is the same.
- **Errors.** Throttling, 429, 5xx and network failures are retryable; any other 4xx (`MessageRejected`, `ValidationException`, ...) is not.
  Only the SDK error name and HTTP status leave the adapter; no address, text or message ID is logged.
- **Attachments** (at most 2, from the existing adapter contract) go as a raw MIME message; otherwise SES simple content is used.
- **Health.** `ses:GetAccount`; `sms-voice:DescribeAccountAttributes`; push has no cheap authenticated call, so configured keys count as healthy.
- **Receipts.** `receipt-events.ts` maps an SES event (Delivery, permanent/transient Bounce, Complaint; bare or inside an SNS
  Notification) and an End User Messaging SMS event to the body `notifications.on_receipt` parses. **Nothing calls them**: the repository has
  no inbound HTTP route yet (`integration-core/inbound.ts`: route not built, INT-N2) and no SNS signature verifier, and this ticket did not
  invent either. The ticket that adds the route wires them, with the SES event destination (SNS topic) and an SNS signature check. Field names
  follow the AWS formats and must be compared with a real event at go-live. Until then no receipt row is written for these providers.
- **Security notice** goes straight to the configured mailbox through SES (not the gateway, the address is configuration). Content is the
  event kind, job reference, principal IDs and, for `bootstrap_run`, the run, CI and ticket references and token expiry: no name or credential detail.

Required IAM (worker task role; the API does not send):

- E-mail and security notice: `ses:SendEmail` and `ses:SendRawEmail` on the verified identity (and the configuration set, when used), `ses:GetAccount`.
- SMS: `sms-voice:SendTextMessage` on the origination identity (and the configuration set), `sms-voice:DescribeAccountAttributes`.
- Push: none.

Emulator evidence: `notify-adapters.emulator.test.ts` runs the SES provider and the security notice against LocalStack SES v2 when
`EHR_EMULATOR_SES_ENDPOINT` is set (`pnpm test:emulator`). **Not run in this ticket's session (no container runtime available), so there is
no emulator result to report.** End User Messaging SMS has no emulator coverage (LocalStack community does not implement it); Web Push is
tested against the real `web-push` library offline (request building and encryption, nothing sent). Real checks for go-live
(docs/GO-LIVE.md): SES production access and verified identity, DKIM/SPF/DMARC, bounce and complaint event destination and the real event shape, an SMS
origination identity registered and out of the sandbox, 10DLC/toll-free registration where required, a push delivered to a real browser.

## Video, malware scan, OCR, identity (AWS-BE-4)

Code: `apps/api/src/platform/aws/chime-video.ts` (API side), `apps/worker/src/aws/chime-video.ts`, `guardduty-scan.ts`, `textract-ocr.ts`
(worker). All sit behind ports that already existed (`VideoVendorPort`, worker `VideoTransport`/`VideoAdapter`, `ScanCaller` with
`TagScannerAdapter`, `OcrProviderClient`/`OcrAdapter`); no job, route or table changed.

| Group (adapter) | Variables | Process |
|---|---|---|
| Video (Chime SDK Meetings) | required: `EHR_CHIME_MEDIA_REGION` (e.g. `us-east-1`, a Chime media region) | api (join token, end meeting), worker (create meeting) |
| Malware scan (GuardDuty tag reader) | `EHR_MALWARE_SCAN=guardduty`; also needs `EHR_S3_DOCS_QUARANTINE_BUCKET`, `EHR_S3_DOCS_CLEAN_BUCKET` (start fails naming the missing one) | worker |
| OCR (Textract) | `EHR_OCR=textract`; also needs the same two bucket variables | worker |
| Patient identity (Cognito) | no new variables: the existing `EHR_PATIENT_OIDC_*` | api |

Absent variables keep the refusing ports: a join answers 503 `telehealth.vendor_unavailable`; the scan job treats the missing scanner as an
error (never `clean`); OCR suggestions are `skipped`. The video and OCR kinds also need an enabled `integration_core.connection` row
(`video` vendor `chime`, `ocr` vendor `textract`); the adapters ignore its credentials (the task role is used). The scan needs no row.

Behaviour and decisions:

- **Chime.** The worker creates the meeting with our idempotency token as `ClientRequestToken` (a retry returns the same meeting) and
  `ExternalMeetingId` = our external ID. **Recording is off**: no media-capture pipeline is ever created and an argument asking for recording is refused.
  The API creates one attendee per join with `ExternalUserId` = our opaque participant ID and returns the join token once; it is not logged,
  stored or put in an error (only the SDK error name and status leave an adapter). The waiting room, the 15-minute token record and the
  single-use rule stay in our database and are unchanged. **Limit:** Chime offers no per-token lifetime, so the "short-lived" bound is OUR record's;
  the Chime token itself lives as long as the attendee/meeting (a go-live check). Ending a session deletes the meeting (`NotFoundException` = already ended).
- **GuardDuty.** The adapter does not scan; it reads the object tag `GuardDutyMalwareScanStatus` (`s3:GetObjectTagging`). `NO_THREATS_FOUND` = clean,
  `THREATS_FOUND` = infected, **no tag = pending** (the existing 30-minute wait, then alert), `UNSUPPORTED`, `ACCESS_DENIED`, `FAILED` or any other value =
  error, an unreadable object or an outage throws. A missing result is never clean. Tag name and values are from the AWS documentation and are
  Unverified until a real scan (go-live).
- **Textract.** `DetectDocumentText` reads the object by S3 reference (no bytes pass through the worker) and a small phrase table maps the
  text to one of the closed classification list (`id_document`, `insurance_card`, `referral_letter`, `consent`) or no suggestion. The text is never logged or
  returned. Multi-page PDFs and unsupported files (synchronous API limits) give no suggestion; throttling (including Textract's HTTP 400 `ProvisionedThroughputExceededException`) and 5xx are retried. It only suggests; staff confirm.
  The phrase table is a first rule set to be tuned on real documents. Textract has no free probe call, so health means "configured".
- **Cognito (patient).** Already complete; not reopened. The patient realm is a generic OIDC client that verifies the id token against the
  issuer's JWKS (RS256/ES256, issuer, audience, nonce, expiry). Cognito is configured, not coded: `EHR_PATIENT_OIDC_ISSUER=https://cognito-idp.<region>.amazonaws.com/<poolId>`,
  `..._JWKS_URI=<issuer>/.well-known/jwks.json`, `..._AUTHORIZATION_ENDPOINT=https://<domain>/oauth2/authorize`, `..._TOKEN_ENDPOINT=https://<domain>/oauth2/token`,
  `..._CLIENT_ID`, `..._REDIRECT_URI` (secret optional with PKCE). Pool settings (passkeys, MFA, Essentials plan) are IaC, not code.
  **The partner pool has no sign-in code in R1** (the partner portal is R2, ARCHITECTURE section 4 `pharmacy-network`); adding it then is the same configuration with a second prefix.

Required IAM (task roles):

- worker, video: `chime:CreateMeeting`, `chime:DeleteMeeting`, `chime:GetMeeting` (health probe). api, video: `chime:CreateAttendee`, `chime:DeleteMeeting`.
- worker, scan: `s3:GetObjectTagging` on the quarantine and clean buckets; `s3:ListBucket` on the quarantine bucket (health `HeadBucket`).
- worker, OCR: `textract:DetectDocumentText`; `s3:GetObject` on the clean and quarantine buckets and `kms:Decrypt` on the documents key (Textract reads the object with the caller's permissions).
- GuardDuty Malware Protection for S3 itself (plan, service role, tagging on) is IaC.

Evidence: unit tests with recorded-response stubs of the SDK clients (`apps/worker/src/aws/ai-adapters.test.ts`, `apps/api/src/platform/aws/chime-video.test.ts`,
`identity-env.test.ts`): **stub evidence only**; Chime, Textract and GuardDuty have no emulator. `guardduty-scan.emulator.test.ts` checks tag reading
against LocalStack S3 with a tag the test writes itself (emulator evidence for the S3 tagging API, not for GuardDuty). Go-live checks (docs/GO-LIVE.md):
a real meeting with two attendees and no recording; the real token lifetime and revocation after `DeleteMeeting`; a real scan result tag for clean, EICAR and unsupported
files and its latency; Textract on real insurance cards and ID documents (accuracy, multi-page PDFs); a Cognito sign-in end to end incl. passkey and the replica.

## Tests

- Unit (stubbed clients, run by `pnpm test` in each app): `apps/worker/src/aws/notify-adapters.test.ts`, `web-push.test.ts`, `receipt-events.test.ts`,
  `apps/api/src/platform/aws/s3-presigners.test.ts`,
  `apps/worker/src/aws/s3-adapters.test.ts`, `packages/kernel/src/aws/config.test.ts`; AWS-BE-2: `packages/kernel/src/aws/kms-envelope.test.ts`
  (round trip, wrong context, tampered bytes, wrong/untrusted key, rotation, alias, key wiping), `secrets-manager.test.ts`,
  `apps/api/src/platform/aws/secrets-kms.test.ts`, `apps/worker/src/aws/secrets-kms.test.ts`.
- Emulator (`*.emulator.test.ts`, skipped unless `EHR_EMULATOR_S3_ENDPOINT` is set), run with `pnpm test:emulator`:

  ```
  docker run -d -p 4566:4566 localstack/localstack
  export EHR_EMULATOR_S3_ENDPOINT=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
  pnpm test:emulator
  ```

  `EHR_EMULATOR_KMS_KEY_ID` (default `alias/emulator`) names the key sent in the SSE-KMS headers. MinIO needs a KMS configured to accept
  SSE-KMS; LocalStack does not. Results are emulator evidence only: they show the requests are well formed and the S3 API contract is
  honoured by the emulator, not any behaviour of real AWS (Object Lock retention, KMS policy, IAM). Those checks belong on
  `docs/GO-LIVE.md`. The AWS-BE-2 emulator tests are `packages/kernel/src/aws/secrets-kms.emulator.test.ts` (same `EHR_EMULATOR_S3_ENDPOINT` LocalStack edge URL;
  `pnpm test:emulator` runs the kernel too). Real-KMS checks for the go-live list: the key policy and `kms:EncryptionContextKeys` conditions, that the api
  role cannot Decrypt, and that a rotated key still opens old blobs.
