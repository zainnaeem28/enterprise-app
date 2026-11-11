import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AwsConfigError, createLogger, SecretsManagerStore } from '@ehr/kernel';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  CHANNEL_KEY_SECRET,
  SecretsManagerChannelKey,
  selectSecretsWorkerInfra,
} from './secrets-kms.js';

const log = createLogger({ sink: () => undefined });

test('nothing configured -> no adapters', () => {
  assert.deepEqual(selectSecretsWorkerInfra({}, log), {});
});

test('configured -> reader, writer, channel key and opener', () => {
  const r = selectSecretsWorkerInfra(
    {
      AWS_REGION: 'eu-west-2',
      EHR_SECRETS_PREFIX: 'prod',
      EHR_KMS_PAYLOAD_KEY_ID: 'alias/payload',
      EHR_KMS_PAYLOAD_PREVIOUS_KEY_IDS: 'alias/old, ',
    },
    log,
  );
  assert.ok(r.secretReader && r.secretWriter && r.channelKeys && r.payloadOpener);
});

test('channel key reads the fixed inbound name and returns the current version', async () => {
  const seen: string[] = [];
  const sm = {
    send: (cmd: unknown) => {
      assert.ok(cmd instanceof GetSecretValueCommand);
      const i = (cmd as GetSecretValueCommand).input;
      seen.push(`${i.SecretId}#${i.VersionStage}`);
      if (i.VersionStage === 'AWSPREVIOUS')
        return Promise.reject(Object.assign(new Error('x'), { name: 'ResourceNotFoundException' }));
      return Promise.resolve({ SecretString: 'channel-key', VersionId: 'v-1' });
    },
  };
  const k = await new SecretsManagerChannelKey(
    new SecretsManagerStore(sm as never, 'prod'),
  ).current();
  assert.deepEqual(seen[0], `prod/integration/inbound/${CHANNEL_KEY_SECRET}#AWSCURRENT`);
  assert.equal(k.version, 'v-1');
  assert.equal(k.key.toString(), 'channel-key');
});

test('channel key refuses when the secret does not exist', async () => {
  const sm = {
    send: () =>
      Promise.reject(Object.assign(new Error('x'), { name: 'ResourceNotFoundException' })),
  };
  await assert.rejects(
    new SecretsManagerChannelKey(new SecretsManagerStore(sm as never, 'prod')).current(),
  );
});

// --- recovery-Region replica (HEAAA-860) ---
const KEY = 'arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555';
const prod = { AWS_REGION: 'eu-west-2', EHR_SECRETS_PREFIX: 'prod' };

test('both replica variables -> the replica check is offered; without them it is not', () => {
  const on = selectSecretsWorkerInfra(
    { ...prod, EHR_SECRETS_REPLICA_REGION: 'us-west-2', EHR_SECRETS_REPLICA_KMS_KEY_ID: KEY },
    log,
  );
  assert.ok(on.secretWriter && on.replicaCheck);
  assert.deepEqual(on.replicaCheck.replica, { region: 'us-west-2', kmsKeyId: KEY });
  assert.equal(on.replicaCheck.prefix, 'prod');
  assert.equal(selectSecretsWorkerInfra(prod, log).replicaCheck, undefined);
});

test('one replica variable, the same Region, a key in another Region, or no prefix stops the start', () => {
  const bad = (env: Record<string, string>): void =>
    assert.throws(() => selectSecretsWorkerInfra(env, log), AwsConfigError);
  bad({ ...prod, EHR_SECRETS_REPLICA_REGION: 'us-west-2' });
  bad({ ...prod, EHR_SECRETS_REPLICA_KMS_KEY_ID: KEY });
  bad({
    ...prod,
    AWS_REGION: 'us-west-2',
    EHR_SECRETS_REPLICA_REGION: 'us-west-2',
    EHR_SECRETS_REPLICA_KMS_KEY_ID: KEY,
  });
  bad({ ...prod, EHR_SECRETS_REPLICA_REGION: 'us-east-1', EHR_SECRETS_REPLICA_KMS_KEY_ID: KEY });
  bad({
    AWS_REGION: 'eu-west-2',
    EHR_SECRETS_REPLICA_REGION: 'us-west-2',
    EHR_SECRETS_REPLICA_KMS_KEY_ID: KEY,
  });
});
