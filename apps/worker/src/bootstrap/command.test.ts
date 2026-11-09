// Unit tests of the run-once `bootstrap-admins` command (INT04-F02b, decision log section 5 test 8), with fakes for the approved record, the
// secret store and the database function. No database. The fake secret store refuses exactly what the task role may not do (decision log
// 4.1 item 3): it can create and force-delete token secrets and nothing else, so a command that relied on another identity fails here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { runBootstrapAdmins, SECURITY_CONTACT_MAX_AGE_MS, type BootstrapDeps } from './command.js';
import {
  BootstrapRefusedError,
  type BootstrapCallInput,
  type BootstrapDbPort,
  type SecretStorePort,
} from './ports.js';

const ORG = '00000000-0000-7000-8000-0000000000a1';
const P1 = '00000000-0000-7000-8000-0000000000b1';
const P2 = '00000000-0000-7000-8000-0000000000b2';
const T1 = '00000000-0000-7000-8000-0000000000c1';
const T2 = '00000000-0000-7000-8000-0000000000c2';
const RUN = '00000000-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-11-09T12:00:00Z');

class FakeSecrets implements SecretStorePort {
  readonly calls: string[] = [];
  readonly live = new Map<number, Buffer>();
  failCreate: number | undefined;
  failDelete = new Set<number>();
  /** The identity the fake acts as: the bootstrap task role. Everything else is denied, like the allowlist says. */
  readonly identity = 'bootstrap_task';
  async createTokenSecret(i: {
    env: string;
    slot: 1 | 2;
    runRef: string;
    value: Buffer;
  }): Promise<{ arn: string }> {
    this.calls.push(`create:${i.slot}`);
    if (this.failCreate === i.slot) throw new Error('AccessDenied');
    assert.equal(i.env, 'staging');
    this.live.set(i.slot, Buffer.from(i.value));
    return { arn: `arn:aws:secretsmanager:eu-west-1:1:secret:bootstrap/staging/token/${i.slot}` };
  }
  async forceDeleteTokenSecret(i: { env: string; slot: 1 | 2 }): Promise<void> {
    this.calls.push(`delete:${i.slot}`);
    if (this.failDelete.has(i.slot)) throw new Error('AccessDenied');
    this.live.delete(i.slot);
  }
}

interface Fake {
  deps: BootstrapDeps;
  secrets: FakeSecrets;
  lines: string[];
  dbCalls: BootstrapCallInput[];
  events: string[];
}
function setup(
  over: {
    record?: unknown;
    noticeChannel?: string | undefined;
    result?: unknown;
    dbError?: unknown;
    now?: Date;
  } = {},
): Fake {
  const secrets = new FakeSecrets();
  const lines: string[] = [];
  const dbCalls: BootstrapCallInput[] = [];
  const events: string[] = [];
  const record =
    'record' in over
      ? over.record
      : {
          ticketRef: 'CHG-1',
          enrollees: [
            { handle: 'ann.admin', displayName: 'Ann' },
            { handle: 'ben.admin', displayName: 'Ben' },
          ],
          custodians: [
            { idpId: 'idp-1', displayName: 'Cy' },
            { idpId: 'idp-2', displayName: 'Di' },
          ],
          securityContactVerifiedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
          securityContactTestRef: 'TEST-7',
        };
  const db: BootstrapDbPort = {
    async call(i) {
      events.push('db');
      dbCalls.push(i);
      if (over.dbError !== undefined) throw over.dbError;
      return 'result' in over
        ? over.result
        : {
            mode: 'create',
            run_id: RUN,
            expires_at: '2026-11-09T12:30:00Z',
            enrollees: [
              { slot: 1, principal_id: P1, result: 'issued', token_id: T1 },
              { slot: 2, principal_id: P2, result: 'issued', token_id: T2 },
            ],
          };
    },
  };
  const deps: BootstrapDeps = {
    env: 'staging',
    orgId: ORG,
    runRef: 'gh-run-42',
    noticeChannel: 'noticeChannel' in over ? over.noticeChannel : 'security@example.test',
    record: {
      async read(env) {
        events.push(`record:${env}`);
        return record;
      },
    },
    secrets,
    db,
    out: (l) => lines.push(l),
    now: () => over.now ?? NOW,
  };
  return { deps, secrets, lines, dbCalls, events };
}

const noSecretOrDb = (f: Fake): void => {
  assert.deepEqual(f.secrets.calls, [], 'no secret call');
  assert.deepEqual(f.dbCalls, [], 'no database call');
};

describe('refusals before any secret or database call', () => {
  test('notice channel unset', async () => {
    for (const ch of [undefined, '', '  ']) {
      const f = setup({ noticeChannel: ch });
      const r = await runBootstrapAdmins(f.deps);
      assert.equal(r.exitCode, 1);
      noSecretOrDb(f);
    }
  });
  test('security-contact check missing, without a test reference, older than 72 hours, or in the future', async () => {
    const base = (over: Record<string, unknown>): unknown => ({
      ticketRef: 'CHG-1',
      enrollees: [
        { handle: 'ann.admin', displayName: 'Ann' },
        { handle: 'ben.admin', displayName: 'Ben' },
      ],
      custodians: [
        { idpId: 'idp-1', displayName: 'Cy' },
        { idpId: 'idp-2', displayName: 'Di' },
      ],
      ...over,
    });
    const fresh = new Date(NOW.getTime() - 1000).toISOString();
    const cases: Record<string, unknown>[] = [
      {},
      { securityContactVerifiedAt: fresh },
      { securityContactTestRef: 'T' },
      {
        securityContactVerifiedAt: new Date(
          NOW.getTime() - SECURITY_CONTACT_MAX_AGE_MS - 1000,
        ).toISOString(),
        securityContactTestRef: 'T',
      },
      {
        securityContactVerifiedAt: new Date(NOW.getTime() + 3600_000).toISOString(),
        securityContactTestRef: 'T',
      },
      { securityContactVerifiedAt: 'yesterday', securityContactTestRef: 'T' },
    ];
    for (const c of cases) {
      const f = setup({ record: base(c) });
      const r = await runBootstrapAdmins(f.deps);
      assert.equal(r.exitCode, 1, JSON.stringify(c));
      noSecretOrDb(f);
    }
    // control: exactly 72 hours old is still accepted
    const f = setup({
      record: base({
        securityContactVerifiedAt: new Date(
          NOW.getTime() - SECURITY_CONTACT_MAX_AGE_MS,
        ).toISOString(),
        securityContactTestRef: 'T',
      }),
    });
    assert.equal((await runBootstrapAdmins(f.deps)).exitCode, 0);
  });
  test('an invalid approved record', async () => {
    for (const record of [
      null,
      'x',
      { ticketRef: 'x' },
      { ticketRef: 'x', enrollees: [], custodians: [] },
    ]) {
      const f = setup({ record });
      assert.equal((await runBootstrapAdmins(f.deps)).exitCode, 1);
      noSecretOrDb(f);
    }
  });
});

describe('the successful run', () => {
  test('inputs come from the approved record only; the secrets are created before the call; the hash is of the token string; the output holds no token or hash', async () => {
    const f = setup();
    const r = await runBootstrapAdmins(f.deps);
    assert.equal(r.exitCode, 0, f.lines.join('\n'));
    assert.deepEqual(f.events, ['record:staging', 'db']);
    assert.deepEqual(f.secrets.calls.slice(0, 2), ['create:1', 'create:2']);
    assert.equal(f.dbCalls.length, 1);
    const call = f.dbCalls[0] as BootstrapCallInput;
    assert.equal(call.ticketRef, 'CHG-1');
    assert.equal(call.runRef, 'gh-run-42');
    assert.deepEqual(call.enrollees, [
      { handle: 'ann.admin', display_name: 'Ann' },
      { handle: 'ben.admin', display_name: 'Ben' },
    ]);
    assert.deepEqual(call.custodians, [
      { idp_id: 'idp-1', display_name: 'Cy' },
      { idp_id: 'idp-2', display_name: 'Di' },
    ]);
    assert.equal(call.tokenHashes.length, 2);
    // the buffers are overwritten after use, so the plain tokens are gone from memory; the secrets still hold them
    const tokens = [1, 2].map((s) => (f.secrets.live.get(s) as Buffer).toString('utf8'));
    for (const [i, t] of tokens.entries()) {
      assert.match(t, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(
        createHash('sha256')
          .update(t)
          .digest()
          .equals(call.tokenHashes[i] as Buffer),
      );
    }
    assert.notEqual(tokens[0], tokens[1]);
    const text = f.lines.join('\n');
    for (const t of tokens) assert.equal(text.includes(t), false, 'no token in any output line');
    for (const h of call.tokenHashes) {
      assert.equal(text.includes(h.toString('hex')), false, 'no hash (hex)');
      assert.equal(text.includes(h.toString('base64')), false, 'no hash (base64)');
      assert.equal(text.includes(h.toString('base64url')), false, 'no hash (base64url)');
    }
    const out = JSON.parse(f.lines[0] as string) as Record<string, unknown>;
    assert.equal(out['result'], 'ok');
    assert.equal(out['runId'], RUN);
    assert.deepEqual(out['enrollees'], [
      {
        slot: 1,
        principalId: P1,
        result: 'issued',
        tokenId: T1,
        secretArn: 'arn:aws:secretsmanager:eu-west-1:1:secret:bootstrap/staging/token/1',
      },
      {
        slot: 2,
        principalId: P2,
        result: 'issued',
        tokenId: T2,
        secretArn: 'arn:aws:secretsmanager:eu-west-1:1:secret:bootstrap/staging/token/2',
      },
    ]);
    assert.equal(
      f.secrets.live.size,
      2,
      'both secrets stay until expiry (the workflow deletes them)',
    );
  });

  test('a custodian who is an enrollee is passed as the enrollee slot', async () => {
    const f = setup({
      record: {
        ticketRef: 'CHG-1',
        enrollees: [
          { handle: 'ann.admin', displayName: 'Ann' },
          { handle: 'ben.admin', displayName: 'Ben' },
        ],
        custodians: [
          { idpId: 'idp-1', enrollee: 2 },
          { idpId: 'idp-2', enrollee: 1 },
        ],
        securityContactVerifiedAt: NOW.toISOString(),
        securityContactTestRef: 'T',
      },
    });
    assert.equal((await runBootstrapAdmins(f.deps)).exitCode, 0);
    assert.deepEqual((f.dbCalls[0] as BootstrapCallInput).custodians, [
      { idp_id: 'idp-1', enrollee: 2 },
      { idp_id: 'idp-2', enrollee: 1 },
    ]);
  });
});

describe('failures delete both secrets and end non-zero', () => {
  test('a failed or refused database call', async () => {
    for (const dbError of [
      new BootstrapRefusedError('latch_closed'),
      new Error('connection reset'),
    ]) {
      const f = setup({ dbError });
      const r = await runBootstrapAdmins(f.deps);
      assert.equal(r.exitCode, 1);
      assert.deepEqual(f.secrets.calls, ['create:1', 'create:2', 'delete:1', 'delete:2']);
      assert.equal(f.secrets.live.size, 0);
      assert.equal(
        f.lines.join('\n').includes('connection reset'),
        false,
        'no free-text error in the output',
      );
    }
  });
  test('a failed secret creation stops before the database call and deletes what exists', async () => {
    const f = setup();
    f.secrets.failCreate = 2;
    const r = await runBootstrapAdmins(f.deps);
    assert.equal(r.exitCode, 1);
    assert.deepEqual(f.dbCalls, []);
    assert.deepEqual(f.secrets.calls, ['create:1', 'create:2', 'delete:1', 'delete:2']);
  });
  test('a secret that cannot be deleted is named by ARN', async () => {
    const f = setup({ dbError: new BootstrapRefusedError('target_state') });
    f.secrets.failDelete.add(2);
    const r = await runBootstrapAdmins(f.deps);
    assert.equal(r.exitCode, 1);
    assert.ok('cleanupFailed' in r && r.cleanupFailed.length === 1);
    assert.match(
      String((r as { cleanupFailed: { secretArn: string }[] }).cleanupFailed[0]?.secretArn),
      /token\/2$/,
    );
  });
});

describe('reissue: an enrollee the function skipped', () => {
  const skipped = (extra: Record<string, unknown> = {}): unknown => ({
    mode: 'reissue',
    run_id: RUN,
    expires_at: '2026-11-09T12:30:00Z',
    enrollees: [
      { slot: 1, principal_id: P1, result: 'skipped', token_id: null, ...extra },
      { slot: 2, principal_id: P2, result: 'issued', token_id: T2 },
    ],
  });
  test('the skipped slot secret is force-deleted before any output; only the issued slot ARN is printed', async () => {
    const f = setup({ result: skipped() });
    const order: string[] = [];
    const out = f.deps.out;
    f.deps.out = (l) => {
      order.push(`out:${f.secrets.calls.filter((c) => c.startsWith('delete')).join(',')}`);
      out(l);
    };
    const r = await runBootstrapAdmins(f.deps);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(f.secrets.calls, ['create:1', 'create:2', 'delete:1']);
    assert.deepEqual(order, ['out:delete:1'], 'the deletion happened before the output');
    assert.equal(f.secrets.live.has(1), false);
    assert.equal(f.secrets.live.has(2), true);
    const text = f.lines.join('\n');
    assert.equal(text.includes('token/1'), false, 'the skipped slot ARN is not printed');
    assert.match(text, /token\/2/);
    const out1 = JSON.parse(f.lines[0] as string) as { enrollees: Record<string, unknown>[] };
    assert.deepEqual(out1.enrollees[0], {
      slot: 1,
      principalId: P1,
      result: 'skipped',
      secret: 'deleted',
    });
  });
  test('a failed deletion of the skipped secret exits non-zero naming it, with the slot as skipped', async () => {
    const f = setup({ result: skipped() });
    f.secrets.failDelete.add(1);
    const r = await runBootstrapAdmins(f.deps);
    assert.equal(r.exitCode, 1);
    const text = f.lines.join('\n');
    assert.match(text, /skipped_secret_not_deleted/);
    assert.match(text, /token\/1/);
    assert.doesNotMatch(text, /"result":"ok"/);
  });
  test('a skipped entry is honoured even when the function also returns a token_id (the command uses result, not token_id)', async () => {
    const f = setup({ result: skipped({ token_id: T1 }) });
    const r = await runBootstrapAdmins(f.deps);
    assert.equal(r.exitCode, 0);
    assert.ok(f.secrets.calls.includes('delete:1'));
    assert.equal(f.lines.join('\n').includes(T1), false);
  });
});

describe('a malformed function result fails closed (F02B-SEC-09 (a))', () => {
  const good = (): Record<string, unknown> => ({
    mode: 'create',
    run_id: RUN,
    expires_at: '2026-11-09T12:30:00Z',
    enrollees: [
      { slot: 1, principal_id: P1, result: 'issued', token_id: T1 },
      { slot: 2, principal_id: P2, result: 'issued', token_id: T2 },
    ],
  });
  const cases: [string, unknown][] = [
    ['one entry', { ...good(), enrollees: [(good()['enrollees'] as unknown[])[0]] }],
    [
      'a duplicated slot',
      {
        ...good(),
        enrollees: [
          { slot: 1, principal_id: P1, result: 'issued', token_id: T1 },
          { slot: 1, principal_id: P2, result: 'issued', token_id: T2 },
        ],
      },
    ],
    [
      'slots in the wrong order',
      {
        ...good(),
        enrollees: [
          { slot: 2, principal_id: P1, result: 'issued', token_id: T1 },
          { slot: 1, principal_id: P2, result: 'issued', token_id: T2 },
        ],
      },
    ],
    [
      'an unknown result',
      {
        ...good(),
        enrollees: [
          { slot: 1, principal_id: P1, result: 'reissued', token_id: T1 },
          { slot: 2, principal_id: P2, result: 'issued', token_id: T2 },
        ],
      },
    ],
    [
      'a missing result',
      {
        ...good(),
        enrollees: [
          { slot: 1, principal_id: P1, token_id: T1 },
          { slot: 2, principal_id: P2, result: 'issued', token_id: T2 },
        ],
      },
    ],
    [
      'a bad principal id',
      {
        ...good(),
        enrollees: [
          { slot: 1, principal_id: 'x', result: 'issued', token_id: T1 },
          { slot: 2, principal_id: P2, result: 'issued', token_id: T2 },
        ],
      },
    ],
    ['no enrollees', { mode: 'create', run_id: RUN, expires_at: 'x' }],
    ['null', null],
    ['a string', 'ok'],
  ];
  for (const [what, result] of cases)
    test(what, async () => {
      const f = setup({ result });
      const r = await runBootstrapAdmins(f.deps);
      assert.equal(r.exitCode, 1);
      assert.deepEqual(f.secrets.calls, ['create:1', 'create:2', 'delete:1', 'delete:2']);
      assert.equal(f.secrets.live.size, 0);
      assert.doesNotMatch(f.lines.join('\n'), /"result":"ok"/);
    });
});
