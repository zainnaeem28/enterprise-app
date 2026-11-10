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

## Tests

- Unit (stubbed clients, run by `pnpm test` in each app): `apps/api/src/platform/aws/s3-presigners.test.ts`,
  `apps/worker/src/aws/s3-adapters.test.ts`, `packages/kernel/src/aws/config.test.ts`.
- Emulator (`*.emulator.test.ts`, skipped unless `EHR_EMULATOR_S3_ENDPOINT` is set), run with `pnpm test:emulator`:

  ```
  docker run -d -p 4566:4566 localstack/localstack
  export EHR_EMULATOR_S3_ENDPOINT=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
  pnpm test:emulator
  ```

  `EHR_EMULATOR_KMS_KEY_ID` (default `alias/emulator`) names the key sent in the SSE-KMS headers. MinIO needs a KMS configured to accept
  SSE-KMS; LocalStack does not. Results are emulator evidence only: they show the requests are well formed and the S3 API contract is
  honoured by the emulator, not any behaviour of real AWS (Object Lock retention, KMS policy, IAM). Those checks belong on
  `docs/GO-LIVE.md`.
