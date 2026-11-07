// BE-05 real-database tests of the B2 ceremonies (ARCHITECTURE 26.1, 26.3, 38.2 item 8): the real migrations, the real
// policies, the real Nest application and the pinned WebAuthn library, with a software authenticator that makes real
// signatures. Run: EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/identity/admin/ceremony.dbtest.js
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  AAGUID_OK,
  adminSetup,
  elevate,
  enrol,
  ORIGIN,
  post,
  queuedJobs,
  seedAdmin,
  seedToken,
  signIn,
  signInOptions,
  SoftKey,
  getAdmin,
  now,
  clock,
} from './testkit.js';
import type { AdminKit } from './testkit.js';
import { STAFF_HOST } from '../testkit.js';

let k: AdminKit;
before(async () => {
  k = await adminSetup('ceremony');
});
after(async () => {
  await k.close();
});

const opts = (j: { publicKey: { challenge: string } }) => j.publicKey;
const REQUEST_CODE = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];
let seq = 0;
const handleOf = (p: string): string => `${p}${++seq}`;

async function enrolled(handle: string, roles: string[] = []) {
  const s = await seedAdmin(k, handle, roles);
  const key = new SoftKey();
  const token = await seedToken(k, s.principalId);
  const session = await enrol(k, handle, s.principalId, token, key);
  return { s, key, token, session };
}

describe('enrolment (26.3, B2-3)', () => {
  test('a key registered with an approved token creates credential, session and the notice jobs', async () => {
    const h = handleOf('enrol-ok');
    const { s, session } = await enrolled(h);
    const cred = await k.q(
      `SELECT backup_eligible, user_verified_at_enrol, sign_count, revoked_at, aaguid FROM identity.admin_credential WHERE principal_id = $1`,
      [s.principalId],
    );
    assert.equal(cred.length, 1);
    assert.deepEqual(
      [
        cred[0]!['backup_eligible'],
        cred[0]!['user_verified_at_enrol'],
        Number(cred[0]!['sign_count']),
        cred[0]!['revoked_at'],
        cred[0]!['aaguid'],
      ],
      [false, true, 0, null, AAGUID_OK],
    );
    const sess = await k.q(
      `SELECT realm, audience, amr FROM identity.session WHERE principal_id = $1`,
      [s.principalId],
    );
    assert.deepEqual(
      [sess[0]!['realm'], sess[0]!['audience'], sess[0]!['amr']],
      ['admin_pool', 'staff', ['hwk', 'enrol']],
    );
    assert.match(
      session.setCookies.join(';'),
      /__Host-sid=[^;]+; Max-Age=\d+; Path=\/; Secure; HttpOnly; SameSite=Strict/,
    );
    const events = await queuedJobs(
      k,
      'identity.admin_event',
      `j.payload->>'kind' = 'credential_enrolled'`,
    );
    assert.ok(events.some((e) => e['principalId'] === s.principalId));
    const signins = await queuedJobs(
      k,
      'identity.record_sign_in',
      `j.payload->>'principalId' = $2`,
      [s.principalId],
    );
    assert.equal(signins.length, 1);
  });

  test('an unknown handle, a wrong token, a token of another principal and malformed input all give the same 401', async () => {
    const a = await seedAdmin(k, handleOf('tok-a'));
    const b = await seedAdmin(k, handleOf('tok-b'));
    const tokenA = await seedToken(k, a.principalId);
    const bHandle = (
      await k.q<{ subject: string }>(`SELECT subject FROM identity.principal WHERE id = $1`, [
        b.principalId,
      ])
    )[0]!.subject;
    const aHandle = (
      await k.q<{ subject: string }>(`SELECT subject FROM identity.principal WHERE id = $1`, [
        a.principalId,
      ])
    )[0]!.subject;
    const bodies = [
      { handle: 'nobody-here', token: tokenA },
      { handle: aHandle, token: 'x'.repeat(43) },
      { handle: bHandle, token: tokenA },
      { handle: 'AB', token: tokenA },
      { handle: aHandle },
      {},
    ];
    for (const body of bodies) {
      const r = await post(k, '/auth/enrolment/options', body);
      assert.equal(r.status, 401, JSON.stringify(body));
      assert.equal(REQUEST_CODE(r), 'identity.enrolment_failed');
    }
  });

  test('an expired token and a used token are refused', async () => {
    const s = await seedAdmin(k, handleOf('tok-exp'));
    const h = (
      await k.q<{ subject: string }>(`SELECT subject FROM identity.principal WHERE id = $1`, [
        s.principalId,
      ])
    )[0]!.subject;
    const expired = await seedToken(k, s.principalId, { minutes: 30 });
    clock.t += 31 * 60_000;
    try {
      const r = await post(k, '/auth/enrolment/options', { handle: h, token: expired });
      assert.equal(r.status, 401);
      assert.equal(REQUEST_CODE(r), 'identity.enrolment_failed');
    } finally {
      clock.t -= 31 * 60_000;
    }
    const usedToken = await seedToken(k, s.principalId, { status: 'used' });
    const used = await post(k, '/auth/enrolment/options', { handle: h, token: usedToken });
    assert.equal(used.status, 401);
    assert.equal(REQUEST_CODE(used), 'identity.enrolment_failed');
    // Spend a real token with two keys; the third use is refused.
    const token = await seedToken(k, s.principalId);
    await enrol(k, h, s.principalId, token, new SoftKey());
    await enrol(k, h, s.principalId, token, new SoftKey());
    const row = await k.q(
      `SELECT status, used_at FROM identity.enrolment_token WHERE principal_id = $1 AND status = 'used'`,
      [s.principalId],
    );
    assert.equal(row.length, 2, 'the seeded used token and the one the two keys spent');
    const third = await post(k, '/auth/enrolment/options', { handle: h, token });
    assert.equal(third.status, 401);
  });

  test('concurrent verifies on one token register at most two credentials (BE05-R1-F04)', async () => {
    const h = handleOf('enrol-race');
    const s = await seedAdmin(k, h);
    const token = await seedToken(k, s.principalId);
    const opts = [];
    for (let i = 0; i < 4; i++) {
      const o = await post(k, '/auth/enrolment/options', { handle: h, token });
      assert.equal(o.status, 200);
      opts.push(o.json() as { challengeId: string; publicKey: { challenge: string } });
    }
    const results = await Promise.all(
      opts.map((j) =>
        post(k, '/auth/enrolment/verify', {
          challengeId: j.challengeId,
          handle: h,
          token,
          attestation: new SoftKey().create(j.publicKey, {
            origin: ORIGIN,
            rpId: STAFF_HOST,
            aaguid: AAGUID_OK,
          }),
        }),
      ),
    );
    const n = await k.q(`SELECT 1 FROM identity.admin_credential WHERE principal_id = $1`, [
      s.principalId,
    ]);
    assert.equal(n.length, 2, 'exactly two keys');
    assert.equal(results.filter((r) => r.status === 200).length, 2);
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 401));
  });

  test('an AAGUID that is not on the list, a BE or BS credential and a missing UV flag are refused', async () => {
    const cases: [string, { aaguid?: string; be?: boolean; bs?: boolean; uv?: boolean }][] = [
      ['aaguid', { aaguid: '11111111-2222-3333-4444-555555555555' }],
      ['be', { be: true }],
      ['bs', { be: true, bs: true }],
      ['uv', { uv: false }],
    ];
    for (const [name, o] of cases) {
      const h = handleOf(`bad-${name}-`);
      const s = await seedAdmin(k, h);
      const token = await seedToken(k, s.principalId);
      await assert.rejects(
        enrol(k, h, s.principalId, token, new SoftKey(), o),
        /no session: 401/,
        name,
      );
      const n = await k.q(`SELECT 1 FROM identity.admin_credential WHERE principal_id = $1`, [
        s.principalId,
      ]);
      assert.equal(n.length, 0, name);
    }
  });

  test('a replayed challenge and a challenge signed for another origin or RP ID do not enrol', async () => {
    const h = handleOf('enrol-replay');
    const s = await seedAdmin(k, h);
    const token = await seedToken(k, s.principalId);
    const opt = await post(k, '/auth/enrolment/options', { handle: h, token });
    const j = opt.json() as { challengeId: string; publicKey: { challenge: string } };
    const key = new SoftKey();
    for (const bad of [
      { origin: 'https://evil.example', rpId: STAFF_HOST },
      { origin: ORIGIN, rpId: 'example.test' },
    ]) {
      const att = key.create(opts(j), { ...bad, aaguid: AAGUID_OK });
      const r = await post(k, '/auth/enrolment/verify', {
        challengeId: j.challengeId,
        handle: h,
        token,
        attestation: att,
      });
      assert.equal(r.status, 401);
      // One attempt per challenge, including a failed one (B2-5): the right attestation on the burnt challenge is refused too.
      const good = await post(k, '/auth/enrolment/verify', {
        challengeId: j.challengeId,
        handle: h,
        token,
        attestation: key.create(opts(j), { origin: ORIGIN, rpId: STAFF_HOST, aaguid: AAGUID_OK }),
      });
      assert.equal(good.status, 401);
      break;
    }
    assert.equal(
      (
        await k.q(`SELECT 1 FROM identity.admin_credential WHERE principal_id = $1`, [
          s.principalId,
        ])
      ).length,
      0,
    );
  });
});

describe('sign-in (26.1, B2-2, B2-4, B2-5)', () => {
  test('options answer a real and an unknown handle with the same shape, and the decoy list is stable', async () => {
    const h = handleOf('signin-shape');
    const { key } = await enrolled(h);
    void key;
    const real = (await signInOptions(k, h)).json() as {
      challengeId: string;
      publicKey: Record<string, unknown>;
    };
    const unknown1 = (await signInOptions(k, 'no-such-handle-1')).json() as typeof real;
    const unknown2 = (await signInOptions(k, 'no-such-handle-1')).json() as typeof real;
    const shape = (o: typeof real): string[] => [
      Object.keys(o).sort().join(),
      Object.keys(o.publicKey).sort().join(),
    ];
    assert.deepEqual(shape(real), shape(unknown1));
    const allow = (o: typeof real) =>
      o.publicKey['allowCredentials'] as { id: string; type: string; transports: string[] }[];
    assert.ok(allow(unknown1).length === 1 || allow(unknown1).length === 2);
    assert.deepEqual(allow(unknown1), allow(unknown2), 'decoy IDs are stable on repeat');
    assert.notDeepEqual(allow(unknown1), allow(real));
    assert.equal(real.publicKey['userVerification'], 'required');
    assert.equal(real.publicKey['rpId'], STAFF_HOST);
    for (const o of [real, unknown1])
      assert.equal(Buffer.from(o.publicKey['challenge'] as string, 'base64url').length, 32);
    // a real challenge row exists for the unknown handle, with no principal
    const rows = await k.q(`SELECT principal_id FROM identity.webauthn_challenge WHERE id = $1`, [
      unknown1.challengeId,
    ]);
    assert.equal(rows[0]!['principal_id'], null);
  });

  test('a suspended handle, a handle with no live credential and a disabled handle look like an unknown one', async () => {
    const suspended = handleOf('susp');
    const s = await seedAdmin(k, suspended);
    const key = new SoftKey();
    await enrol(k, suspended, s.principalId, await seedToken(k, s.principalId), key);
    await k.sa.query(`UPDATE identity.principal SET status = 'suspended' WHERE id = $1`, [
      s.principalId,
    ]);
    const a = (await signInOptions(k, suspended)).json() as {
      publicKey: { allowCredentials: { id: string }[] };
    };
    const decoy = (await signInOptions(k, suspended)).json() as typeof a;
    assert.deepEqual(a.publicKey.allowCredentials, decoy.publicKey.allowCredentials);
    const real = Buffer.from(key.id, 'base64url');
    assert.ok(a.publicKey.allowCredentials.every((c) => c.id !== real.toString('base64url')));
    const bare = handleOf('bare');
    await seedAdmin(k, bare);
    const none = (await signInOptions(k, bare)).json() as typeof a;
    assert.ok(none.publicKey.allowCredentials.length >= 1);
  });

  test('a good assertion signs in; the same assertion again, a wrong origin, a wrong RP ID and a missing UV flag are refused with one code', async () => {
    const h = handleOf('signin-good');
    const { s, key } = await enrolled(h);
    const attempt = async (o: Parameters<SoftKey['assert']>[1]) => {
      const opt = (await signInOptions(k, h)).json() as {
        challengeId: string;
        publicKey: { challenge: string };
      };
      const assertion = key.assert(opt.publicKey, o);
      return {
        opt,
        assertion,
        r: await post(k, '/auth/sign-in/verify', {
          challengeId: opt.challengeId,
          handle: h,
          assertion,
        }),
      };
    };
    for (const bad of [
      { origin: 'https://evil.example', rpId: STAFF_HOST },
      { origin: ORIGIN, rpId: 'example.test' },
      { origin: ORIGIN, rpId: STAFF_HOST, uv: false },
      { origin: ORIGIN, rpId: STAFF_HOST, challenge: Buffer.alloc(32, 1).toString('base64url') },
    ]) {
      const { r } = await attempt(bad);
      assert.equal(r.status, 401, JSON.stringify(bad));
      assert.equal(REQUEST_CODE(r), 'identity.sign_in_failed');
    }
    const ok = await attempt({ origin: ORIGIN, rpId: STAFF_HOST });
    assert.equal(ok.r.status, 200, ok.r.body);
    const body = ok.r.json();
    assert.equal(body['principalId'], s.principalId);
    // replay: the challenge is single use
    const replay = await post(k, '/auth/sign-in/verify', {
      challengeId: ok.opt.challengeId,
      handle: h,
      assertion: ok.assertion,
    });
    assert.equal(replay.status, 401);
    assert.equal(REQUEST_CODE(replay), 'identity.sign_in_failed');
    const c = await k.q(
      `SELECT sign_count, last_used_at FROM identity.webauthn_challenge w, identity.admin_credential c WHERE w.id = $1 AND c.principal_id = $2`,
      [ok.opt.challengeId, s.principalId],
    );
    assert.ok(Number(c[0]!['sign_count']) >= 1 && c[0]!['last_used_at'] !== null);
  });

  test('a counter regression revokes the credential and queues the alert; the next sign-in with that key fails', async () => {
    const h = handleOf('signin-regress');
    const { s, key } = await enrolled(h);
    const go = async (counter: number) => {
      const opt = (await signInOptions(k, h)).json() as {
        challengeId: string;
        publicKey: { challenge: string };
      };
      return post(k, '/auth/sign-in/verify', {
        challengeId: opt.challengeId,
        handle: h,
        assertion: key.assert(opt.publicKey, { origin: ORIGIN, rpId: STAFF_HOST, counter }),
      });
    };
    assert.equal((await go(5)).status, 200);
    const lower = await go(3);
    assert.equal(lower.status, 401);
    const cred = await k.q(
      `SELECT revoked_at, revoke_reason, sign_count FROM identity.admin_credential WHERE principal_id = $1`,
      [s.principalId],
    );
    assert.equal(cred[0]!['revoke_reason'], 'counter_regression');
    assert.equal(Number(cred[0]!['sign_count']), 5);
    const ev = await queuedJobs(
      k,
      'identity.admin_event',
      `j.payload->>'kind' = 'counter_regression' AND j.payload->>'principalId' = $2`,
      [s.principalId],
    );
    assert.equal(ev.length, 1);
    assert.equal((await go(9)).status, 401, 'a revoked credential no longer signs in');
    // equal counter is a regression too
  });

  test('two concurrent presentations of one assertion: one session, no false revocation', async () => {
    const h = handleOf('signin-race');
    const { s, key } = await enrolled(h);
    const opt = (await signInOptions(k, h)).json() as {
      challengeId: string;
      publicKey: { challenge: string };
    };
    const assertion = key.assert(opt.publicKey, { origin: ORIGIN, rpId: STAFF_HOST, counter: 7 });
    const rs = await Promise.all(
      [1, 2].map(() =>
        post(k, '/auth/sign-in/verify', { challengeId: opt.challengeId, handle: h, assertion }),
      ),
    );
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 401]);
    const cred = await k.q(
      `SELECT revoked_at FROM identity.admin_credential WHERE principal_id = $1`,
      [s.principalId],
    );
    assert.equal(cred[0]!['revoked_at'], null);
    const sessions = await k.q(
      `SELECT 1 FROM identity.session WHERE principal_id = $1 AND amr = '{hwk}'`,
      [s.principalId],
    );
    assert.equal(sessions.length, 1);
  });

  test('an assertion made with a credential of another principal is refused', async () => {
    const a = handleOf('xp-a');
    const b = handleOf('xp-b');
    await enrolled(a);
    const { key: keyB } = await enrolled(b);
    const opt = (await signInOptions(k, a)).json() as {
      challengeId: string;
      publicKey: { challenge: string };
    };
    const r = await post(k, '/auth/sign-in/verify', {
      challengeId: opt.challengeId,
      handle: a,
      assertion: keyB.assert(opt.publicKey, { origin: ORIGIN, rpId: STAFF_HOST }),
    });
    assert.equal(r.status, 401);
    // and the challenge issued for handle A cannot be used with handle B's own key and handle
    const opt2 = (await signInOptions(k, a)).json() as {
      challengeId: string;
      publicKey: { challenge: string };
    };
    const r2 = await post(k, '/auth/sign-in/verify', {
      challengeId: opt2.challengeId,
      handle: b,
      assertion: keyB.assert(opt2.publicKey, { origin: ORIGIN, rpId: STAFF_HOST }),
    });
    assert.equal(r2.status, 401);
  });

  test('a disabled principal cannot sign in; an unknown handle fails like a wrong key', async () => {
    const h = handleOf('signin-disabled');
    const { s, key } = await enrolled(h);
    await k.sa.query(`UPDATE identity.principal SET status = 'disabled' WHERE id = $1`, [
      s.principalId,
    ]);
    const opt = (await signInOptions(k, h)).json() as {
      challengeId: string;
      publicKey: { challenge: string };
    };
    const r = await post(k, '/auth/sign-in/verify', {
      challengeId: opt.challengeId,
      handle: h,
      assertion: key.assert(opt.publicKey, { origin: ORIGIN, rpId: STAFF_HOST }),
    });
    assert.equal(r.status, 401);
    assert.equal(REQUEST_CODE(r), 'identity.sign_in_failed');
    const u = await post(k, '/auth/sign-in/verify', {
      challengeId: opt.challengeId,
      handle: 'ghost-handle',
      assertion: key.assert(opt.publicKey, { origin: ORIGIN, rpId: STAFF_HOST }),
    });
    assert.equal(u.status, 401);
    assert.equal(REQUEST_CODE(u), 'identity.sign_in_failed');
  });
});

describe('rate limits (31.3)', () => {
  test('the options counter refuses the 31st call from one address before any identity read, and 429 carries Retry-After data', async () => {
    const ip = '192.0.2.77';
    const h = handleOf('rl-opt');
    await enrolled(h);
    let last = 0;
    for (let i = 1; i <= 31; i++) last = (await signInOptions(k, h, ip)).status;
    assert.equal(last, 429);
    const before = (await k.q(`SELECT count(*)::int AS n FROM identity.webauthn_challenge`))[0]![
      'n'
    ] as number;
    const again = await signInOptions(k, h, ip);
    assert.equal(again.status, 429);
    assert.equal(again.json()['code'], 'kernel.rate_limited');
    assert.equal(
      (await k.q(`SELECT count(*)::int AS n FROM identity.webauthn_challenge`))[0]!['n'],
      before,
      'no challenge inserted at the limit',
    );
  });

  test('the failure counter refuses at 50 failures before verification, and a success never counts', async () => {
    const ip = '192.0.2.78';
    const h = handleOf('rl-fail');
    const { key } = await enrolled(h);
    for (let i = 0; i < 50; i++) {
      const r = await post(
        k,
        '/auth/sign-in/verify',
        { challengeId: '00000000-0000-4000-8000-000000000000', handle: h, assertion: {} },
        { ip },
      );
      assert.equal(r.status, 401, `failure ${i + 1}`);
    }
    const opt = (await signInOptions(k, h, '192.0.2.79')).json() as {
      challengeId: string;
      publicKey: { challenge: string };
    };
    const refused = await post(
      k,
      '/auth/sign-in/verify',
      {
        challengeId: opt.challengeId,
        handle: h,
        assertion: key.assert(opt.publicKey, { origin: ORIGIN, rpId: STAFF_HOST }),
      },
      { ip },
    );
    assert.equal(refused.status, 429);
    // the challenge was not consumed by the refused request; another address can still use it
    const ok = await post(
      k,
      '/auth/sign-in/verify',
      {
        challengeId: opt.challengeId,
        handle: h,
        assertion: key.assert(opt.publicKey, { origin: ORIGIN, rpId: STAFF_HOST, counter: 20 }),
      },
      { ip: '192.0.2.80' },
    );
    assert.equal(ok.status, 200, ok.body);
  });
});

describe('elevation (26.3, C1)', () => {
  test('a privileged route is refused without a grant, allowed with one, refused again when it is stale', async () => {
    const h = handleOf('elev');
    const s = await seedAdmin(k, h, ['org_admin']);
    const key = new SoftKey();
    const key2 = new SoftKey();
    const token = await seedToken(k, s.principalId);
    await enrol(k, h, s.principalId, token, key);
    await enrol(k, h, s.principalId, token, key2);
    const signed = await signIn(k, h, s.principalId, key);
    const denied = await getAdmin(k, '/principals', signed.cookie);
    assert.equal(denied.status, 200, 'identity.principal.read is not an elevation permission');
    const kill = await post(
      k,
      `/principals/${s.principalId}/kill-switch`,
      { reason: 'test only' },
      { cookie: signed.cookie, csrf: signed.csrf },
    );
    assert.equal(kill.status, 403);
    assert.equal(REQUEST_CODE(kill), 'identity.elevation_required');
    const { resp, session } = await elevate(k, signed, key);
    assert.equal(resp.status, 200, resp.body);
    assert.ok(
      Date.parse(String(resp.json()['elevationExpiresAt'])) - now().getTime() === 15 * 60_000,
    );
    assert.notEqual(session.cookie, signed.cookie, 'the token is rotated at elevation');
    const old = await getAdmin(k, '/principals', signed.cookie);
    assert.equal(old.status, 401, 'the old token no longer works');
    // elevated: the privileged action passes the guard (and then fails on its own validation, not on the guard)
    const elevated = await post(
      k,
      `/principals/not-a-uuid/kill-switch`,
      { reason: 'test only' },
      { cookie: session.cookie, csrf: session.csrf },
    );
    assert.equal(elevated.status, 404);
    // stale: keep the session alive with interactive requests (10 minutes idle) while the 15-minute grant runs out
    const still = async () =>
      (
        await post(
          k,
          '/principals/00000000-0000-4000-8000-000000000001/kill-switch',
          { reason: 'test only' },
          { cookie: session.cookie, csrf: session.csrf },
        )
      ).status;
    const t0 = clock.t;
    try {
      for (const minutes of [5, 10, 14]) {
        clock.t = t0 + minutes * 60_000;
        assert.equal(await still(), 404, `still elevated after ${minutes} minutes`);
      }
      clock.t = t0 + 15 * 60_000 + 1000;
      const stale = await post(
        k,
        `/principals/${s.principalId}/kill-switch`,
        { reason: 'test only' },
        { cookie: session.cookie, csrf: session.csrf },
      );
      assert.equal(stale.status, 403);
      assert.equal(REQUEST_CODE(stale), 'identity.elevation_required');
    } finally {
      clock.t = t0;
    }
  });

  test('a grant dies with its credential: revoking the key makes a live grant stale at once', async () => {
    const h = handleOf('elev-cred');
    const s = await seedAdmin(k, h, ['org_admin']);
    const key = new SoftKey();
    const token = await seedToken(k, s.principalId);
    await enrol(k, h, s.principalId, token, key);
    await enrol(k, h, s.principalId, token, new SoftKey());
    const { resp, session } = await elevate(k, await signIn(k, h, s.principalId, key), key);
    assert.equal(resp.status, 200);
    const probe = () =>
      post(
        k,
        '/principals/00000000-0000-4000-8000-000000000001/kill-switch',
        { reason: 'test only' },
        { cookie: session.cookie, csrf: session.csrf },
      );
    assert.equal((await probe()).status, 404);
    await k.sa.query(
      `UPDATE identity.admin_credential SET revoked_at = now(), revoke_reason = 'admin_revoked' WHERE id = $1`,
      [key.credentialId],
    );
    const r = await probe();
    assert.equal(r.status, 403);
    assert.equal(REQUEST_CODE(r), 'identity.elevation_required');
  });

  test('B2-8: with one live key only the enrolment session can elevate; a later sign-in cannot', async () => {
    const h = handleOf('elev-onekey');
    const s = await seedAdmin(k, h, ['org_admin']);
    const key = new SoftKey();
    const enrolSession = await enrol(k, h, s.principalId, await seedToken(k, s.principalId), key);
    const ok = await elevate(k, enrolSession, key);
    assert.equal(ok.resp.status, 200, ok.resp.body);
    const later = await signIn(k, h, s.principalId, key);
    const refused = await elevate(k, later, key);
    assert.equal(refused.resp.status, 401);
    assert.equal(REQUEST_CODE(refused.resp), 'identity.elevation_failed');
  });

  test('an elevation challenge belongs to its session and is single use; a replayed or wrong-origin assertion is refused', async () => {
    const h = handleOf('elev-bind');
    const s = await seedAdmin(k, h, ['org_admin']);
    const key = new SoftKey();
    const token = await seedToken(k, s.principalId);
    await enrol(k, h, s.principalId, token, key);
    await enrol(k, h, s.principalId, token, new SoftKey());
    const one = await signIn(k, h, s.principalId, key);
    const two = await signIn(k, h, s.principalId, key);
    const o1 = (
      await post(k, '/auth/elevation/options', {}, { cookie: one.cookie, csrf: one.csrf })
    ).json() as { challengeId: string; publicKey: { challenge: string } };
    // session two presents session one's challenge
    const stolen = await post(
      k,
      '/auth/elevation/verify',
      {
        challengeId: o1.challengeId,
        assertion: key.assert(o1.publicKey, { origin: ORIGIN, rpId: STAFF_HOST }),
      },
      { cookie: two.cookie, csrf: two.csrf },
    );
    assert.equal(stolen.status, 401);
    // and the challenge was burnt by that attempt? It belongs to session one: the row is unreadable to session two, so it stays usable by its owner.
    const wrongOrigin = await post(
      k,
      '/auth/elevation/verify',
      {
        challengeId: o1.challengeId,
        assertion: key.assert(o1.publicKey, { origin: 'https://evil.example', rpId: STAFF_HOST }),
      },
      { cookie: one.cookie, csrf: one.csrf },
    );
    assert.equal(wrongOrigin.status, 401);
    const burnt = await post(
      k,
      '/auth/elevation/verify',
      {
        challengeId: o1.challengeId,
        assertion: key.assert(o1.publicKey, { origin: ORIGIN, rpId: STAFF_HOST }),
      },
      { cookie: one.cookie, csrf: one.csrf },
    );
    assert.equal(burnt.status, 401, 'one attempt per challenge, including a failed one');
    const o2 = (
      await post(k, '/auth/elevation/options', {}, { cookie: one.cookie, csrf: one.csrf })
    ).json() as typeof o1;
    const good = await post(
      k,
      '/auth/elevation/verify',
      {
        challengeId: o2.challengeId,
        assertion: key.assert(o2.publicKey, { origin: ORIGIN, rpId: STAFF_HOST }),
      },
      { cookie: one.cookie, csrf: one.csrf },
    );
    assert.equal(good.status, 200, good.body);
    const grants = await k.q(
      `SELECT count(*)::int AS n FROM identity.elevation_grant WHERE session_id IN (SELECT id FROM identity.session WHERE principal_id = $1)`,
      [s.principalId],
    );
    assert.equal(grants[0]!['n'], 1);
  });
});
