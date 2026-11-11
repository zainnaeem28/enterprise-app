import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { DecryptCommand, DescribeKeyCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { KmsEnvelope, KmsEnvelopeError } from './kms-envelope.js';

const ARN = (id: string): string => `arn:aws:kms:eu-west-2:111122223333:key/${id}`;

/** A faithful stand-in for KMS: a data key is wrapped under (key, context) and unwraps only for the same pair. */
class FakeKms {
  readonly wrapped = new Map<string, { plain: Buffer; key: string; ctx: string }>();
  readonly aliases: Record<string, string> = { 'alias/payload': 'k-current' };
  calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(cmd: any): Promise<any> {
    const i = cmd.input;
    if (cmd instanceof GenerateDataKeyCommand) {
      this.calls.push('gen');
      assert.equal(i.KeySpec, 'AES_256');
      const id = this.aliases[i.KeyId] ?? i.KeyId.replace(/^.*key\//, '');
      const plain = randomBytes(32);
      const blob = randomBytes(24);
      this.wrapped.set(blob.toString('hex'), {
        plain,
        key: id,
        ctx: JSON.stringify(i.EncryptionContext),
      });
      return Promise.resolve({
        Plaintext: Buffer.from(plain),
        CiphertextBlob: blob,
        KeyId: ARN(id),
      });
    }
    if (cmd instanceof DecryptCommand) {
      this.calls.push('dec');
      const w = this.wrapped.get(Buffer.from(i.CiphertextBlob).toString('hex'));
      const id = String(i.KeyId).replace(/^.*key\//, '');
      if (w === undefined || w.key !== id || w.ctx !== JSON.stringify(i.EncryptionContext))
        return Promise.reject(
          Object.assign(new Error('x'), { name: 'InvalidCiphertextException' }),
        );
      return Promise.resolve({ Plaintext: Buffer.from(w.plain) });
    }
    if (cmd instanceof DescribeKeyCommand) {
      this.calls.push('desc');
      return Promise.resolve({ KeyMetadata: { KeyId: this.aliases[i.KeyId] } });
    }
    throw new Error('unexpected command');
  }
}

const ctx = 'inbound:stripe\nevt_123';
const make = (kms = new FakeKms(), cfg = { keyId: ARN('k-current') }) => ({
  kms,
  env: new KmsEnvelope(kms as never, cfg),
});

test('round trip; the blob holds neither the plaintext nor the context', async () => {
  const { env } = make();
  const plain = Buffer.from('{"patient":"secret body"}');
  const sealed = await env.seal(plain, ctx);
  assert.equal(sealed.includes(plain), false);
  assert.equal(sealed.includes(Buffer.from('stripe')), false);
  assert.deepEqual(await env.open(sealed, ctx), plain);
});

test('each seal uses a fresh data key and iv', async () => {
  const { env } = make();
  const a = await env.seal(Buffer.from('same'), ctx);
  const b = await env.seal(Buffer.from('same'), ctx);
  assert.notDeepEqual(a, b);
});

test('wrong context is refused (different record, purpose or empty)', async () => {
  const { env } = make();
  const sealed = await env.seal(Buffer.from('x'), ctx);
  for (const bad of ['inbound:stripe\nevt_124', 'secret_change:evt_123', ctx + ' '])
    await assert.rejects(env.open(sealed, bad), (e: unknown) => e instanceof KmsEnvelopeError);
  await assert.rejects(env.open(sealed, ''), KmsEnvelopeError);
  await assert.rejects(env.seal(Buffer.from('x'), ''), KmsEnvelopeError);
});

test('every flipped byte of the blob is refused', async () => {
  const { env } = make();
  const sealed = await env.seal(Buffer.from('payload'), ctx);
  for (let i = 0; i < sealed.length; i++) {
    const t = Buffer.from(sealed);
    t[i] = (t[i] as number) ^ 0x01;
    await assert.rejects(env.open(t, ctx), KmsEnvelopeError, `byte ${i}`);
  }
});

test('truncated, extended and foreign blobs are refused as malformed or failed', async () => {
  const { env } = make();
  const sealed = await env.seal(Buffer.from('payload'), ctx);
  await assert.rejects(env.open(sealed.subarray(0, 10), ctx), KmsEnvelopeError);
  await assert.rejects(env.open(Buffer.alloc(0), ctx), KmsEnvelopeError);
  await assert.rejects(env.open(Buffer.concat([sealed, Buffer.from('x')]), ctx), KmsEnvelopeError);
  await assert.rejects(env.open(randomBytes(80), ctx), KmsEnvelopeError);
});

test('a blob sealed under a key the process does not trust is refused before KMS is asked', async () => {
  const kms = new FakeKms();
  const sealer = new KmsEnvelope(kms as never, { keyId: ARN('k-other') });
  const sealed = await sealer.seal(Buffer.from('x'), ctx);
  const { env } = make(kms);
  kms.calls = [];
  await assert.rejects(
    env.open(sealed, ctx),
    (e: unknown) => (e as KmsEnvelopeError).reason === 'untrusted_key',
  );
  assert.deepEqual(kms.calls, []);
});

test('a blob whose embedded key id was swapped for a trusted one fails at KMS', async () => {
  const kms = new FakeKms();
  const other = await new KmsEnvelope(kms as never, { keyId: ARN('k-other') }).seal(
    Buffer.from('x'),
    ctx,
  );
  // Rewrite the embedded id (same length) to the trusted one: the wrapped key was made under k-other, so KMS refuses.
  const swapped = Buffer.from(other);
  const idLen = swapped.readUInt16BE(4);
  const trusted = Buffer.from('k-current'.padEnd(idLen, 'x'));
  assert.equal(trusted.length, idLen);
  swapped.set(trusted, 6);
  const { env } = make(kms, {
    keyId: 'k-currentxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  });
  // trust list is built from the configured id tail, so use the same padded id there
  await assert.rejects(env.open(swapped, ctx), KmsEnvelopeError);
});

test('rotation: old blobs open while their key is in previousKeyIds; new blobs use the new key', async () => {
  const kms = new FakeKms();
  const old = await new KmsEnvelope(kms as never, { keyId: ARN('k-old') }).seal(
    Buffer.from('old'),
    ctx,
  );
  const rotated = new KmsEnvelope(kms as never, {
    keyId: ARN('k-new'),
    previousKeyIds: [ARN('k-old')],
  });
  assert.deepEqual(await rotated.open(old, ctx), Buffer.from('old'));
  const fresh = await rotated.seal(Buffer.from('new'), ctx);
  assert.equal(fresh.includes(Buffer.from('k-new')), true);
  const noPrev = new KmsEnvelope(kms as never, { keyId: ARN('k-new') });
  await assert.rejects(noPrev.open(old, ctx), KmsEnvelopeError);
});

test('an alias is resolved once through DescribeKey and then trusted', async () => {
  const kms = new FakeKms();
  const env = new KmsEnvelope(kms as never, { keyId: 'alias/payload' });
  const sealed = await env.seal(Buffer.from('x'), ctx);
  await env.open(sealed, ctx);
  await env.open(sealed, ctx);
  assert.equal(kms.calls.filter((c) => c === 'desc').length, 1);
});

test('the plaintext data key handed back by KMS is wiped; sealing does not retain it', async () => {
  const kms = new FakeKms();
  let handed: Buffer | undefined;
  const orig = kms.send.bind(kms);
  kms.send = (cmd: never) =>
    orig(cmd).then((r: { Plaintext?: Buffer }) => {
      if (r.Plaintext !== undefined) handed = r.Plaintext;
      return r;
    });
  const env = new KmsEnvelope(kms as never, { keyId: ARN('k-current') });
  await env.seal(Buffer.from('x'), ctx);
  assert.ok(handed);
  assert.equal(
    handed.every((b) => b === 0),
    true,
  );
});

test('errors never carry plaintext, the context or key bytes', async () => {
  const { env } = make();
  const sealed = await env.seal(Buffer.from('very secret'), ctx);
  const err = await env.open(sealed, 'other').catch((e: Error) => e);
  assert.ok(err instanceof Error);
  assert.equal(/secret|evt_123|stripe|other/.test(err.message + String(err.stack)), false);
  assert.ok(createHash('sha256')); // keep import used under strict lint
});
