import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { createLogger } from '../logging/logger.js';
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

// --- recovery-Region replica (HEAAA-860, HEAAA-870 D-2) ---
const REPLICA = {
  region: 'us-west-2',
  kmsKeyId: 'arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555',
};

test('with a replica, the first-use CreateSecret carries AddReplicaRegions exactly; the primary key and token are unchanged; no force-overwrite', async () => {
  const sm = new FakeSm();
  const st = new SecretsManagerStore(sm, 'p', 'alias/secrets', REPLICA);
  await st.put(st.outboundName(conn, 'api_key'), 'v', 'tok');
  const create = sm.sent.find((s) => s.kind === 'CreateSecretCommand');
  assert.deepEqual(create?.input['AddReplicaRegions'], [
    { Region: 'us-west-2', KmsKeyId: REPLICA.kmsKeyId },
  ]);
  assert.equal(create?.input['KmsKeyId'], 'alias/secrets');
  assert.equal('ForceOverwriteReplicaSecret' in (create?.input ?? {}), false);
  assert.match(create?.input['ClientRequestToken'] as string, /^[0-9a-f]{64}$/);
});

test('PutSecretValue never carries replica fields, and the creation-race path still works', async () => {
  const sm = new FakeSm();
  const st = new SecretsManagerStore(sm, 'p', undefined, REPLICA);
  const n = st.inboundName('stripe');
  await st.put(n, 'one', 'a');
  await st.put(n, 'two', 'b');
  for (const s of sm.sent.filter((x) => x.kind === 'PutSecretValueCommand'))
    assert.deepEqual(Object.keys(s.input).sort(), [
      'ClientRequestToken',
      'SecretId',
      'SecretString',
    ]);
  // Lost race: the secret appears between the first put and the create.
  const racing = new FakeSm();
  const orig = racing.send.bind(racing);
  let first = true;
  racing.send = (cmd: unknown) => {
    if (first && cmd instanceof PutSecretValueCommand) {
      first = false;
      racing.secrets.set('p/integration/inbound/race', { versions: [] });
      return Promise.reject(Object.assign(new Error('x'), { name: 'ResourceNotFoundException' }));
    }
    return orig(cmd);
  };
  const r = new SecretsManagerStore(racing, 'p', undefined, REPLICA);
  const v = await r.put(r.inboundName('race'), 'x', 't');
  assert.ok(v.versionId);
});

test('without a replica the CreateSecret input is exactly what it was', async () => {
  const sm = new FakeSm();
  const st = new SecretsManagerStore(sm, 'p', 'alias/secrets');
  await st.put(st.inboundName('s'), 'v', 't');
  const create = sm.sent.find((s) => s.kind === 'CreateSecretCommand');
  assert.deepEqual(Object.keys(create?.input ?? {}).sort(), [
    'ClientRequestToken',
    'KmsKeyId',
    'Name',
    'SecretString',
  ]);
});

test('no policy or replication command is ever sent', async () => {
  const sm = new FakeSm();
  const st = new SecretsManagerStore(sm, 'p', undefined, REPLICA);
  await st.put(st.inboundName('s'), 'v', 't');
  await st.put(st.inboundName('s'), 'w', 'u');
  const kinds = new Set(sm.sent.map((s) => s.kind));
  assert.deepEqual([...kinds].sort(), ['CreateSecretCommand', 'PutSecretValueCommand']);
});

test('a Failed replica logs one warning with the name and Region, no value or vendor message, and the write stands', async () => {
  const sm = new FakeSm();
  const orig = sm.send.bind(sm);
  sm.send = async (cmd: unknown) => {
    const r = await orig(cmd);
    if (cmd instanceof CreateSecretCommand)
      return {
        ...r,
        ReplicationStatus: [
          { Region: 'us-west-2', Status: 'Failed', StatusMessage: 'key hunter2 denied' },
        ],
      };
    return r;
  };
  const lines: string[] = [];
  const log = createLogger({ sink: (l) => lines.push(l) });
  const st = new SecretsManagerStore(sm, 'p', undefined, REPLICA, log);
  const n = st.inboundName('s');
  const v = await st.put(n, 'hunter2', 't');
  assert.ok(v.versionId);
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(rec['event'], 'secret_replication_failed');
  assert.equal(rec['name'], n);
  assert.equal(rec['region'], 'us-west-2');
  assert.equal(lines[0]?.includes('hunter2'), false);
});

test('an InProgress replica logs nothing', async () => {
  const sm = new FakeSm();
  const orig = sm.send.bind(sm);
  sm.send = async (cmd: unknown) => {
    const r = await orig(cmd);
    return cmd instanceof CreateSecretCommand
      ? { ...r, ReplicationStatus: [{ Region: 'us-west-2', Status: 'InProgress' }] }
      : r;
  };
  const lines: string[] = [];
  const st = new SecretsManagerStore(
    sm,
    'p',
    undefined,
    REPLICA,
    createLogger({ sink: (l) => lines.push(l) }),
  );
  await st.put(st.inboundName('s'), 'v', 't');
  assert.deepEqual(lines, []);
});
