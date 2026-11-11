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

// --- recovery-Region replica (HEAAA-860) ---
const KEY = 'arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555';
const prod = { AWS_REGION: 'eu-west-2', EHR_SECRETS_PREFIX: 'prod' };

test('both replica variables -> the store is built', () => {
  const r = selectApiSecretPorts(
    { ...prod, EHR_SECRETS_REPLICA_REGION: 'us-west-2', EHR_SECRETS_REPLICA_KMS_KEY_ID: KEY },
    log,
  );
  assert.ok(r.secretStore);
});

test('one replica variable alone stops the start, naming the missing one', () => {
  assert.throws(
    () => selectApiSecretPorts({ ...prod, EHR_SECRETS_REPLICA_REGION: 'us-west-2' }, log),
    (e: unknown) =>
      e instanceof AwsConfigError && /EHR_SECRETS_REPLICA_KMS_KEY_ID/.test((e as Error).message),
  );
  assert.throws(
    () => selectApiSecretPorts({ ...prod, EHR_SECRETS_REPLICA_KMS_KEY_ID: KEY }, log),
    (e: unknown) =>
      e instanceof AwsConfigError && /EHR_SECRETS_REPLICA_REGION/.test((e as Error).message),
  );
});

test('the replica Region equal to AWS_REGION, or a key ARN in another Region, is refused', () => {
  assert.throws(
    () =>
      selectApiSecretPorts(
        {
          ...prod,
          AWS_REGION: 'us-west-2',
          EHR_SECRETS_REPLICA_REGION: 'us-west-2',
          EHR_SECRETS_REPLICA_KMS_KEY_ID: KEY,
        },
        log,
      ),
    AwsConfigError,
  );
  assert.throws(
    () =>
      selectApiSecretPorts(
        { ...prod, EHR_SECRETS_REPLICA_REGION: 'us-east-1', EHR_SECRETS_REPLICA_KMS_KEY_ID: KEY },
        log,
      ),
    AwsConfigError,
  );
});

test('replica variables without the secrets prefix stop the start', () => {
  assert.throws(
    () =>
      selectApiSecretPorts(
        {
          AWS_REGION: 'eu-west-2',
          EHR_SECRETS_REPLICA_REGION: 'us-west-2',
          EHR_SECRETS_REPLICA_KMS_KEY_ID: KEY,
        },
        log,
      ),
    (e: unknown) => e instanceof AwsConfigError && /EHR_SECRETS_PREFIX/.test((e as Error).message),
  );
});
