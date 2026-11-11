// The worker's S3 adapters (AWS-BE-1): documents object store, privacy package store and writer, audit export sink and the Object Lock
// anchor archive (SEC05-F02). Every write is SSE-KMS. Each adapter is selected by configuration (see `selectS3WorkerInfra`); an absent
// one leaves the composition's refusing port, a half-configured one stops the start. No call here happens inside a database transaction.
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { awsSettings, createS3Client, selectByEnv, type Env, type Logger } from '@ehr/kernel';
import type { AnchorArchiveStore, ArchiveVersion, PutResult } from '../jobs/audit/archive.js';
import type { ExportSink } from '../jobs/audit/export.js';
import type { Bucket, StoredObject, WorkerObjectStore } from '../jobs/documents/ports.js';
import type { PackageWriter, WorkerPackageStore } from '../jobs/privacy/ports.js';

const statusOf = (e: unknown): number | undefined =>
  (e as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
const nameOf = (e: unknown): string => (e as { name?: string } | null)?.name ?? '';

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.=-]{0,254}$/;
function safeKey(key: string): string {
  if (!SAFE_KEY.test(key) || key.includes('..') || key.includes('//'))
    throw new Error('object key refused: not a plain random path');
  return key;
}

async function bytesOf(body: unknown, maxBytes: number): Promise<Buffer> {
  const stream = body as AsyncIterable<Uint8Array> | undefined;
  if (stream === undefined) throw new Error('object has no body');
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of stream) {
    n += c.byteLength;
    if (n > maxBytes) throw new Error('object larger than the allowed size');
    parts.push(Buffer.from(c));
  }
  return Buffer.concat(parts);
}

export interface Sse {
  kmsKeyId: string;
}
const sse = (k: Sse): { ServerSideEncryption: 'aws:kms'; SSEKMSKeyId: string } => ({
  ServerSideEncryption: 'aws:kms',
  SSEKMSKeyId: k.kmsKeyId,
});

export class S3WorkerObjectStore implements WorkerObjectStore {
  constructor(
    private readonly s3: S3Client,
    private readonly cfg: Sse & { quarantine: string; clean: string },
  ) {}

  async head(bucket: Bucket, key: string): Promise<StoredObject | null> {
    try {
      const r = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.cfg[bucket], Key: safeKey(key) }),
      );
      return { sizeBytes: r.ContentLength ?? 0, contentType: r.ContentType ?? null };
    } catch (e) {
      if (statusOf(e) === 404 || nameOf(e) === 'NotFound' || nameOf(e) === 'NoSuchKey') return null;
      throw e;
    }
  }

  async read(bucket: Bucket, key: string, maxBytes: number): Promise<Buffer> {
    const r = await this.s3.send(
      new GetObjectCommand({ Bucket: this.cfg[bucket], Key: safeKey(key) }),
    );
    if ((r.ContentLength ?? 0) > maxBytes) throw new Error('object larger than the allowed size');
    return bytesOf(r.Body, maxBytes);
  }

  async put(bucket: Bucket, key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.cfg[bucket],
        Key: safeKey(key),
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
        ...sse(this.cfg),
      }),
    );
  }

  async remove(bucket: Bucket, key: string): Promise<void> {
    // S3 answers 204 for a missing key, so this is idempotent.
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.cfg[bucket], Key: safeKey(key) }));
  }
}

export class S3PackageStore implements PackageWriter, WorkerPackageStore {
  constructor(
    private readonly s3: S3Client,
    private readonly cfg: Sse & { bucket: string },
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: safeKey(key),
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
        ...sse(this.cfg),
      }),
    );
  }

  async remove(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: safeKey(key) }));
  }
}

const EXPORT_ID = /^[0-9a-f-]{8,64}$/;

/**
 * Chunks go to `audit-exports/<exportId>/chunk-<000001>.ndjson` (a repeat of the same chunk overwrites the same key: idempotent).
 * `finalize` checks that every chunk exists and writes `manifest.json` listing them with their sizes; the manifest key is the export's
 * object key (a single concatenated object would need multipart parts of at least 5 MiB, which a small chunk cannot give).
 */
export class S3ExportSink implements ExportSink {
  constructor(
    private readonly s3: S3Client,
    private readonly cfg: Sse & { bucket: string },
  ) {}

  private chunkKey(exportId: string, chunk: number): string {
    if (!EXPORT_ID.test(exportId)) throw new Error('export id refused');
    if (!Number.isInteger(chunk) || chunk < 0) throw new Error('chunk number refused');
    return `audit-exports/${exportId}/chunk-${String(chunk).padStart(6, '0')}.ndjson`;
  }

  async putChunk(exportId: string, chunk: number, ndjson: Buffer): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.chunkKey(exportId, chunk),
        Body: ndjson,
        ContentType: 'application/x-ndjson',
        ContentLength: ndjson.byteLength,
        ...sse(this.cfg),
      }),
    );
  }

  async finalize(exportId: string, chunks: number): Promise<{ objectKey: string }> {
    const listed: { key: string; sizeBytes: number }[] = [];
    for (let i = 0; i < chunks; i++) {
      const key = this.chunkKey(exportId, i);
      const h = await this.s3.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      listed.push({ key, sizeBytes: h.ContentLength ?? 0 });
    }
    const objectKey = `audit-exports/${exportId}/manifest.json`;
    const body = Buffer.from(JSON.stringify({ schema: 1, exportId, chunks: listed }));
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: objectKey,
        Body: body,
        ContentType: 'application/json',
        ContentLength: body.byteLength,
        ...sse(this.cfg),
      }),
    );
    return { objectKey };
  }
}

/**
 * The log-archive bucket (Object Lock compliance mode with a default retention, versioning on: both are bucket settings the bucket's
 * IaC owns). A put is conditional (`If-None-Match: *`) and carries the SHA-256 of the body; HTTP 412 means the key already exists. This
 * adapter has no delete and no overwrite path.
 */
export class S3AnchorArchive implements AnchorArchiveStore {
  constructor(
    private readonly s3: S3Client,
    private readonly cfg: { bucket: string; kmsKeyId?: string },
  ) {}

  async putAnchor(key: string, body: Buffer, sha256: Buffer): Promise<PutResult> {
    try {
      const r = await this.s3.send(
        new PutObjectCommand({
          Bucket: this.cfg.bucket,
          Key: safeKey(key),
          Body: body,
          ContentLength: body.byteLength,
          ContentType: 'application/json',
          IfNoneMatch: '*',
          ChecksumSHA256: sha256.toString('base64'),
          ...(this.cfg.kmsKeyId === undefined ? {} : sse({ kmsKeyId: this.cfg.kmsKeyId })),
        }),
      );
      if (r.VersionId === undefined || r.VersionId === 'null')
        throw new Error('archive bucket did not return a version id: versioning must be on');
      return { outcome: 'created', versionId: r.VersionId };
    } catch (e) {
      if (statusOf(e) === 412 || nameOf(e) === 'PreconditionFailed') return { outcome: 'exists' };
      throw e;
    }
  }

  async *listVersions(prefix: string): AsyncIterable<ArchiveVersion> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (;;) {
      const r = await this.s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.cfg.bucket,
          Prefix: prefix,
          ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
          ...(versionIdMarker === undefined ? {} : { VersionIdMarker: versionIdMarker }),
        }),
      );
      // Delete markers are not versions of an anchor; the verifier compares bytes of real versions only.
      const byKey = new Map<string, ArchiveVersion[]>();
      for (const v of r.Versions ?? []) {
        if (v.Key === undefined || v.VersionId === undefined || v.LastModified === undefined)
          continue;
        const l = byKey.get(v.Key) ?? [];
        l.push({ key: v.Key, versionId: v.VersionId, lastModified: v.LastModified.toISOString() });
        byKey.set(v.Key, l);
      }
      for (const list of byKey.values()) {
        list.sort((a, b) => a.lastModified.localeCompare(b.lastModified));
        yield* list;
      }
      if (r.IsTruncated !== true) return;
      keyMarker = r.NextKeyMarker;
      versionIdMarker = r.NextVersionIdMarker;
    }
  }

  async getVersion(key: string, versionId: string): Promise<Buffer> {
    const r = await this.s3.send(
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: safeKey(key), VersionId: versionId }),
    );
    return bytesOf(r.Body, 1024 * 1024);
  }
}

export const WORKER_DOCUMENT_VARS = [
  'EHR_S3_DOCS_QUARANTINE_BUCKET',
  'EHR_S3_DOCS_CLEAN_BUCKET',
  'EHR_S3_DOCS_KMS_KEY_ID',
] as const;
export const WORKER_PACKAGE_VARS = ['EHR_S3_PACKAGE_BUCKET', 'EHR_S3_PACKAGE_KMS_KEY_ID'] as const;
export const EXPORT_VARS = ['EHR_S3_EXPORT_BUCKET', 'EHR_S3_EXPORT_KMS_KEY_ID'] as const;
export const ANCHOR_VARS = [
  'EHR_S3_ANCHOR_ARCHIVE_BUCKET',
  'EHR_S3_ANCHOR_ARCHIVE_KMS_KEY_ID',
] as const;

export interface S3WorkerInfra {
  objectStore?: WorkerObjectStore;
  packageStore?: WorkerPackageStore;
  packageWriter?: PackageWriter;
  exportSink?: ExportSink;
  anchorArchive?: AnchorArchiveStore;
}

/** The configured S3 adapters. Absent groups are left out (refusing ports stay); a partial group throws `AwsConfigError`. */
export function selectS3WorkerInfra(env: Env, log: Logger, client?: S3Client): S3WorkerInfra {
  let shared = client;
  const s3 = (): S3Client => (shared ??= createS3Client(awsSettings(env, 'S3 adapters')));
  const out: S3WorkerInfra = {};
  const objectStore = selectByEnv({
    adapter: 'documents object store (S3)',
    env,
    vars: WORKER_DOCUMENT_VARS,
    log,
    build: (v) =>
      new S3WorkerObjectStore(s3(), {
        quarantine: v['EHR_S3_DOCS_QUARANTINE_BUCKET'] as string,
        clean: v['EHR_S3_DOCS_CLEAN_BUCKET'] as string,
        kmsKeyId: v['EHR_S3_DOCS_KMS_KEY_ID'] as string,
      }),
  });
  if (objectStore !== undefined) out.objectStore = objectStore;
  const pkg = selectByEnv({
    adapter: 'package store and writer (S3)',
    env,
    vars: WORKER_PACKAGE_VARS,
    log,
    build: (v) =>
      new S3PackageStore(s3(), {
        bucket: v['EHR_S3_PACKAGE_BUCKET'] as string,
        kmsKeyId: v['EHR_S3_PACKAGE_KMS_KEY_ID'] as string,
      }),
  });
  if (pkg !== undefined) {
    out.packageStore = pkg;
    out.packageWriter = pkg;
  }
  const exportSink = selectByEnv({
    adapter: 'audit export sink (S3)',
    env,
    vars: EXPORT_VARS,
    log,
    build: (v) =>
      new S3ExportSink(s3(), {
        bucket: v['EHR_S3_EXPORT_BUCKET'] as string,
        kmsKeyId: v['EHR_S3_EXPORT_KMS_KEY_ID'] as string,
      }),
  });
  if (exportSink !== undefined) out.exportSink = exportSink;
  const archive = selectByEnv({
    adapter: 'audit anchor archive (S3 Object Lock)',
    env,
    vars: ANCHOR_VARS,
    log,
    build: (v) =>
      new S3AnchorArchive(s3(), {
        bucket: v['EHR_S3_ANCHOR_ARCHIVE_BUCKET'] as string,
        kmsKeyId: v['EHR_S3_ANCHOR_ARCHIVE_KMS_KEY_ID'] as string,
      }),
  });
  if (archive !== undefined) out.anchorArchive = archive;
  return out;
}
