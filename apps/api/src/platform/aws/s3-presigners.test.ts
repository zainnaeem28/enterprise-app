import assert from 'node:assert/strict';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { AwsConfigError, createLogger } from '@ehr/kernel';
import {
  MAX_PRESIGN_SECONDS,
  S3ObjectStorePresigner,
  S3PackageStorePresigner,
  selectS3Presigners,
} from './s3-presigners.js';

const s3 = new S3Client({
  region: 'eu-west-2',
  credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
});
const now = new Date('2026-01-02T03:04:05Z');
const docs = new S3ObjectStorePresigner(s3, {
  quarantine: 'q-b',
  clean: 'c-b',
  kmsKeyId: 'alias/k',
});
const KEY = 'q/0123456789abcdef0123456789abcdef';

test('PUT: short expiry, content type/length and SSE-KMS are signed headers', async () => {
  const p = await docs.presignPut(
    {
      bucket: 'quarantine',
      key: KEY,
      contentType: 'application/pdf',
      contentLength: 1234,
      expiresSeconds: 300,
    },
    now,
  );
  const u = new URL(p.url);
  assert.match(u.hostname, /^q-b\.s3\./);
  assert.equal(u.pathname, `/${KEY}`);
  assert.equal(u.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(u.searchParams.get('X-Amz-Date'), '20260102T030405Z');
  const signed = String(u.searchParams.get('X-Amz-SignedHeaders')).split(';');
  for (const h of [
    'content-type',
    'content-length',
    'x-amz-server-side-encryption',
    'x-amz-server-side-encryption-aws-kms-key-id',
  ])
    assert.ok(signed.includes(h), `${h} not signed: ${signed.join(';')}`);
  assert.equal(p.headers['x-amz-server-side-encryption'], 'aws:kms');
  assert.equal(p.headers['x-amz-server-side-encryption-aws-kms-key-id'], 'alias/k');
  assert.equal(p.headers['Content-Length'], '1234');
  assert.equal(p.expiresAt.toISOString(), '2026-01-02T03:09:05.000Z');
});

test('GET: clean bucket, attachment, response type', async () => {
  const p = await docs.presignGet(
    { bucket: 'clean', key: KEY, contentType: 'image/png', expiresSeconds: 60 },
    now,
  );
  const u = new URL(p.url);
  assert.match(u.hostname, /^c-b\.s3\./);
  assert.equal(u.searchParams.get('response-content-type'), 'image/png');
  assert.equal(u.searchParams.get('response-content-disposition'), 'attachment');
  assert.equal(u.searchParams.get('X-Amz-Expires'), '60');
});

test('refuses long expiry and keys that are not plain paths', async () => {
  const base = { bucket: 'quarantine' as const, contentType: 'a/b', contentLength: 1 };
  await assert.rejects(
    docs.presignPut({ ...base, key: KEY, expiresSeconds: MAX_PRESIGN_SECONDS + 1 }, now),
    /expiry/,
  );
  await assert.rejects(
    docs.presignPut({ ...base, key: 'q/a@b.com', expiresSeconds: 60 }, now),
    /key/,
  );
  await assert.rejects(docs.presignPut({ ...base, key: 'q/../x', expiresSeconds: 60 }, now), /key/);
  await assert.rejects(new S3PackageStorePresigner(s3, 'p').presignGet('p/x y', 60, now), /key/);
});

test('package GET presigns on the package bucket', async () => {
  const r = await new S3PackageStorePresigner(s3, 'pkg-b').presignGet('p/abc', 120, now);
  assert.match(new URL(r.url).hostname, /^pkg-b\./);
});

test('selection: absent keeps refusing, partial fails, full builds', () => {
  const lines: string[] = [];
  const log = createLogger({ sink: (l) => lines.push(l) });
  assert.deepEqual(selectS3Presigners({}, log), {});
  assert.equal(lines.filter((l) => l.includes('not configured')).length, 2);
  assert.throws(() => selectS3Presigners({ EHR_S3_PACKAGE_BUCKET: 'b' }, log), AwsConfigError);
  const env = {
    AWS_REGION: 'eu-west-2',
    EHR_S3_PACKAGE_BUCKET: 'b',
    EHR_S3_PACKAGE_KMS_KEY_ID: 'k',
  };
  const r = selectS3Presigners(env, log);
  assert.ok(r.packageStore && !r.objectStore);
  assert.throws(() => selectS3Presigners({ ...env, AWS_REGION: '' }, log), /AWS_REGION/);
});
