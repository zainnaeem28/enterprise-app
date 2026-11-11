import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { AwsConfigError, createLogger } from '@ehr/kernel';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  S3AnchorArchive,
  S3ExportSink,
  S3PackageStore,
  S3WorkerObjectStore,
  selectS3WorkerInfra,
} from './s3-adapters.js';

type Call = { name: string; input: Record<string, unknown> };
function stub(handler: (c: Call) => unknown): { s3: S3Client; calls: Call[] } {
  const calls: Call[] = [];
  const s3 = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const c = { name: cmd.constructor.name, input: cmd.input };
      calls.push(c);
      const r = handler(c);
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as S3Client;
  return { s3, calls };
}
const httpError = (status: number, name: string): Error =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
const KMS = 'arn:aws:kms:eu-west-2:000000000000:key/k';

test('object store: SSE-KMS on put, head maps 404 to null, read refuses oversize', async () => {
  const { s3, calls } = stub((c) => {
    if (c.name === 'HeadObjectCommand')
      return c.input['Key'] === 'q/missing'
        ? httpError(404, 'NotFound')
        : { ContentLength: 5, ContentType: 'a/b' };
    if (c.name === 'GetObjectCommand')
      return { ContentLength: 5, Body: Readable.from([Buffer.from('hello')]) };
    return {};
  });
  const st = new S3WorkerObjectStore(s3, { quarantine: 'qb', clean: 'cb', kmsKeyId: KMS });
  assert.equal(await st.head('quarantine', 'q/missing'), null);
  assert.deepEqual(await st.head('clean', 'c/x'), { sizeBytes: 5, contentType: 'a/b' });
  assert.equal((await st.read('quarantine', 'q/x', 10)).toString(), 'hello');
  await assert.rejects(st.read('quarantine', 'q/x', 4), /larger/);
  await st.put('clean', 'c/x', Buffer.from('xx'), 'image/png');
  await st.remove('clean', 'c/x');
  const put = calls.find((c) => c.name === 'PutObjectCommand')?.input;
  assert.equal(put?.['Bucket'], 'cb');
  assert.equal(put?.['ServerSideEncryption'], 'aws:kms');
  assert.equal(put?.['SSEKMSKeyId'], KMS);
  assert.equal(calls.at(-1)?.name, 'DeleteObjectCommand');
  await assert.rejects(st.put('clean', 'a b@x.com', Buffer.alloc(0), 'a/b'), /key/);
});

test('head rethrows non-404 errors', async () => {
  const { s3 } = stub(() => httpError(500, 'InternalError'));
  const st = new S3WorkerObjectStore(s3, { quarantine: 'q', clean: 'c', kmsKeyId: KMS });
  await assert.rejects(st.head('clean', 'c/x'), /InternalError/);
});

test('package store put/remove use the package bucket with SSE-KMS', async () => {
  const { s3, calls } = stub(() => ({}));
  const st = new S3PackageStore(s3, { bucket: 'pb', kmsKeyId: KMS });
  await st.put('p/abc', Buffer.from('z'), 'application/zip');
  await st.remove('p/abc');
  assert.equal(calls[0]?.input['Bucket'], 'pb');
  assert.equal(calls[0]?.input['ServerSideEncryption'], 'aws:kms');
  assert.equal(calls[1]?.name, 'DeleteObjectCommand');
});

test('export sink: idempotent chunk key; finalize checks every chunk and writes the manifest', async () => {
  const { s3, calls } = stub((c) => (c.name === 'HeadObjectCommand' ? { ContentLength: 7 } : {}));
  const sink = new S3ExportSink(s3, { bucket: 'eb', kmsKeyId: KMS });
  const id = '0192e0a0-0000-7000-8000-000000000001';
  await sink.putChunk(id, 0, Buffer.from('{}\n'));
  await sink.putChunk(id, 0, Buffer.from('{}\n'));
  assert.equal(calls[0]?.input['Key'], calls[1]?.input['Key']);
  assert.equal(calls[0]?.input['Key'], `audit-exports/${id}/chunk-000000.ndjson`);
  const r = await sink.finalize(id, 2);
  assert.equal(r.objectKey, `audit-exports/${id}/manifest.json`);
  const manifest = JSON.parse(String((calls.at(-1)?.input['Body'] as Buffer).toString()));
  assert.equal(manifest.chunks.length, 2);
  await assert.rejects(sink.putChunk('../x', 0, Buffer.alloc(0)), /export id/);
  const missing = stub((c) => (c.name === 'HeadObjectCommand' ? httpError(404, 'NotFound') : {}));
  await assert.rejects(
    new S3ExportSink(missing.s3, { bucket: 'eb', kmsKeyId: KMS }).finalize(id, 1),
  );
});

test('anchor archive: conditional put with checksum, 412 -> exists, no versioning -> reject', async () => {
  const body = Buffer.from('{"a":1}');
  const sha = createHash('sha256').update(body).digest();
  let mode: 'ok' | 'exists' | 'unversioned' = 'ok';
  const { s3, calls } = stub(() =>
    mode === 'exists'
      ? httpError(412, 'PreconditionFailed')
      : mode === 'ok'
        ? { VersionId: 'v1' }
        : {},
  );
  const a = new S3AnchorArchive(s3, { bucket: 'ab', kmsKeyId: KMS });
  assert.deepEqual(await a.putAnchor('anchors/1.json', body, sha), {
    outcome: 'created',
    versionId: 'v1',
  });
  assert.equal(calls[0]?.input['IfNoneMatch'], '*');
  assert.equal(calls[0]?.input['ChecksumSHA256'], sha.toString('base64'));
  mode = 'exists';
  assert.deepEqual(await a.putAnchor('anchors/1.json', body, sha), { outcome: 'exists' });
  mode = 'unversioned';
  await assert.rejects(a.putAnchor('anchors/1.json', body, sha), /versioning/);
  const sent = new Set(calls.map((c) => c.name));
  assert.ok(!sent.has('DeleteObjectCommand') && !sent.has('DeleteObjectsCommand'));
});

test('anchor archive: other failures reject; listVersions pages and orders; getVersion passes VersionId', async () => {
  const pages = [
    {
      IsTruncated: true,
      NextKeyMarker: 'k1',
      NextVersionIdMarker: 'v2',
      Versions: [
        { Key: 'k1', VersionId: 'v2', LastModified: new Date('2026-01-02T00:00:00Z') },
        { Key: 'k1', VersionId: 'v1', LastModified: new Date('2026-01-01T00:00:00Z') },
      ],
    },
    {
      IsTruncated: false,
      Versions: [{ Key: 'k2', VersionId: 'w1', LastModified: new Date('2026-01-03T00:00:00Z') }],
    },
  ];
  const { s3, calls } = stub((c) => {
    if (c.name === 'ListObjectVersionsCommand') return pages.shift();
    if (c.name === 'GetObjectCommand') return { Body: Readable.from([Buffer.from('anchor')]) };
    return httpError(503, 'SlowDown');
  });
  const a = new S3AnchorArchive(s3, { bucket: 'ab' });
  const got: string[] = [];
  for await (const v of a.listVersions('anchors/')) got.push(`${v.key}:${v.versionId}`);
  assert.deepEqual(got, ['k1:v1', 'k1:v2', 'k2:w1']);
  assert.equal(calls[1]?.input['KeyMarker'], 'k1');
  assert.equal((await a.getVersion('k1', 'v1')).toString(), 'anchor');
  assert.equal(calls.at(-1)?.input['VersionId'], 'v1');
  await assert.rejects(a.putAnchor('k', Buffer.alloc(1), Buffer.alloc(32)), /SlowDown/);
});

test('selection: nothing set keeps every port refusing; a partial group stops the start', () => {
  const lines: string[] = [];
  const log = createLogger({ sink: (l) => lines.push(l) });
  assert.deepEqual(selectS3WorkerInfra({}, log), {});
  assert.equal(lines.filter((l) => l.includes('not configured')).length, 4);
  assert.throws(() => selectS3WorkerInfra({ EHR_S3_EXPORT_BUCKET: 'b' }, log), AwsConfigError);
  const { s3 } = stub(() => ({}));
  const r = selectS3WorkerInfra(
    {
      EHR_S3_PACKAGE_BUCKET: 'b',
      EHR_S3_PACKAGE_KMS_KEY_ID: 'k',
      EHR_S3_ANCHOR_ARCHIVE_BUCKET: 'a',
      EHR_S3_ANCHOR_ARCHIVE_KMS_KEY_ID: 'k',
    },
    log,
    s3,
  );
  assert.deepEqual(Object.keys(r).sort(), ['anchorArchive', 'packageStore', 'packageWriter']);
});
