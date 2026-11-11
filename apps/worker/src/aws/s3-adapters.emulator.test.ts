// Emulator evidence only (LocalStack S3): see docs/runbooks/AWS-ADAPTERS.md. Skipped unless EHR_EMULATOR_S3_ENDPOINT is set.
// Nothing here proves a behaviour of real AWS; real-service checks are on docs/GO-LIVE.md.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { CreateBucketCommand, PutBucketVersioningCommand } from '@aws-sdk/client-s3';
import { awsSettings, createS3Client } from '@ehr/kernel';
import {
  S3AnchorArchive,
  S3ExportSink,
  S3PackageStore,
  S3WorkerObjectStore,
} from './s3-adapters.js';

const endpoint = process.env['EHR_EMULATOR_S3_ENDPOINT'];
const skip = endpoint === undefined ? 'EHR_EMULATOR_S3_ENDPOINT not set' : false;
const KMS = process.env['EHR_EMULATOR_KMS_KEY_ID'] ?? 'alias/emulator';
const suffix = randomBytes(4).toString('hex');

test('worker S3 adapters against the emulator', { skip }, async () => {
  const s3 = createS3Client(
    awsSettings({ AWS_REGION: 'eu-west-2', EHR_AWS_ENDPOINT_URL: endpoint }, 'emulator'),
  );
  const b = (n: string): string => `ehr-${n}-${suffix}`;
  for (const n of ['q', 'c', 'pkg', 'exp'])
    await s3.send(new CreateBucketCommand({ Bucket: b(n) }));
  await s3.send(new CreateBucketCommand({ Bucket: b('anchor'), ObjectLockEnabledForBucket: true }));
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: b('anchor'),
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  );

  const store = new S3WorkerObjectStore(s3, { quarantine: b('q'), clean: b('c'), kmsKeyId: KMS });
  assert.equal(await store.head('quarantine', 'q/none'), null);
  await store.put('quarantine', 'q/one', Buffer.from('hello'), 'text/plain');
  assert.deepEqual(await store.head('quarantine', 'q/one'), {
    sizeBytes: 5,
    contentType: 'text/plain',
  });
  assert.equal((await store.read('quarantine', 'q/one', 100)).toString(), 'hello');
  await assert.rejects(store.read('quarantine', 'q/one', 2));
  await store.remove('quarantine', 'q/one');
  await store.remove('quarantine', 'q/one');
  assert.equal(await store.head('quarantine', 'q/one'), null);

  const pkg = new S3PackageStore(s3, { bucket: b('pkg'), kmsKeyId: KMS });
  await pkg.put('p/abc', Buffer.from('zip'), 'application/zip');
  await pkg.remove('p/abc');

  const sink = new S3ExportSink(s3, { bucket: b('exp'), kmsKeyId: KMS });
  const id = '0192e0a0-0000-7000-8000-0000000000aa';
  await sink.putChunk(id, 0, Buffer.from('{"a":1}\n'));
  await sink.putChunk(id, 0, Buffer.from('{"a":1}\n'));
  await sink.putChunk(id, 1, Buffer.from('{"a":2}\n'));
  const { objectKey } = await sink.finalize(id, 2);
  assert.match(objectKey, /manifest\.json$/);

  const archive = new S3AnchorArchive(s3, { bucket: b('anchor'), kmsKeyId: KMS });
  const body = Buffer.from('{"schema":1}');
  const sha = createHash('sha256').update(body).digest();
  const first = await archive.putAnchor(`anchors/${suffix}/1.json`, body, sha);
  assert.equal(first.outcome, 'created');
  assert.deepEqual(await archive.putAnchor(`anchors/${suffix}/1.json`, body, sha), {
    outcome: 'exists',
  });
  const versions: string[] = [];
  for await (const v of archive.listVersions(`anchors/${suffix}/`)) versions.push(v.versionId);
  assert.equal(versions.length, 1);
  if (first.outcome === 'created')
    assert.equal(
      (await archive.getVersion(`anchors/${suffix}/1.json`, first.versionId)).toString(),
      body.toString(),
    );
});
