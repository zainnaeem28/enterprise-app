// S3 presigners for the documents store and the privacy package store (ARCHITECTURE 25.10; AWS-BE-1). The API never reads or writes
// content: it signs a short-lived URL. Uploads pin Content-Type, Content-Length and SSE-KMS as signed headers, so the bucket refuses any
// request that differs. Keys are random (`q/<hex>`, `p/<hex>`): the adapter refuses a key that is not a plain path of safe characters.
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { awsSettings, createS3Client, selectByEnv, type Env, type Logger } from '@ehr/kernel';
import type {
  ObjectStorePort,
  PresignGet,
  PresignPut,
  Presigned,
} from '../../modules/documents/ports.js';
import type { PackageStorePort, PresignedGet } from '../../modules/privacy/ports.js';

/** A URL longer-lived than this is a defect, not a setting. */
export const MAX_PRESIGN_SECONDS = 900;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,254}$/;
const SSE = 'x-amz-server-side-encryption';
const SSE_KEY = 'x-amz-server-side-encryption-aws-kms-key-id';

function check(key: string, expiresSeconds: number): void {
  if (!SAFE_KEY.test(key) || key.includes('..') || key.includes('//'))
    throw new Error('presign refused: object key is not a plain random path');
  if (
    !Number.isInteger(expiresSeconds) ||
    expiresSeconds < 1 ||
    expiresSeconds > MAX_PRESIGN_SECONDS
  )
    throw new Error(`presign refused: expiry must be 1..${MAX_PRESIGN_SECONDS} seconds`);
}

const expiry = (now: Date, seconds: number): Date => new Date(now.getTime() + seconds * 1000);

export interface S3DocumentBuckets {
  quarantine: string;
  clean: string;
  kmsKeyId: string;
}

export class S3ObjectStorePresigner implements ObjectStorePort {
  constructor(
    private readonly s3: S3Client,
    private readonly cfg: S3DocumentBuckets,
  ) {}

  async presignPut(req: PresignPut, now: Date): Promise<Presigned> {
    check(req.key, req.expiresSeconds);
    if (!Number.isInteger(req.contentLength) || req.contentLength < 0)
      throw new Error('presign refused: content length must be a non-negative integer');
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.cfg[req.bucket],
        Key: req.key,
        ContentType: req.contentType,
        ContentLength: req.contentLength,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.cfg.kmsKeyId,
      }),
      {
        expiresIn: req.expiresSeconds,
        signingDate: now,
        signableHeaders: new Set(['content-type', 'content-length']),
        // Without this the SDK moves the SSE headers into the query string, where the browser need not send them.
        unhoistableHeaders: new Set([SSE, SSE_KEY]),
      },
    );
    return {
      url,
      headers: {
        'Content-Type': req.contentType,
        'Content-Length': String(req.contentLength),
        [SSE]: 'aws:kms',
        [SSE_KEY]: this.cfg.kmsKeyId,
      },
      expiresAt: expiry(now, req.expiresSeconds),
    };
  }

  async presignGet(req: PresignGet, now: Date): Promise<Presigned> {
    check(req.key, req.expiresSeconds);
    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.cfg[req.bucket],
        Key: req.key,
        ResponseContentType: req.contentType,
        ResponseContentDisposition: 'attachment',
      }),
      { expiresIn: req.expiresSeconds, signingDate: now },
    );
    return { url, headers: {}, expiresAt: expiry(now, req.expiresSeconds) };
  }
}

export class S3PackageStorePresigner implements PackageStorePort {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async presignGet(key: string, expiresSeconds: number, now: Date): Promise<PresignedGet> {
    check(key, expiresSeconds);
    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: 'attachment',
      }),
      { expiresIn: expiresSeconds, signingDate: now },
    );
    return { url, expiresAt: expiry(now, expiresSeconds) };
  }
}

export const DOCUMENT_STORE_VARS = [
  'EHR_S3_DOCS_QUARANTINE_BUCKET',
  'EHR_S3_DOCS_CLEAN_BUCKET',
  'EHR_S3_DOCS_KMS_KEY_ID',
] as const;
export const PACKAGE_STORE_VARS = ['EHR_S3_PACKAGE_BUCKET', 'EHR_S3_PACKAGE_KMS_KEY_ID'] as const;

/** The configured presigners; an absent one is `undefined` so the composition keeps its refusing port. A partial set throws. */
export function selectS3Presigners(
  env: Env,
  log: Logger,
): { objectStore?: ObjectStorePort; packageStore?: PackageStorePort } {
  // Built on first use: with nothing configured there is no AWS_REGION to demand.
  let shared: S3Client | undefined;
  const client = (): S3Client => (shared ??= createS3Client(awsSettings(env, 'S3 presigners')));
  const out: { objectStore?: ObjectStorePort; packageStore?: PackageStorePort } = {};
  const docs = selectByEnv({
    adapter: 'documents object store (S3)',
    env,
    vars: DOCUMENT_STORE_VARS,
    log,
    build: (v) =>
      new S3ObjectStorePresigner(client(), {
        quarantine: v['EHR_S3_DOCS_QUARANTINE_BUCKET'] as string,
        clean: v['EHR_S3_DOCS_CLEAN_BUCKET'] as string,
        kmsKeyId: v['EHR_S3_DOCS_KMS_KEY_ID'] as string,
      }),
  });
  if (docs !== undefined) out.objectStore = docs;
  const pkg = selectByEnv({
    adapter: 'package store (S3)',
    env,
    vars: PACKAGE_STORE_VARS,
    log,
    build: (v) => new S3PackageStorePresigner(client(), v['EHR_S3_PACKAGE_BUCKET'] as string),
  });
  if (pkg !== undefined) out.packageStore = pkg;
  return out;
}
