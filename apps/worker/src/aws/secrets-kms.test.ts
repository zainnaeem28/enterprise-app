import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, SecretsManagerStore } from '@ehr/kernel';
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
