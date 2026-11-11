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

## Tests

- Unit (stubbed clients, run by `pnpm test` in each app): `apps/api/src/platform/aws/s3-presigners.test.ts`,
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
