import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
} from '@aws-sdk/client-secrets-manager';
import { createLogger } from '@ehr/kernel';
import { createIntegrationCoreTasks } from './index.js';
import {
  countUnhealthyReplicas,
  REPLICA_GRACE_MS,
  type ReplicaCheckDeps,
} from './replica-health.js';

const KEY = 'arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555';
const replica = { region: 'us-west-2', kmsKeyId: KEY };
const NOW = Date.parse('2026-11-11T12:00:00Z');

type Desc = {
  ReplicationStatus?: {
    Region?: string;
    KmsKeyId?: string;
    Status?: string;
    StatusMessage?: string;
  }[];
  LastChangedDate?: Date;
  DeletedDate?: Date;
};

function harness(secrets: Record<string, Desc | 'error'>, pageSize = 100) {
  const sent: string[] = [];
  const lines: string[] = [];
  const names = Object.keys(secrets);
  const deps: ReplicaCheckDeps = {
    prefix: 'prod',
    replica,
    now: () => NOW,
    log: createLogger({ sink: (l) => lines.push(l) }),
    sm: {
      send: (cmd: unknown): Promise<never> => {
        sent.push((cmd as object).constructor.name);
        if (cmd instanceof ListSecretsCommand) {
          const i = cmd.input;
          assert.deepEqual(i.Filters, [{ Key: 'name', Values: ['prod/integration/'] }]);
          const from = i.NextToken === undefined ? 0 : Number(i.NextToken);
          const page = names.slice(from, from + pageSize);
          const next = from + pageSize < names.length ? String(from + pageSize) : undefined;
          return Promise.resolve({
            SecretList: page.map((Name) => ({
              Name,
              ...(((secrets[Name] as Desc) ?? {}).DeletedDate
                ? { DeletedDate: new Date(NOW) }
                : {}),
            })),
            NextToken: next,
          } as never);
        }
        if (cmd instanceof DescribeSecretCommand) {
          const s = secrets[cmd.input.SecretId as string];
          if (s === 'error' || s === undefined)
            return Promise.reject(
              Object.assign(new Error('boom hunter2'), { name: 'AccessDeniedException' }),
            );
          return Promise.resolve(s as never);
        }
        throw new Error(`unexpected ${(cmd as object).constructor.name}`);
      },
    },
  };
  return { deps, sent, lines };
}

const ok = (): Desc => ({
  ReplicationStatus: [{ Region: 'us-west-2', KmsKeyId: KEY, Status: 'InSync' }],
  LastChangedDate: new Date(NOW - 3 * REPLICA_GRACE_MS),
});

test('an InSync replica on the configured key counts 0; the key may be given as a bare id', async () => {
  const bare = ok();
  bare.ReplicationStatus![0]!.KmsKeyId = '11111111-2222-3333-4444-555555555555';
  const h = harness({ 'prod/integration/inbound/a': ok(), 'prod/integration/inbound/b': bare });
  assert.equal(await countUnhealthyReplicas(h.deps), 0);
  assert.deepEqual(h.lines, []);
});

test('Failed, a missing replica Region, the wrong key and a stuck InProgress each count 1', async () => {
  const failed = ok();
  failed.ReplicationStatus![0]!.Status = 'Failed';
  failed.ReplicationStatus![0]!.StatusMessage = 'vendor detail hunter2';
  const missing: Desc = { LastChangedDate: new Date(NOW) };
  const wrongKey = ok();
  wrongKey.ReplicationStatus![0]!.KmsKeyId = 'arn:aws:kms:us-west-2:111122223333:key/other';
  const stuck = ok();
  stuck.ReplicationStatus![0]!.Status = 'InProgress';
  stuck.LastChangedDate = new Date(NOW - REPLICA_GRACE_MS - 1);
  const h = harness({
    'prod/integration/inbound/failed': failed,
    'prod/integration/inbound/missing': missing,
    'prod/integration/inbound/wrongkey': wrongKey,
    'prod/integration/inbound/stuck': stuck,
    'prod/integration/inbound/fine': ok(),
  });
  assert.equal(await countUnhealthyReplicas(h.deps), 4);
  assert.equal(h.lines.length, 4);
  for (const l of h.lines) {
    const r = JSON.parse(l) as Record<string, unknown>;
    assert.equal(r['event'], 'secret_replica_unhealthy');
    assert.equal(r['region'], 'us-west-2');
    assert.ok(String(r['name']).startsWith('prod/integration/inbound/'));
    assert.equal(l.includes('hunter2'), false);
    assert.equal('StatusMessage' in r, false);
  }
});

test('InProgress inside the grace period counts 0; a secret with DeletedDate is skipped', async () => {
  const young = ok();
  young.ReplicationStatus![0]!.Status = 'InProgress';
  young.LastChangedDate = new Date(NOW - REPLICA_GRACE_MS + 1000);
  const gone: Desc = { DeletedDate: new Date(NOW) };
  const h = harness({
    'prod/integration/inbound/young': young,
    'prod/integration/inbound/gone': gone,
  });
  assert.equal(await countUnhealthyReplicas(h.deps), 0);
  assert.ok(
    !h.sent.includes('DescribeSecretCommand') ||
      h.sent.filter((s) => s === 'DescribeSecretCommand').length === 1,
  );
});

test('ListSecrets pagination is followed; a failed DescribeSecret counts that secret and the run continues', async () => {
  const all: Record<string, Desc | 'error'> = {};
  for (let i = 0; i < 5; i++) all[`prod/integration/inbound/s${i}`] = ok();
  all['prod/integration/inbound/s2'] = 'error';
  const h = harness(all, 2);
  assert.equal(await countUnhealthyReplicas(h.deps), 1);
  assert.equal(h.sent.filter((s) => s === 'ListSecretsCommand').length, 3);
  assert.equal(h.sent.filter((s) => s === 'DescribeSecretCommand').length, 5);
  assert.equal(
    h.lines.some((l) => l.includes('hunter2')),
    false,
  );
});

test('the SDK stub never receives GetSecretValue', async () => {
  const h = harness({ 'prod/integration/inbound/a': ok() });
  await countUnhealthyReplicas(h.deps);
  assert.equal(h.sent.includes(GetSecretValueCommand.name), false);
});

test('the job emits the gauge on every run (0 included, and with no secrets); a ListSecrets failure emits none', async () => {
  const gauges: [string, number][] = [];
  const metrics = { gauge: (n: string, v: number): void => void gauges.push([n, v]) };
  const run = async (deps: ReplicaCheckDeps | undefined): Promise<void> => {
    const tasks = createIntegrationCoreTasks({
      dispatch: {} as never,
      health: {} as never,
      apply: {} as never,
      ...(deps === undefined ? {} : { replicaCheck: deps }),
      metrics,
    });
    await (
      tasks['integration_core.check_secret_replicas'] as (p: unknown, h: unknown) => Promise<void>
    )({}, {});
  };
  await run(harness({}).deps);
  assert.deepEqual(gauges.pop(), ['SecretReplicaNotInSync', 0]);
  await run(
    harness({
      'prod/integration/inbound/a': ok(),
      'prod/integration/inbound/b': { LastChangedDate: new Date(NOW) },
    }).deps,
  );
  assert.deepEqual(gauges.pop(), ['SecretReplicaNotInSync', 1]);
  const broken = harness({}).deps;
  broken.sm = { send: () => Promise.reject(new Error('list failed')) } as never;
  await assert.rejects(run(broken));
  assert.deepEqual(gauges, []);
  await assert.rejects(run(undefined), /port not configured: secret_replica_check/);
});
