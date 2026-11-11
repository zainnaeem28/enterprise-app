import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AwsConfigError, createLogger } from '@ehr/kernel';
import { selectApiSecretPorts } from './secrets-kms.js';

const log = createLogger({ sink: () => undefined });

test('nothing configured keeps every refusing port', () => {
  assert.deepEqual(selectApiSecretPorts({}, log), {});
});

test('a configured group builds its ports', () => {
  const r = selectApiSecretPorts(
    {
      AWS_REGION: 'eu-west-2',
      EHR_SECRETS_PREFIX: 'prod',
      EHR_KMS_PAYLOAD_KEY_ID: 'alias/payload',
    },
    log,
  );
  assert.ok(r.secretStore && r.inboundKeys && r.sealer);
});

test('a configured group without AWS_REGION stops the start, naming the variable', () => {
  assert.throws(
    () => selectApiSecretPorts({ EHR_SECRETS_PREFIX: 'prod' }, log),
    (e: unknown) => e instanceof AwsConfigError && /AWS_REGION/.test((e as Error).message),
  );
});

test('an invalid prefix stops the start', () => {
  assert.throws(() =>
    selectApiSecretPorts({ AWS_REGION: 'eu-west-2', EHR_SECRETS_PREFIX: 'a/b' }, log),
  );
});
