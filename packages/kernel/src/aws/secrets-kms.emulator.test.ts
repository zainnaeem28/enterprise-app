// Emulator evidence only (LocalStack KMS and Secrets Manager); skipped unless EHR_EMULATOR_S3_ENDPOINT (the LocalStack edge URL) is set.
// It shows the requests are well formed and the emulator honours the API contract, not any behaviour of real AWS (key policy, IAM).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { CreateKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { awsSettings, createKmsClient, createSecretsManagerClient } from './config.js';
import { KmsEnvelope, KmsEnvelopeError } from './kms-envelope.js';
import { SecretsManagerStore } from './secrets-manager.js';

const endpoint = process.env['EHR_EMULATOR_S3_ENDPOINT'];
const skip = endpoint === undefined ? 'EHR_EMULATOR_S3_ENDPOINT not set' : false;
const settings = (): ReturnType<typeof awsSettings> =>
  awsSettings({ AWS_REGION: 'eu-west-2', EHR_AWS_ENDPOINT_URL: endpoint }, 'emulator');
const newKey = async (kms: KMSClient): Promise<string> =>
  (await kms.send(new CreateKeyCommand({}))).KeyMetadata?.KeyId as string;

test(
  'KMS envelope: round trip, wrong context, tampered blob and wrong key against LocalStack',
  { skip },
  async () => {
    const kms = createKmsClient(settings());
    const [a, b] = [await newKey(kms), await newKey(kms)];
    const env = new KmsEnvelope(kms, { keyId: a });
    const ctx = `inbound:test\n${randomBytes(4).toString('hex')}`;
    const plain = Buffer.from('emulator payload');
    const sealed = await env.seal(plain, ctx);
    assert.deepEqual(await env.open(sealed, ctx), plain);
    await assert.rejects(env.open(sealed, ctx + 'x'), KmsEnvelopeError);
    const t = Buffer.from(sealed);
    t[t.length - 1] = (t[t.length - 1] as number) ^ 1;
    await assert.rejects(env.open(t, ctx), KmsEnvelopeError);
    await assert.rejects(new KmsEnvelope(kms, { keyId: b }).open(sealed, ctx), KmsEnvelopeError);
    // rotation: a process that now seals with b still opens a's blob while a is listed as previous
    const rotated = new KmsEnvelope(kms, { keyId: b, previousKeyIds: [a] });
    assert.deepEqual(await rotated.open(sealed, ctx), plain);
  },
);

test(
  'Secrets Manager: create, new version, idempotent retry, read by version and by stage',
  { skip },
  async () => {
    const st = new SecretsManagerStore(
      createSecretsManagerClient(settings()),
      `emu${randomBytes(3).toString('hex')}`,
    );
    const n = st.inboundName('stripe');
    const v1 = await st.put(n, 'one', 'tok-1');
    assert.deepEqual(await st.put(n, 'one', 'tok-1'), v1);
    const v2 = await st.put(n, 'two', 'tok-2');
    assert.notEqual(v1.versionId, v2.versionId);
    assert.equal(await st.get(v1.arn, v1.versionId), 'one');
    const [cur, prev] = await st.currentAndPrevious(n);
    assert.equal(cur?.value.toString(), 'two');
    assert.equal(prev?.value.toString(), 'one');
  },
);
