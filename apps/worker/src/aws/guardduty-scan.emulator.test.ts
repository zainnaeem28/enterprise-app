// Emulator evidence only (LocalStack S3 tagging): the tag is written by the test, NOT by GuardDuty, which no emulator provides. It shows
// the adapter reads S3 object tags correctly; it does not show GuardDuty's tag name, values or timing (go-live checklist).
// Skipped unless EHR_EMULATOR_S3_ENDPOINT is set.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { CreateBucketCommand, PutObjectCommand, PutObjectTaggingCommand } from '@aws-sdk/client-s3';
import { awsSettings, createS3Client } from '@ehr/kernel';
import { GUARDDUTY_TAG, S3TagScanClient, guardDutyScanCaller } from './guardduty-scan.js';

const endpoint = process.env['EHR_EMULATOR_S3_ENDPOINT'];
const skip = endpoint === undefined ? 'EHR_EMULATOR_S3_ENDPOINT not set' : false;

test('scan tag is read from a real S3 API (emulator)', { skip }, async () => {
  const s3 = createS3Client(
    awsSettings({ AWS_REGION: 'eu-west-2', EHR_AWS_ENDPOINT_URL: endpoint }, 'emulator'),
  );
  const bucket = `ehr-q-${randomBytes(4).toString('hex')}`;
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  const scan = guardDutyScanCaller(new S3TagScanClient(s3, { quarantine: bucket, clean: bucket }));
  const key = (n: string): string => `q/${n.repeat(32)}`;
  for (const k of ['a', 'b', 'c'])
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key(k), Body: 'x' }));
  assert.equal(await scan('quarantine', key('a')), 'pending');
  const tag = (k: string, v: string) =>
    s3.send(
      new PutObjectTaggingCommand({
        Bucket: bucket,
        Key: key(k),
        Tagging: { TagSet: [{ Key: GUARDDUTY_TAG, Value: v }] },
      }),
    );
  await tag('a', 'NO_THREATS_FOUND');
  await tag('b', 'THREATS_FOUND');
  await tag('c', 'FAILED');
  assert.equal(await scan('quarantine', key('a')), 'clean');
  assert.equal(await scan('quarantine', key('b')), 'infected');
  assert.equal(await scan('quarantine', key('c')), 'error');
  await assert.rejects(scan('quarantine', key('d'))); // no such object: an outage, never clean
});
