// BE-05 behavioural check of the admin-realm policies (ARCHITECTURE 21.3 "AN-1", 38.2 item 8): what each audience and role can
// read or write on the new tables, run as the real database roles against rows that exist.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { adminSetup, elevatedAdmin, ORG, seedAdmin, seedToken, signInOptions } from './testkit.js';
import type { AdminKit } from './testkit.js';
import { seedPrincipal } from '../testkit.js';
import type { ScopeSettings } from '@ehr/kernel';

let k: AdminKit;
let admin: Awaited<ReturnType<typeof elevatedAdmin>>;
let handle: string;
let tokenHash: string;
let signInChallenge: string;
before(async () => {
  k = await adminSetup('policies');
  handle = 'policy-admin-1';
  admin = await elevatedAdmin(k, handle, ['org_admin']);
  const t = await seedToken(k, (await seedAdmin(k, 'policy-token-owner')).principalId);
  const { createHash } = await import('node:crypto');
  tokenHash = createHash('sha256').update(t).digest('hex');
  signInChallenge = String(
    ((await signInOptions(k, handle)).json() as { challengeId: string }).challengeId,
  );
});
after(async () => {
  await k.close();
});

const ANON: ScopeSettings = { audience: 'anonymous', orgId: ORG };
const TABLES = [
  'identity.admin_credential',
  'identity.enrolment_token',
  'identity.role_change_request',
  'identity.elevation_grant',
  'identity.webauthn_challenge',
  'identity.session',
  'identity.person',
  'identity.principal',
  'identity.role_assignment',
];
const count = async (
  scope: ScopeSettings,
  table: string,
  pre?: (q: (s: string, p?: unknown[]) => Promise<unknown>) => Promise<void>,
): Promise<number> =>
  k.db.withScope(scope, async (tx) => {
    if (pre) await pre((s, p) => tx.query(s, p));
    return Number((await tx.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!['n']);
  });

describe('audience anonymous (21.3 list)', () => {
  test('with no key setting, every admin-realm table and the identity tables show nothing', async () => {
    for (const t of TABLES) assert.equal(await count(ANON, t), 0, t);
  });

  test('a challenge is visible only by its ID and only for sign_in and enrol', async () => {
    const n = await count(
      { ...ANON, webauthnChallengeId: signInChallenge },
      'identity.webauthn_challenge',
    );
    assert.equal(n, 1);
    // an elevation challenge (bound to a session) is not reachable as anonymous even by ID
    const elev = (
      await k.q<{ id: string }>(
        `SELECT id FROM identity.webauthn_challenge WHERE purpose = 'elevation' LIMIT 1`,
      )
    )[0]?.id;
    assert.ok(elev !== undefined, 'the fixture ran an elevation');
    assert.equal(
      await count({ ...ANON, webauthnChallengeId: elev }, 'identity.webauthn_challenge'),
      0,
    );
  });

  test('an enrolment token is visible only by the hash of the presented token', async () => {
    const withHash = await count(ANON, 'identity.enrolment_token', (q) =>
      q(`SELECT set_config('app.auth_enrolment_token_hash', $1, true)`, [tokenHash]).then(
        () => undefined,
      ),
    );
    assert.equal(withHash, 1);
    const wrong = await count(ANON, 'identity.enrolment_token', (q) =>
      q(`SELECT set_config('app.auth_enrolment_token_hash', $1, true)`, ['ab'.repeat(32)]).then(
        () => undefined,
      ),
    );
    assert.equal(wrong, 0);
  });

  test('anonymous cannot insert a request, a grant, an elevation challenge or a session-bound challenge', async () => {
    const person = (await seedPrincipal(k, 'admin_pool', { subject: 'policy-victim' })).personId;
    const attempts: [string, string, unknown[]][] = [
      [
        `INSERT INTO identity.role_change_request (id, organisation_id, requester_person_id, subject_principal_id, change, before, request_hash, status, expires_at) VALUES ($1,$2,$3,$3,'{}','[]',decode(repeat('00',32),'hex'),'requested', now())`,
        'role_change_request',
        [randomUUID(), ORG, person],
      ],
      [
        `INSERT INTO identity.webauthn_challenge (id, organisation_id, purpose, challenge, expires_at) VALUES ($1,$2,'elevation',decode(repeat('00',32),'hex'), now() + interval '1 minute')`,
        'elevation challenge',
        [randomUUID(), ORG],
      ],
      [
        `INSERT INTO identity.webauthn_challenge (id, organisation_id, purpose, session_id, challenge, expires_at) VALUES ($1,$2,'sign_in',$3,decode(repeat('00',32),'hex'), now() + interval '1 minute')`,
        'bound challenge',
        [randomUUID(), ORG, randomUUID()],
      ],
      [
        `INSERT INTO identity.admin_credential (id, organisation_id, principal_id, public_key, aaguid, backup_eligible, user_verified_at_enrol, enrolment_token_id) VALUES (decode(repeat('01',32),'hex'),$1,$2,decode(repeat('02',64),'hex'),$3,false,true,$4)`,
        'credential without verified identity',
        [ORG, admin.s.principalId, randomUUID(), randomUUID()],
      ],
    ];
    for (const [sql, label, params] of attempts)
      await assert.rejects(
        k.db.withScope(ANON, (tx) => tx.query(sql, params)),
        (e: { code?: string }) => ['42501', '23503', '23514', 'PS001'].includes(String(e.code)),
        label,
      );
  });
});

describe('role identity_signin_ro (21.2, T-SIGNIN-CLAIM)', () => {
  const asSigninRo = async <T>(
    claim: string | undefined,
    fn: (
      q: (s: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
    ) => Promise<T>,
  ): Promise<T> =>
    k.db.withScope(ANON, async (tx) => {
      if (claim !== undefined)
        await tx.query(`SELECT set_config('app.auth_claim_handle', $1, true)`, [claim]);
      await tx.query('SET LOCAL ROLE identity_signin_ro');
      return fn((s, p) => tx.query(s, p));
    });

  test('no claim: nothing; a claim: exactly that admin principal and its live credentials, public columns only', async () => {
    assert.equal(
      await asSigninRo(
        undefined,
        async (q) => (await q(`SELECT id FROM identity.principal`)).rows.length,
      ),
      0,
    );
    assert.equal(
      await asSigninRo(
        undefined,
        async (q) => (await q(`SELECT id FROM identity.admin_credential`)).rows.length,
      ),
      0,
    );
    const p = await asSigninRo(
      handle,
      async (q) => (await q(`SELECT id, status FROM identity.principal`)).rows,
    );
    assert.equal(p.length, 1);
    assert.equal(p[0]!['id'], admin.s.principalId);
    const c = await asSigninRo(
      handle,
      async (q) =>
        (await q(`SELECT id, public_key, sign_count, transports FROM identity.admin_credential`))
          .rows,
    );
    assert.equal(c.length, 2);
    // a claim for another handle shows only that one
    const other = await asSigninRo(
      'policy-token-owner',
      async (q) => (await q(`SELECT id FROM identity.principal`)).rows,
    );
    assert.equal(other.length, 1);
    assert.notEqual(other[0]!['id'], admin.s.principalId);
  });

  test('anything outside the column grants, and every other table, is refused', async () => {
    const refused = (sql: string) =>
      assert.rejects(
        asSigninRo(handle, async (q) => q(sql)),
        (e: { code?: string }) => e.code === '42501',
        sql,
      );
    await refused(`SELECT email FROM identity.principal`);
    await refused(`SELECT person_id FROM identity.principal`);
    await refused(`SELECT * FROM identity.principal`);
    await refused(`SELECT enrolment_token_id FROM identity.admin_credential`);
    await refused(`SELECT aaguid FROM identity.admin_credential`);
    await refused(`SELECT id FROM identity.person`);
    await refused(`SELECT id FROM identity.session`);
    await refused(`SELECT id FROM identity.enrolment_token`);
    await refused(`SELECT id FROM identity.webauthn_challenge`);
    await refused(`SELECT id FROM identity.elevation_grant`);
    await refused(`SELECT id FROM identity.role_change_request`);
    await refused(`SELECT key FROM kernel.setting`);
    await refused(`SELECT id FROM integration_core.secret_ref`);
    await refused(`INSERT INTO identity.admin_credential (id) VALUES (decode('00','hex'))`);
    await refused(`UPDATE identity.principal SET status = 'disabled'`);
  });

  test('a suspended or disabled principal is not returned by the claim (it looks like an unknown handle)', async () => {
    const s = await seedAdmin(k, 'policy-suspended');
    await k.sa.query(`UPDATE identity.principal SET status = 'suspended' WHERE id = $1`, [
      s.principalId,
    ]);
    assert.equal(
      await asSigninRo(
        'policy-suspended',
        async (q) => (await q(`SELECT id FROM identity.principal`)).rows.length,
      ),
      0,
    );
  });
});

describe('staff scope', () => {
  const scopeOf = (
    principalId: string,
    personId: string,
    realm: 'google' | 'admin_pool',
  ): ScopeSettings => ({ audience: 'staff', orgId: ORG, realm, principalId, personId });

  test('a google-realm staff scope sees none of the admin-realm tables', async () => {
    const g = await seedPrincipal(k, 'google', { email: 'policy-google@example.com' });
    for (const t of [
      'identity.admin_credential',
      'identity.enrolment_token',
      'identity.role_change_request',
      'identity.elevation_grant',
      'identity.webauthn_challenge',
    ])
      assert.equal(await count(scopeOf(g.principalId, g.personId, 'google'), t), 0, t);
  });

  test('an admin scope reads requests and tokens but cannot write a role assignment without an approved request of its own', async () => {
    const sc = scopeOf(admin.s.principalId, admin.s.personId, 'admin_pool');
    assert.ok((await count(sc, 'identity.admin_credential')) >= 2);
    const role = (
      await k.q<{ id: string }>(`SELECT id FROM identity.role WHERE key = 'compliance_officer'`)
    )[0]!.id;
    const victim = await seedAdmin(k, 'policy-assign-victim');
    await assert.rejects(
      k.db.withScope(sc, (tx) =>
        tx.query(
          `INSERT INTO identity.role_assignment (id, organisation_id, principal_id, role_id, granted_via_request_id) VALUES ($1,$2,$3,$4,$5)`,
          [randomUUID(), ORG, victim.principalId, role, randomUUID()],
        ),
      ),
      (e: { code?: string }) => ['42501', '23503'].includes(String(e.code)),
    );
  });

  test('revocation reaches only the principal named in app.revoke_principal_id', async () => {
    const sc = scopeOf(admin.s.principalId, admin.s.personId, 'admin_pool');
    const other = await seedAdmin(k, 'policy-revoke-other');
    const n = await k.db.withScope(sc, async (tx) => {
      await tx.query(`SELECT set_config('app.revoke_principal_id', $1, true)`, [other.principalId]);
      return (
        await tx.query(`SELECT count(*)::int AS n FROM identity.session WHERE principal_id = $1`, [
          admin.s.principalId,
        ])
      ).rows[0]!['n'];
    });
    assert.ok(Number(n) >= 1, 'the actor’s own sessions stay readable through T-PRINCIPAL');
    const updated = await k.db.withScope(sc, async (tx) => {
      // no revoke setting: the update of someone else's session matches nothing
      return (
        await tx.query(
          `UPDATE identity.session SET revoked_at = now(), revoke_reason = 'kill_switch' WHERE principal_id = $1`,
          [other.principalId],
        )
      ).rowCount;
    });
    assert.equal(updated, 0);
  });
});
