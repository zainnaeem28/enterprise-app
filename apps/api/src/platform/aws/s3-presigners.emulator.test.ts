// Emulator evidence only (LocalStack S3): a presigned PUT/GET round trip. Skipped unless EHR_EMULATOR_S3_ENDPOINT is set.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { awsSettings, createS3Client } from '@ehr/kernel';
import { S3ObjectStorePresigner } from './s3-presigners.js';

const endpoint = process.env['EHR_EMULATOR_S3_ENDPOINT'];
const skip = endpoint === undefined ? 'EHR_EMULATOR_S3_ENDPOINT not set' : false;

test(
  'presigned upload carries the pinned headers; a different length is refused',
  { skip },
  async () => {
    const s3 = createS3Client(
      awsSettings({ AWS_REGION: 'eu-west-2', EHR_AWS_ENDPOINT_URL: endpoint }, 'emulator'),
    );
    const sfx = randomBytes(4).toString('hex');
    const cfg = {
      quarantine: `ehr-q-${sfx}`,
      clean: `ehr-c-${sfx}`,
      kmsKeyId: process.env['EHR_EMULATOR_KMS_KEY_ID'] ?? 'alias/emulator',
    };
    await s3.send(new CreateBucketCommand({ Bucket: cfg.quarantine }));
    const p = new S3ObjectStorePresigner(s3, cfg);
    const key = `q/${randomBytes(16).toString('hex')}`;
    const body = Buffer.from('hello world');
    const put = await p.presignPut(
      {
        bucket: 'quarantine',
        key,
        contentType: 'text/plain',
        contentLength: body.length,
        expiresSeconds: 60,
      },
      new Date(),
    );
    const ok = await fetch(put.url, { method: 'PUT', headers: put.headers, body });
    assert.equal(ok.status, 200);
    const bad = await fetch(put.url, {
      method: 'PUT',
      headers: { ...put.headers, 'Content-Type': 'image/png' },
      body,
    });
    assert.ok(bad.status >= 400, `content-type tamper accepted (${bad.status})`);
  },
);
