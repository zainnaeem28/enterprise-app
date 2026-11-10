import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowed } from '../lib/aws.mjs';
import { parseTaskResult } from '../lib/result.mjs';
import { parseArchiveResult } from '../audit-archive/result.mjs';
import { NOW } from './helpers.mjs';

const scope = { env: 'staging', record: 'bootstrap-staging' };
const refuse = (argv, re, s = scope) => assert.throws(() => assertAllowed(argv, s), re);

test('the allow-list refuses every call the workflows never make', () => {
  refuse(
    ['secretsmanager', 'get-secret-value', '--secret-id', 'bootstrap/staging/token/slot-1'],
    /never run/,
  );
  refuse(['secretsmanager', 'put-resource-policy', '--secret-id', 'x'], /never run/);
  refuse(['iam', 'attach-role-policy'], /never run/);
  refuse(['ecs', 'execute-command'], /never run/);
  refuse(['ecs', 'register-task-definition'], /never run/);
  refuse(['kms', 'decrypt'], /never run/);
});
test('RunTask overrides are refused', () => {
  refuse(['ecs', 'run-task', '--overrides', '{}'], /overrides/);
  refuse(['ecs', 'run-task', '--container-overrides', '{}'], /overrides/);
});
test("only this workflow's record is read", () => {
  assertAllowed(['ssm', 'get-parameter', '--name', '/approved/bootstrap-staging'], scope);
  refuse(
    ['ssm', 'get-parameter', '--name', '/approved/release'],
    /only \/approved\/bootstrap-staging/,
  );
  refuse(['ssm', 'get-parameter', '--name', '/approved/bootstrap-production'], /only \/approved/);
});
test('secrets: delete only a token secret of this environment, with force; rotate only the bootstrap credential', () => {
  const del = (id, extra = ['--force-delete-without-recovery']) => [
    'secretsmanager',
    'delete-secret',
    '--secret-id',
    id,
    ...extra,
  ];
  assertAllowed(del('bootstrap/staging/token/slot-1'), scope);
  refuse(del('bootstrap/staging/token/slot-1', []), /force-delete/);
  refuse(del('bootstrap/production/token/slot-1'), /not a bootstrap\/staging\/token/);
  refuse(del('staging/db/app-bootstrap'), /not a bootstrap/);
  refuse(del('bootstrap/staging/token/../x'), /not a bootstrap/);
  assertAllowed(
    ['secretsmanager', 'rotate-secret', '--secret-id', 'staging/db/app-bootstrap'],
    scope,
  );
  refuse(
    ['secretsmanager', 'rotate-secret', '--secret-id', 'staging/db/app'],
    /only <env>\/db\/app-bootstrap/,
  );
  refuse(
    ['secretsmanager', 'rotate-secret', '--secret-id', 'bootstrap/staging/token/slot-1'],
    /only <env>\/db\/app-bootstrap/,
  );
});

const arn = (slot) =>
  `arn:aws:secretsmanager:eu-west-1:111111111111:secret:bootstrap/staging/token/${slot}-AbC123`;
const U = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const good = () => ({
  mode: 'create',
  run_ref: '99',
  expires: new Date(NOW.getTime() + 30 * 60000).toISOString(),
  enrollees: [
    {
      slot: 'slot-1',
      principal_id: U(1),
      result: 'issued',
      token_id: U(3),
      secret_arn: arn('slot-1'),
    },
    {
      slot: 'slot-2',
      principal_id: U(2),
      result: 'issued',
      token_id: U(4),
      secret_arn: arn('slot-2'),
    },
  ],
});
const parse = (o, lines) =>
  parseTaskResult(lines ?? ['starting', JSON.stringify(o)], {
    env: 'staging',
    runRef: '99',
    now: NOW,
  });

test('a well-formed task result is accepted and normalised', () => {
  const r = parse(good());
  assert.equal(r.enrollees.length, 2);
  assert.equal(r.enrollees[0].secretArn, arn('slot-1'));
});
test('a skipped slot is accepted only with its secret already deleted', () => {
  const g = good();
  g.enrollees[1] = { slot: 'slot-2', principal_id: U(2), result: 'skipped', secret: 'deleted' };
  assert.equal(parse(g).enrollees[1].result, 'skipped');
  g.enrollees[1].secret = 'present';
  assert.throws(() => parse(g), /deleted/);
});
test('malformed results are failures: other run, bad result value, wrong secret, far expiry, one slot, two lines', () => {
  assert.throws(() => parse({ ...good(), run_ref: '1' }), /run_ref/);
  const g = good();
  g.enrollees[0].result = 'maybe';
  assert.throws(() => parse(g), /neither issued nor skipped/);
  const h = good();
  h.enrollees[0].secret_arn = 'arn:aws:secretsmanager:eu-west-1:111111111111:secret:other-name';
  assert.throws(() => parse(h), /secret_arn/);
  const i = good();
  i.enrollees[0].secret_arn = arn('slot-2');
  assert.throws(() => parse(i), /secret_arn/);
  assert.throws(
    () => parse({ ...good(), expires: new Date(NOW.getTime() + 3600000).toISOString() }),
    /30 minutes/,
  );
  assert.throws(() => parse({ ...good(), enrollees: [good().enrollees[0]] }), /two enrollee/);
  assert.throws(
    () => parse(good(), [JSON.stringify(good()), JSON.stringify(good())]),
    /more than one/,
  );
  assert.throws(() => parse(good(), ['nothing']), /no result/);
});
test('a token-like string anywhere in the output is refused without echoing it', () => {
  const tok = 'A'.repeat(43);
  try {
    parse(good(), [`debug ${tok}`, JSON.stringify(good())]);
    assert.fail('should refuse');
  } catch (e) {
    assert.match(e.message, /token-like/);
    assert.ok(!e.message.includes(tok));
  }
  // ARNs, UUIDs and timestamps are not token-like
  assert.ok(parse(good()));
});

const arch = () => ({
  partition: 'audit.event_2025_01',
  hot_row_count: 10,
  hot_anchor_roots_sha256: 'a'.repeat(64),
  readback: {
    verified: true,
    row_count: 10,
    anchor_roots_sha256: 'a'.repeat(64),
    object_lock: 'COMPLIANCE',
  },
  archive_key: 'audit/2025/01.parquet',
  dropped: true,
  audit_event_id: 'ev-12345678',
  manifest_entry: 'manifest/2025-01',
});
const pa = (o) => parseArchiveResult([JSON.stringify(o)], { partition: 'audit.event_2025_01' });
test('an archive result must claim read-back, matching counts and roots, Object Lock, drop, audit event and manifest', () => {
  assert.equal(pa(arch()).rowCount, 10);
  const m = (f) => {
    const x = arch();
    f(x);
    return x;
  };
  assert.throws(
    () =>
      pa(
        m((x) => {
          x.readback.verified = false;
        }),
      ),
    /read-back/,
  );
  assert.throws(
    () =>
      pa(
        m((x) => {
          x.readback.row_count = 9;
        }),
      ),
    /row count/,
  );
  assert.throws(
    () =>
      pa(
        m((x) => {
          x.readback.anchor_roots_sha256 = 'b'.repeat(64);
        }),
      ),
    /anchor roots/,
  );
  assert.throws(
    () =>
      pa(
        m((x) => {
          x.readback.object_lock = 'GOVERNANCE';
        }),
      ),
    /Object Lock/,
  );
  assert.throws(
    () =>
      pa(
        m((x) => {
          x.dropped = false;
        }),
      ),
    /not dropped/,
  );
  assert.throws(
    () =>
      pa(
        m((x) => {
          delete x.audit_event_id;
        }),
      ),
    /audit event/,
  );
  assert.throws(
    () =>
      pa(
        m((x) => {
          delete x.manifest_entry;
        }),
      ),
    /manifest/,
  );
  assert.throws(
    () =>
      pa(
        m((x) => {
          x.partition = 'audit.event_2025_02';
        }),
      ),
    /different partition/,
  );
});
