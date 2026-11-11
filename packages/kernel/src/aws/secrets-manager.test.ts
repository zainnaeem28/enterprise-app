import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SecretsManagerStore, SecretStoreError } from './secrets-manager.js';

type Sent = { kind: string; input: Record<string, unknown> };

/** A small in-memory Secrets Manager: versions per secret, idempotent on ClientRequestToken. */
class FakeSm {
  secrets = new Map<string, { versions: { id: string; value: string; token: string }[] }>();
  sent: Sent[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(cmd: any): Promise<any> {
    const i = cmd.input;
    const nf = Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' });
    const arnOf = (n: string): string => `arn:aws:secretsmanager:eu-west-2:1:secret:${n}-AbCdEf`;
    if (cmd instanceof PutSecretValueCommand || cmd instanceof CreateSecretCommand) {
      const name = (i.SecretId ?? i.Name) as string;
      this.sent.push({ kind: cmd.constructor.name, input: i });
      let s = this.secrets.get(name);
      if (cmd instanceof CreateSecretCommand) {
        if (s !== undefined)
          return Promise.reject(Object.assign(new Error('e'), { name: 'ResourceExistsException' }));
        s = { versions: [] };
        this.secrets.set(name, s);
      } else if (s === undefined) return Promise.reject(nf);
      const dup = s.versions.find((v) => v.token === i.ClientRequestToken);
      if (dup !== undefined) return Promise.resolve({ ARN: arnOf(name), VersionId: dup.id });
      const id = i.ClientRequestToken as string;
      s.versions.push({ id, value: i.SecretString, token: id });
      return Promise.resolve({ ARN: arnOf(name), VersionId: id });
    }
    if (cmd instanceof GetSecretValueCommand) {
      const name = String(i.SecretId).replace(/^arn:.*:secret:(.*)-AbCdEf$/, '$1');
      const s = this.secrets.get(name);
      if (s === undefined) return Promise.reject(nf);
      let v;
      if (i.VersionId !== undefined) v = s.versions.find((x) => x.id === i.VersionId);
      else if (i.VersionStage === 'AWSCURRENT') v = s.versions.at(-1);
      else v = s.versions.at(-2);
      if (v === undefined) return Promise.reject(nf);
      return Promise.resolve({ SecretString: v.value, VersionId: v.id });
    }
    throw new Error('unexpected');
  }
}

const conn = '0b1c2d3e-0000-4000-8000-000000000001';

test('names are built from the prefix and validated parts', () => {
  const st = new SecretsManagerStore(new FakeSm(), 'staging');
  assert.equal(st.outboundName(conn, 'api_key'), `staging/integration/outbound/${conn}/api_key`);
  assert.equal(st.inboundName('stripe'), 'staging/integration/inbound/stripe');
  for (const bad of ['../x', 'a/b', '', ' x', 'x\n']) {
    assert.throws(() => st.inboundName(bad));
    assert.throws(() => st.outboundName(conn, bad));
  }
  assert.throws(() => new SecretsManagerStore(new FakeSm(), 'a/b'));
});

test('first write creates, a new value adds a version, a retry with the same token returns the same version', async () => {
  const sm = new FakeSm();
  const st = new SecretsManagerStore(sm, 'p', 'alias/secrets');
  const n = st.inboundName('stripe');
  const v1 = await st.put(n, 'one', 'tok-1');
  assert.equal(sm.sent[1]?.kind, 'CreateSecretCommand');
  assert.equal(sm.sent[1]?.input['KmsKeyId'], 'alias/secrets');
  const retry = await st.put(n, 'one', 'tok-1');
  assert.deepEqual(retry, v1);
  const v2 = await st.put(n, 'two', 'tok-2');
  assert.notEqual(v2.versionId, v1.versionId);
  assert.equal(sm.secrets.get(n)?.versions.length, 2);
  assert.equal(await st.get(v1.arn, v1.versionId), 'one');
  assert.equal(await st.get(v2.arn, v2.versionId), 'two');
  const tok = sm.sent[0]?.input['ClientRequestToken'] as string;
  assert.match(tok, /^[0-9a-f]{64}$/);
});

test('the same token on a different secret name is a different write', async () => {
  const sm = new FakeSm();
  const st = new SecretsManagerStore(sm, 'p');
  const a = await st.put(st.inboundName('a'), 'x', 't');
  const b = await st.put(st.inboundName('b'), 'x', 't');
  assert.notEqual(a.versionId, b.versionId);
});

test('current and previous, current first; no previous is normal; no secret is an error without a value', async () => {
  const sm = new FakeSm();
  const st = new SecretsManagerStore(sm, 'p');
  const n = st.inboundName('google-calendar-channel-key');
  await st.put(n, 'k1', 'a');
  let r = await st.currentAndPrevious(n);
  assert.equal(r.length, 1);
  await st.put(n, 'k2', 'b');
  r = await st.currentAndPrevious(n);
  assert.deepEqual(
    r.map((x) => x.value.toString()),
    ['k2', 'k1'],
  );
  await assert.rejects(st.currentAndPrevious(st.inboundName('missing')), SecretStoreError);
});

test('errors name the secret and the failure class, never the value', async () => {
  const sm = new FakeSm();
  sm.send = () =>
    Promise.reject(
      Object.assign(new Error('Access denied for value hunter2'), {
        name: 'AccessDeniedException',
      }),
    );
  const st = new SecretsManagerStore(sm, 'p');
  const err = await st.put(st.inboundName('s'), 'hunter2', 't').catch((e: Error) => e);
  assert.ok(err instanceof SecretStoreError);
  assert.match(err.message, /AccessDeniedException/);
  assert.equal(err.message.includes('hunter2'), false);
  const r = await st.get('arn:x', 'v').catch((e: Error) => e);
  assert.equal((r as Error).message.includes('hunter2'), false);
});

test('empty and oversized values are refused before any request', async () => {
  const sm = new FakeSm();
  const st = new SecretsManagerStore(sm, 'p');
  await assert.rejects(st.put(st.inboundName('s'), '', 't'), SecretStoreError);
  await assert.rejects(st.put(st.inboundName('s'), 'x'.repeat(70_000), 't'), SecretStoreError);
  assert.equal(sm.sent.length, 0);
});
