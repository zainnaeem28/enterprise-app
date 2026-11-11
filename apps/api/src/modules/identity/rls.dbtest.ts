// Real-database tests for BE-04, database side: RLS policies and grants of the identity tables as the real application
// roles, the triggers, the C0 directory view, the merge participant (22.16, 38.2 item 11) and the export part.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/identity/rls.dbtest.js
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ParticipantRegistries } from '@ehr/kernel';
import type { ScopeSettings } from '@ehr/kernel';
import {
  identityExportContributor,
  identityMergeParticipant,
  registerIdentityParticipants,
} from './merge.js';
import { IdentityScopeError, IdentityValidationError } from './errors.js';
import { uuidv7 } from './ids.js';
import { assignRole, id, ORG, pg, seedPrincipal, setup } from './testkit.js';
import type { Kit } from './testkit.js';

const L1 = id(101);
const PX = id(403);

let k: Kit;
before(async () => {
  k = await setup({
    name: 'rls',
    withApp: false,
    fixtures: async ({ sa }) => {
      await sa.query(
        `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('NY', $1, 'New York')`,
        [ORG],
      );
      // Patient rows the identity fixtures point at: patient.guard_open_patient (BE-08, migration 0701) refuses writes for a patient that does not exist.
      let mrn = 8000000;
      for (const pid of [
        PX,
        id(699),
        id(501),
        id(502),
        id(503),
        id(511),
        id(521),
        id(522),
        id(601),
        id(602),
        id(611),
        id(612),
        id(621),
        id(622),
        id(631),
      ])
        await sa.query(
          `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via) VALUES ($1, $2, $3, 'Fixture', 'Patient', '1980-01-01', 'NY', 'front_desk')`,
          [pid, ORG, `MRN-${mrn++}`],
        );
      // The guard reads the patient root as its owner under row-level security, so this superuser session carries an organisation and an audience too.
      await sa.query(
        `SELECT set_config('app.org_id', $1, false), set_config('app.audience', 'system', false)`,
        [ORG],
      );
      await sa.query(
        `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code, active) VALUES ($1, $2, 'Main', 'clinic', 'America/New_York', 'NY', true)`,
        [L1, ORG],
      );
    },
  });
});
after(async () => {
  await k?.close();
});

/** Runs fn as a real application role with transaction-local settings; always rolls back. */
async function as<T>(
  role: string,
  settings: Record<string, string>,
  fn: (c: {
    query(
      s: string,
      p?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  }) => Promise<T>,
): Promise<T> {
  const c = new pg.Client({ connectionString: k.urlFor(role) });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const [n, v] of Object.entries(settings))
      await c.query('SELECT set_config($1, $2, true)', [n, v]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}
const rejects = (p: Promise<unknown>, code: string, what: string): Promise<void> =>
  assert.rejects(p, (e: { code?: string; message?: string }) => {
    assert.equal(e.code, code, `${what}: expected ${code}, got ${e.code} (${e.message})`);
    return true;
  });
const count = async (
  c: { query(s: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  table: string,
): Promise<number> => Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.['n']);

const TABLES = [
  'person',
  'principal',
  'session',
  'role',
  'permission',
  'role_permission',
  'role_assignment',
  'staff_profile',
  'licensed_state',
  'patient_link',
  'proxy_grant',
  'push_subscription',
  'staff_support',
  // BE-05 (B2 admin realm)
  'admin_credential',
  'elevation_grant',
  'enrolment_token',
  'role_change_request',
  'webauthn_challenge',
  // INT04-F02b (A-6): the insert-only record of the first-admin bootstrap runs
  'bootstrap_run',
];

describe('catalog (M-1, M-2, M-3, M-5, 21.3 lists)', () => {
  test('every identity table has ENABLE and FORCE row level security, a data class and no PUBLIC policy', async () => {
    const t = await k.q<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      comment: string | null;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, obj_description(c.oid) AS comment FROM pg_class c WHERE c.relnamespace = 'identity'::regnamespace AND c.relkind = 'r'`,
    );
    assert.deepEqual(t.map((x) => x.relname).sort(), [...TABLES].sort());
    for (const x of t) {
      assert.ok(x.relrowsecurity && x.relforcerowsecurity, `${x.relname} FORCE RLS`);
      assert.match(x.comment ?? '', /class=C[0-3]/, `${x.relname} class tag`);
    }
    assert.equal(
      (
        await k.q(
          `SELECT 1 FROM pg_policies WHERE schemaname = 'identity' AND (roles = '{public}' OR roles = '{}')`,
        )
      ).length,
      0,
    );
    const roles = await k.q<{ r: string }>(
      `SELECT DISTINCT unnest(roles) AS r FROM pg_policies WHERE schemaname = 'identity'`,
    );
    assert.deepEqual(roles.map((x) => x.r).sort(), [
      'app_api',
      'app_worker',
      'directory_ro',
      'identity_bootstrap_owner', // the first-admin bootstrap definer (INT04-F02b, A-6)
      'identity_signin_ro', // the admin claim read (BE-05)
      'patient_scope_owner',
    ]);
  });

  test('the identity policies that can match audience anonymous are exactly the T-SIGNIN list and the session lookup (21.3)', async () => {
    const rows = await k.q<{ id: string }>(
      `SELECT tablename || '.' || policyname AS id FROM pg_policies
        WHERE schemaname = 'identity' AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%app.audience%' OR (schemaname = 'identity' AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%''anonymous''%') ORDER BY 1`,
    );
    assert.deepEqual(
      rows.map((r) => r.id),
      [
        // BE-05 (B2 admin realm sign-in, elevation and enrolment; the same list is in db/tools/catalog-lists.mjs)
        'admin_credential.admin_credential_signin_claim',
        'admin_credential.admin_credential_signin_insert',
        'admin_credential.admin_credential_signin_select',
        'admin_credential.admin_credential_signin_update',
        'enrolment_token.enrolment_token_lookup',
        'enrolment_token.enrolment_token_signin_update',
        'person.person_signin_insert',
        'principal.principal_signin_claim',
        'principal.principal_signin_insert',
        'principal.principal_signin_select',
        'principal.principal_signin_update',
        'session.session_lookup',
        'session.session_signin_insert',
        'session.session_signin_insert_admin',
        'webauthn_challenge.webauthn_challenge_anon_insert',
        'webauthn_challenge.webauthn_challenge_anon_select',
        'webauthn_challenge.webauthn_challenge_anon_update',
      ],
    );
  });

  test('the identity policies that can match audience public are exactly the T-DIRECTORY policies', async () => {
    const rows = await k.q<{ id: string }>(
      `SELECT tablename || '.' || policyname AS id FROM pg_policies
        WHERE schemaname = 'identity' AND ((coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%app.audience%' OR (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%''public''%') ORDER BY 1`,
    );
    assert.deepEqual(
      rows.map((r) => r.id),
      ['principal.principal_directory', 'staff_profile.staff_profile_directory'],
    );
    const dir = await k.q<{ polroles: string }>(
      `SELECT tablename FROM pg_policies WHERE schemaname = 'identity' AND policyname LIKE '%_directory' AND roles = '{directory_ro}'`,
    );
    assert.equal(dir.length, 2);
  });

  test('app_api has no UPDATE of identity columns beyond the 21.2 list; app_worker none on principal or person', async () => {
    const cols = async (role: string, table: string): Promise<string[]> =>
      (
        await k.q<{ attname: string }>(
          `SELECT a.attname FROM pg_attribute a WHERE a.attrelid = $2::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege($1, a.attrelid, a.attnum, 'UPDATE') ORDER BY 1`,
          [role, table],
        )
      ).map((x) => x.attname);
    assert.deepEqual(await cols('app_api', 'identity.session'), [
      'csrf_hash',
      'idle_expires_at',
      'last_interaction_at',
      'last_seen_at',
      'revoke_reason',
      'revoked_at',
      'token_hash',
    ]);
    // status and disabled_reason: the kill switch and deprovisioning (BE-05); a trigger refuses them to an anonymous transaction.
    assert.deepEqual(await cols('app_api', 'identity.principal'), [
      'disabled_reason',
      'last_sign_in_at',
      'status',
      'subject',
    ]);
    assert.deepEqual(await cols('app_worker', 'identity.principal'), []);
    assert.deepEqual(await cols('app_api', 'identity.person'), []);
    assert.deepEqual(await cols('app_api', 'identity.role'), []);
    assert.deepEqual(await cols('app_api', 'identity.role_permission'), []);
    // revoked_at: a role removal and the kill switch (BE-05)
    assert.deepEqual(await cols('app_api', 'identity.role_assignment'), ['revoked_at']);
    assert.deepEqual(await cols('app_api', 'identity.proxy_grant'), [
      'revoke_reason',
      'revoked_at',
      'status',
    ]);
  });

  test('identity_signin_ro and directory_ro hold no table-level SELECT on the identity base tables; directory_ro has exactly the 22.5.1 columns', async () => {
    for (const t of TABLES) {
      for (const r of ['identity_signin_ro', 'directory_ro'])
        assert.equal(
          (
            await k.q(`SELECT has_table_privilege($1, $2, 'SELECT') AS s`, [r, `identity.${t}`])
          )[0]?.['s'],
          false,
          `${r} on ${t}`,
        );
    }
    const granted = async (table: string): Promise<string[]> =>
      (
        await k.q<{ attname: string }>(
          `SELECT a.attname FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege('directory_ro', a.attrelid, a.attnum, 'SELECT') ORDER BY 1`,
          [table],
        )
      ).map((x) => x.attname);
    assert.deepEqual(await granted('identity.principal'), [
      'id',
      'organisation_id',
      'realm',
      'status',
    ]);
    assert.deepEqual(await granted('identity.staff_profile'), [
      'directory_listed',
      'display_name',
      'organisation_id',
      'principal_id',
    ]);
    assert.equal(
      (
        await k.q(
          `SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'identity.public_clinician'::regclass`,
        )
      )[0]?.['o'],
      'directory_ro',
    );
    assert.equal(
      (await k.q(`SELECT has_schema_privilege('directory_ro', 'identity', 'CREATE') AS c`))[0]?.[
        'c'
      ],
      false,
      'CREATE is withdrawn after the ownership transfer',
    );
  });
});

describe('audience anonymous (21.3): the sign-in path and nothing else', () => {
  test('with no settings an anonymous transaction sees no row of any identity table, and no non-pre_auth setting', async () => {
    await seedPrincipal(k, 'google', { email: 'anon@example.com' });
    await as('app_api', { 'app.audience': 'anonymous', 'app.org_id': ORG }, async (c) => {
      for (const t of TABLES) assert.equal(await count(c, `identity.${t}`), 0, t);
      assert.equal(await count(c, 'kernel.setting'), 0);
      assert.equal(await count(c, 'audit.event'), 0);
    });
  });

  test('only the presented token hash reveals a session, and only that one', async () => {
    const a = await seedPrincipal(k, 'google', { email: 'a1@example.com' });
    const sessions: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { seedSession } = await import('./testkit.js');
      sessions.push((await seedSession(k, a, 'google')).sessionId);
    }
    const hash = (
      await k.q<{ h: Buffer }>(`SELECT token_hash AS h FROM identity.session WHERE id = $1`, [
        sessions[0],
      ])
    )[0]?.h as Buffer;
    await as(
      'app_api',
      {
        'app.audience': 'anonymous',
        'app.org_id': ORG,
        'app.session_token_hash': hash.toString('hex'),
      },
      async (c) => {
        const r = await c.query('SELECT id FROM identity.session');
        assert.deepEqual(
          r.rows.map((x) => x['id']),
          [sessions[0]],
        );
        assert.equal(
          await count(c, 'identity.principal'),
          0,
          'the lookup does not open the principal',
        );
      },
    );
  });

  test('T-SIGNIN: nothing is writable until app.auth_subject is set; then only the verified subject, only in patient and google realms', async () => {
    const pid = uuidv7();
    const person = uuidv7();
    const insertPerson = (c: { query(s: string, p?: unknown[]): Promise<unknown> }, p = person) =>
      c.query(
        `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1, $2, 'X')`,
        [p, ORG],
      );
    const base = { 'app.audience': 'anonymous', 'app.org_id': ORG };
    await as('app_api', base, (c) =>
      rejects(insertPerson(c), '42501', 'person without a verified subject'),
    );
    await as('app_api', { ...base, 'app.audience': 'staff' }, (c) =>
      rejects(insertPerson(c), '42501', 'person as staff'),
    );
    await as(
      'app_api',
      {
        ...base,
        'app.auth_subject': 's1',
        'app.auth_realm': 'google',
        'app.auth_email': 'x@example.com',
      },
      async (c) => {
        await insertPerson(c);
        const ins = (over: Record<string, unknown>) => {
          const v = { realm: 'google', subject: 's1', email: 'x@example.com', ...over };
          return c.query(
            `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email) VALUES ($1, $2, $3, $4, $5, $6)`,
            [uuidv7(), ORG, person, v.realm, v.subject, v.email],
          );
        };
        await c.query('SAVEPOINT a');
        await rejects(
          ins({ subject: 'someone-else' }),
          '42501',
          'subject other than the verified one',
        );
        await c.query('ROLLBACK TO a');
        await rejects(
          ins({ email: 'y@example.com' }),
          '42501',
          'google email other than the verified one',
        );
        await c.query('ROLLBACK TO a');
        await rejects(
          ins({ realm: 'admin_pool' }),
          '42501',
          'admin_pool is never provisioned on a sign-in path',
        );
        await c.query('ROLLBACK TO a');
        await rejects(ins({ realm: 'patient_pool' }), '42501', 'realm other than app.auth_realm');
        await c.query('ROLLBACK TO a');
        await ins({}); // the genuine one is accepted
        void pid;
      },
    );
    await as(
      'app_api',
      { ...base, 'app.auth_subject': 's2', 'app.auth_realm': 'admin_pool' },
      async (c) => {
        await insertPerson(c);
        await rejects(
          c.query(
            `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject) VALUES ($1, $2, $3, 'admin_pool', 's2')`,
            [uuidv7(), ORG, person],
          ),
          '42501',
          'admin principal on a sign-in path',
        );
      },
    );
  });

  test('a person without a principal cannot be committed (deferred constraint trigger)', async () => {
    const c = new pg.Client({ connectionString: k.urlFor('app_api') });
    await c.connect();
    try {
      await c.query('BEGIN');
      for (const [n, v] of Object.entries({
        'app.audience': 'anonymous',
        'app.org_id': ORG,
        'app.auth_subject': 's3',
        'app.auth_realm': 'google',
      }))
        await c.query('SELECT set_config($1, $2, true)', [n, v]);
      await c.query(
        `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1, $2, 'Orphan')`,
        [uuidv7(), ORG],
      );
      await rejects(c.query('COMMIT'), 'PS001', 'orphan person');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  });

  test('the session insert needs the new token hash in the setting and the verified principal', async () => {
    const pr = await seedPrincipal(k, 'google', { subject: 'ver-1', email: 'v1@example.com' });
    const other = await seedPrincipal(k, 'google', { subject: 'ver-2', email: 'v2@example.com' });
    const { issueToken } = await import('./tokens.js');
    const t = issueToken();
    const row = (
      principal: { principalId: string; personId: string },
      tok: { hash: Buffer },
      realm = 'google',
    ) => [
      uuidv7(),
      ORG,
      tok.hash,
      principal.principalId,
      principal.personId,
      realm,
      realm === 'google' ? 'staff' : 'patient',
      new Date(),
      Buffer.alloc(32, 1),
      new Date(Date.now() + 60_000),
      new Date(Date.now() + 120_000),
    ];
    const sql = `INSERT INTO identity.session (id, organisation_id, token_hash, principal_id, person_id, realm, audience, auth_time, csrf_hash, idle_expires_at, absolute_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
    const scope = {
      'app.audience': 'anonymous',
      'app.org_id': ORG,
      'app.auth_realm': 'google',
      'app.auth_subject': 'ver-1',
      'app.session_token_hash': t.hashHex,
    };
    await as('app_api', scope, async (c) => {
      await c.query('SAVEPOINT a');
      await rejects(
        c.query(sql, row(other, t)),
        '42501',
        'a session for a principal that was not verified',
      );
      await c.query('ROLLBACK TO a');
      await rejects(
        c.query(sql, row(pr, issueToken())),
        '42501',
        'a token hash other than the one in the setting',
      );
      await c.query('ROLLBACK TO a');
      await rejects(
        c.query(sql, row(pr, t, 'patient_pool')),
        '42501',
        "realm other than the principal's",
      );
      await c.query('ROLLBACK TO a');
      await c.query(sql, row(pr, t));
    });
    await as('app_api', { ...scope, 'app.session_token_hash': '' }, (c) =>
      rejects(c.query(sql, row(pr, t)), '42501', 'no hash in the setting'),
    );
  });

  test('column grants: an anonymous sign-in cannot change anything of a principal but subject and last_sign_in_at', async () => {
    const pr = await seedPrincipal(k, 'google', { subject: 'col-1', email: 'c1@example.com' });
    const scope = {
      'app.audience': 'anonymous',
      'app.org_id': ORG,
      'app.auth_realm': 'google',
      'app.auth_subject': 'col-1',
    };
    await as('app_api', scope, async (c) => {
      await c.query('SAVEPOINT a');
      for (const col of ['status', 'email', 'realm', 'person_id', 'disabled_reason']) {
        await rejects(
          c.query(`UPDATE identity.principal SET ${col} = ${col} WHERE id = $1`, [pr.principalId]),
          '42501',
          `update ${col}`,
        );
        await c.query('ROLLBACK TO a');
      }
      assert.equal(
        (
          await c.query(`UPDATE identity.principal SET last_sign_in_at = now() WHERE id = $1`, [
            pr.principalId,
          ])
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await c.query(`UPDATE identity.principal SET last_sign_in_at = now() WHERE id <> $1`, [
            pr.principalId,
          ])
        ).rowCount,
        0,
        'only the verified principal is reachable',
      );
    });
  });
});

describe('triggers (21.5, 22.4)', () => {
  test('principal: subject binds once and never changes; person, realm and organisation never change', async () => {
    const pre = await seedPrincipal(k, 'google', {
      subject: null,
      email: 'tb@example.com',
      preregisteredAt: new Date(),
    });
    await k.sa.query(`UPDATE identity.principal SET subject = 'bound-1' WHERE id = $1`, [
      pre.principalId,
    ]);
    await rejects(
      k.sa.query(`UPDATE identity.principal SET subject = 'bound-2' WHERE id = $1`, [
        pre.principalId,
      ]),
      'PS001',
      'rebind',
    );
    await rejects(
      k.sa.query(`UPDATE identity.principal SET email = 'other@example.com' WHERE id = $1`, [
        pre.principalId,
      ]),
      'PS001',
      'email of a bound principal',
    );
    await rejects(
      k.sa.query(`UPDATE identity.principal SET realm = 'patient_pool' WHERE id = $1`, [
        pre.principalId,
      ]),
      'PS001',
      'realm',
    );
    await rejects(
      k.sa.query(`UPDATE identity.principal SET subject = NULL WHERE id = $1`, [pre.principalId]),
      'PS001',
      'unbind',
    );
  });

  test('principal constraints: subject or a google pre-registration email; one principal per realm and person; unique email while unbound', async () => {
    const person = (await seedPrincipal(k, 'google', { subject: null, email: 'uq@example.com' }))
      .personId;
    await rejects(
      k.sa.query(
        `INSERT INTO identity.principal (id, organisation_id, person_id, realm) VALUES ($1, $2, $3, 'patient_pool')`,
        [uuidv7(), ORG, person],
      ),
      '23514',
      'no subject outside a google pre-registration',
    );
    await rejects(
      k.sa.query(
        `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject) VALUES ($1, $2, $3, 'google', 'zzz')`,
        [uuidv7(), ORG, person],
      ),
      '23505',
      'two google principals for one person',
    );
    // A second person with a principal in one transaction (a person must have a principal at commit).
    const second = async (email: string): Promise<void> => {
      await k.sa.query('BEGIN');
      try {
        const p2 = uuidv7();
        await k.sa.query(
          `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1, $2, 'P2')`,
          [p2, ORG],
        );
        await k.sa.query(
          `INSERT INTO identity.principal (id, organisation_id, person_id, realm, email) VALUES ($1, $2, $3, 'google', $4)`,
          [uuidv7(), ORG, p2, email],
        );
        await k.sa.query('COMMIT');
      } catch (e) {
        await k.sa.query('ROLLBACK');
        throw e;
      }
    };
    await rejects(second('UQ@example.com'), '23514', 'email must be lower case');
    await rejects(
      second('uq@example.com'),
      '23505',
      'a second unbound principal with the same email',
    );
  });

  test('session: revocation is monotonic; a revoked row accepts no change; identity columns never change', async () => {
    const { seedSession } = await import('./testkit.js');
    const pr = await seedPrincipal(k, 'google', { email: 'tr@example.com' });
    const s = await seedSession(k, pr, 'google');
    const upd = (set: string) =>
      k.sa.query(`UPDATE identity.session SET ${set} WHERE id = $1`, [s.sessionId]);
    await rejects(
      upd(`absolute_expires_at = absolute_expires_at + interval '1 hour'`),
      'PS001',
      'absolute expiry',
    );
    await rejects(upd(`auth_time = now()`), 'PS001', 'auth_time');
    await rejects(upd(`realm = 'admin_pool'`), 'PS001', 'realm');
    await rejects(upd(`principal_id = '${uuidv7()}'`), 'PS001', 'principal');
    await rejects(upd(`revoked_at = now()`), '23514', 'revoked_at without a reason');
    await upd(`revoked_at = now(), revoke_reason = 'sign_out'`);
    await rejects(upd(`revoked_at = NULL, revoke_reason = NULL`), 'PS001', 'un-revoking');
    await rejects(upd(`last_seen_at = now()`), 'PS001', 'touching a revoked session');
    await rejects(upd(`revoke_reason = 'kill_switch'`), 'PS001', 'changing the reason');
  });

  test('session: idle never beyond absolute (CHECK); audience must match realm', async () => {
    const { seedSession } = await import('./testkit.js');
    const pr = await seedPrincipal(k, 'google', { email: 'ck@example.com' });
    const s = await seedSession(k, pr, 'google');
    await rejects(
      k.sa.query(
        `UPDATE identity.session SET idle_expires_at = absolute_expires_at + interval '1 minute' WHERE id = $1`,
        [s.sessionId],
      ),
      '23514',
      'idle beyond absolute',
    );
    await rejects(
      k.sa.query(
        `INSERT INTO identity.session (id, organisation_id, token_hash, principal_id, person_id, realm, audience, auth_time, csrf_hash, idle_expires_at, absolute_expires_at) VALUES ($1,$2,$3,$4,$5,'google','patient',now(),$3,now(),now())`,
        [uuidv7(), ORG, Buffer.alloc(32, 7), pr.principalId, pr.personId],
      ),
      '23514',
      'staff realm with a patient audience',
    );
  });

  test('role_assignment: realm, privileged-in-admin-only, location binding, signed-in principal; assignments are only ever revoked', async () => {
    const g = await seedPrincipal(k, 'google', { email: 'ra@example.com' });
    const adm = await seedPrincipal(k, 'admin_pool');
    const pat = await seedPrincipal(k, 'patient_pool');
    // Every assignment cites a real approved role-change request (BE-05); assignRole builds one.
    const ins = (principal: string, role: string, loc: string | null) =>
      assignRole(k, principal, role, loc ?? undefined);
    await rejects(
      ins(g.principalId, 'org_admin', null),
      'PS001',
      'admin role to a google principal',
    );
    await rejects(ins(adm.principalId, 'doctor', L1), 'PS001', 'staff role to an admin principal');
    await rejects(ins(pat.principalId, 'front_desk', L1), 'PS001', 'staff role to a patient');
    await rejects(
      ins(g.principalId, 'front_desk', null),
      'PS001',
      'location-bound role without a location',
    );
    await rejects(
      ins(adm.principalId, 'org_admin', L1),
      'PS001',
      'location on a role that is not location-bound',
    );
    await ins(g.principalId, 'front_desk', L1);
    await rejects(ins(g.principalId, 'front_desk', L1), '23505', 'the same open assignment twice');
    const ra = (
      await k.q(`SELECT id FROM identity.role_assignment WHERE principal_id = $1`, [g.principalId])
    )[0]?.['id'];
    await rejects(
      k.sa.query(
        `UPDATE identity.role_assignment SET role_id = (SELECT id FROM identity.role WHERE key = 'doctor') WHERE id = $1`,
        [ra],
      ),
      'PS001',
      'changing the role of an assignment',
    );
    await k.sa.query(`UPDATE identity.role_assignment SET revoked_at = now() WHERE id = $1`, [ra]);
    await ins(g.principalId, 'front_desk', L1); // a revoked one does not block a new one
    await rejects(
      k.sa.query(
        `INSERT INTO identity.role (id, organisation_id, key, realm, privileged, location_bound) VALUES ($1, $2, 'bad_admin', 'google', true, false)`,
        [uuidv7(), ORG],
      ),
      '23514',
      'a privileged role in the staff realm',
    );
  });

  test('proxy_grant: legal transitions only; revoked and expired are K and never change again; the proxy and scope are fixed', async () => {
    const pr = await seedPrincipal(k, 'patient_pool');
    const g = uuidv7();
    await k.sa.query(
      `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name) VALUES ($1, $2, $3, $4, 'parent', 'Sam J')`,
      [g, ORG, pr.principalId, PX],
    );
    const upd = (set: string) =>
      k.sa.query(`UPDATE identity.proxy_grant SET ${set} WHERE id = $1`, [g]);
    await rejects(upd(`status = 'active'`), 'PS001', 'requested -> active skips verification');
    await rejects(upd(`proxy_principal_id = '${uuidv7()}'`), 'PS001', 'changing the proxy');
    await rejects(upd(`scope = 'full'`), 'PS001', 'the scope is fixed');
    await rejects(
      k.sa.query(
        `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, scope, patient_display_name) VALUES ($1,$2,$3,$4,'parent','full','X')`,
        [uuidv7(), ORG, pr.principalId, id(699)],
      ),
      '23514',
      'a scope other than appointments',
    );
    await upd(`status = 'verified'`);
    await upd(`status = 'active'`);
    await upd(`patient_display_name = 'Sam J.'`);
    await rejects(upd(`status = 'verified'`), 'PS001', 'active -> verified');
    await upd(`status = 'revoked', revoked_at = now(), revoke_reason = 'staff'`);
    await rejects(upd(`patient_display_name = 'X'`), 'PS001', 'a revoked grant is K');
    await rejects(
      upd(`status = 'active', revoked_at = NULL, revoke_reason = NULL`),
      'PS001',
      'revoked -> active',
    );
    await rejects(
      k.sa.query(
        `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status) VALUES ($1,$2,$3,$4,'parent','X','revoked')`,
        [uuidv7(), ORG, pr.principalId, PX],
      ),
      '23514',
      'a revoked grant needs its time and reason',
    );
    // one open grant per proxy and patient
    await k.sa.query(
      `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name) VALUES ($1, $2, $3, $4, 'parent', 'Sam J')`,
      [uuidv7(), ORG, pr.principalId, PX],
    );
    await rejects(
      k.sa.query(
        `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name) VALUES ($1, $2, $3, $4, 'carer', 'Sam J')`,
        [uuidv7(), ORG, pr.principalId, PX],
      ),
      '23505',
      'two open grants',
    );
  });

  test('staff_support links two google principals only', async () => {
    const a = await seedPrincipal(k, 'google', { email: 'ss1@example.com' });
    const b = await seedPrincipal(k, 'google', { email: 'ss2@example.com' });
    const pat = await seedPrincipal(k, 'patient_pool');
    const ins = (x: string, y: string) =>
      k.sa.query(
        `INSERT INTO identity.staff_support (id, organisation_id, assistant_principal_id, supported_principal_id, from_date) VALUES ($1,$2,$3,$4,current_date)`,
        [uuidv7(), ORG, x, y],
      );
    await rejects(ins(a.principalId, pat.principalId), 'PS001', 'a patient as supported doctor');
    await rejects(ins(a.principalId, a.principalId), 'PS001', 'self support');
    await ins(a.principalId, b.principalId);
    await rejects(ins(a.principalId, b.principalId), '23505', 'a second open row');
  });
});

describe('isolation between principals (T-PRINCIPAL, T-PAT-OWN)', () => {
  test("a staff principal reads its own sessions and not another principal's; it cannot revoke another's session", async () => {
    const { seedSession } = await import('./testkit.js');
    const a = await seedPrincipal(k, 'google', { email: 'iso1@example.com' });
    const b = await seedPrincipal(k, 'google', { email: 'iso2@example.com' });
    const sa = await seedSession(k, a, 'google');
    const sb = await seedSession(k, b, 'google');
    const scopeA = {
      'app.audience': 'staff',
      'app.realm': 'google',
      'app.org_id': ORG,
      'app.principal_id': a.principalId,
      'app.person_id': a.personId,
    };
    await as('app_api', scopeA, async (c) => {
      assert.deepEqual(
        (await c.query('SELECT id FROM identity.session')).rows.map((r) => r['id']),
        [sa.sessionId],
      );
      assert.equal(
        (
          await c.query(
            `UPDATE identity.session SET revoked_at = now(), revoke_reason = 'kill_switch' WHERE id = $1`,
            [sb.sessionId],
          )
        ).rowCount,
        0,
      );
      await rejects(
        c.query(`UPDATE identity.session SET realm = 'admin_pool' WHERE id = $1`, [sa.sessionId]),
        '42501',
        'realm column is not updatable',
      );
    });
  });

  test('a patient reads only its own links and its own principal; links cannot be inserted through the API role', async () => {
    const a = await seedPrincipal(k, 'patient_pool');
    const b = await seedPrincipal(k, 'patient_pool');
    for (const [pr, pa] of [
      [a, id(501)],
      [b, id(502)],
    ] as const)
      await k.sa.query(
        `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
        [pr.principalId, pa, ORG],
      );
    const scope = {
      'app.audience': 'patient',
      'app.realm': 'patient_pool',
      'app.org_id': ORG,
      'app.principal_id': a.principalId,
      'app.person_id': a.personId,
    };
    await as('app_api', scope, async (c) => {
      assert.deepEqual(
        (await c.query('SELECT patient_id FROM identity.patient_link')).rows.map(
          (r) => r['patient_id'],
        ),
        [id(501)],
      );
      assert.deepEqual(
        (await c.query('SELECT id FROM identity.principal')).rows.map((r) => r['id']),
        [a.principalId],
      );
      assert.equal(await count(c, 'identity.role_assignment'), 0);
      await rejects(
        c.query(
          `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
          [a.principalId, id(502), ORG],
        ),
        '42501',
        'a patient linking itself to any patient',
      );
    });
  });

  test('patient_link INSERT works only for patient_scope_owner (patient.register), in a patient or staff transaction', async () => {
    const a = await seedPrincipal(k, 'patient_pool');
    const run = async (settings: Record<string, string>) => {
      const c = new pg.Client({
        connectionString: k.urlFor(new URL(process.env['EHR_TEST_ADMIN_URL'] as string).username),
      });
      await c.connect();
      try {
        await c.query('BEGIN');
        for (const [n, v] of Object.entries(settings))
          await c.query('SELECT set_config($1, $2, true)', [n, v]);
        await c.query('SET LOCAL ROLE patient_scope_owner');
        return await c.query(
          `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
          [a.principalId, id(503), ORG],
        );
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };
    assert.equal((await run({ 'app.audience': 'patient', 'app.org_id': ORG })).rowCount, 1);
    await assert.rejects(
      run({ 'app.audience': 'anonymous', 'app.org_id': ORG }),
      (e: { code?: string }) => e.code === '42501',
    );
    await assert.rejects(
      run({ 'app.audience': 'patient', 'app.org_id': id(9) }),
      (e: { code?: string }) => e.code === '42501',
    );
  });

  test('proxy_grant: a proxy sees its own grants; the patient sees its proxies; a proxy never reads the grants of the patient it serves', async () => {
    const owner = await seedPrincipal(k, 'patient_pool');
    const proxy = await seedPrincipal(k, 'patient_pool');
    const other = await seedPrincipal(k, 'patient_pool');
    const P = id(511);
    await k.sa.query(
      `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
      [owner.principalId, P, ORG],
    );
    for (const pr of [proxy, other])
      await k.sa.query(
        `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status) VALUES ($1,$2,$3,$4,'parent','Kid K','active')`,
        [uuidv7(), ORG, pr.principalId, P],
      );
    const sc = (pr: { principalId: string }, patients: string[], proxies: string[]) => ({
      'app.audience': 'patient',
      'app.realm': 'patient_pool',
      'app.org_id': ORG,
      'app.principal_id': pr.principalId,
      'app.patient_ids': patients.join(','),
      'app.proxy_patient_ids': proxies.join(','),
    });
    await as('app_api', sc(proxy, [P], [P]), async (c) => {
      assert.deepEqual(
        (await c.query('SELECT proxy_principal_id FROM identity.proxy_grant')).rows.map(
          (r) => r['proxy_principal_id'],
        ),
        [proxy.principalId],
        "own grant only, not the other proxy's",
      );
    });
    await as('app_api', sc(owner, [P], []), async (c) => {
      assert.equal(
        await count(c, 'identity.proxy_grant'),
        2,
        'the patient sees both of their proxies',
      );
    });
    await as('app_api', sc(other, [], []), async (c) => {
      assert.deepEqual(
        (await c.query('SELECT proxy_principal_id FROM identity.proxy_grant')).rows.map(
          (r) => r['proxy_principal_id'],
        ),
        [other.principalId],
      );
    });
  });

  test('proxy requests and revocation through the service: only a requested row for itself; only the patient revokes; a proxy cannot', async () => {
    const owner = await seedPrincipal(k, 'patient_pool');
    const proxy = await seedPrincipal(k, 'patient_pool');
    const P = id(521);
    await k.sa.query(
      `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
      [owner.principalId, P, ORG],
    );
    const svc = k.identity.proxies;
    const meta = { requestId: null };
    const proxyScope: ScopeSettings = {
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: proxy.principalId,
      personId: proxy.personId,
    };
    const grantId = await k.db.withScope(proxyScope, (tx) =>
      svc.request(tx, { patientId: P, relationship: 'parent', patientDisplayName: 'Kid K' }),
    );
    const mine = await k.db.withScope(proxyScope, (tx) => svc.listMine(tx));
    assert.deepEqual(
      mine.map((g) => [g.id, g.status, g.scope, g.patientDisplayName]),
      [[grantId, 'requested', 'appointments', 'Kid K']],
    );
    await assert.rejects(
      k.db.withScope(proxyScope, (tx) =>
        svc.request(tx, { patientId: P, relationship: 'carer', patientDisplayName: 'Kid K' }),
      ),
      (e: { code?: string }) => e.code === '23505',
    );
    await assert.rejects(
      k.db.withScope(proxyScope, (tx) =>
        svc.request(tx, { patientId: 'nope', relationship: 'parent', patientDisplayName: '' }),
      ),
      (e: unknown) => e instanceof IdentityValidationError && e.fields.includes('patientId'),
    );
    await assert.rejects(
      k.db.withScope({ ...proxyScope, audience: 'staff' }, (tx) =>
        svc.request(tx, { patientId: P, relationship: 'parent', patientDisplayName: 'x' }),
      ),
      (e: unknown) => e instanceof IdentityScopeError,
    );
    // A proxy cannot revoke (neither its own nor anyone's) through the patient path.
    await assert.rejects(
      k.db.withScope({ ...proxyScope, patientIds: [P], proxyPatientIds: [P] }, (tx) =>
        svc.revokeByPatient(tx, meta, P, grantId),
      ),
      (e: unknown) => e instanceof IdentityScopeError,
    );
    // It cannot insert itself an active grant.
    await assert.rejects(
      k.db.withScope(proxyScope, (tx) =>
        tx.query(
          `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status) VALUES ($1,$2,$3,$4,'parent','Kid K','active')`,
          [uuidv7(), ORG, proxy.principalId, id(522)],
        ),
      ),
      (e: { code?: string }) => e.code === '42501',
    );
    const ownerScope: ScopeSettings = {
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: owner.principalId,
      personId: owner.personId,
      patientIds: [P],
    };
    assert.deepEqual(
      (await k.db.withScope(ownerScope, (tx) => svc.listForPatient(tx, P))).map((g) => g.id),
      [grantId],
    );
    assert.equal(await k.db.withScope(ownerScope, (tx) => svc.revokeByPatient(tx, meta, P, grantId)), true);
    assert.equal(
      await k.db.withScope(ownerScope, (tx) => svc.revokeByPatient(tx, meta, P, grantId)),
      false,
      'already revoked: nothing to do',
    );
    const row = (
      await k.q(
        `SELECT status, revoke_reason, revoked_at FROM identity.proxy_grant WHERE id = $1`,
        [grantId],
      )
    )[0];
    assert.equal(row?.['status'], 'revoked');
    assert.equal(row?.['revoke_reason'], 'patient');
    assert.ok(row?.['revoked_at']);
  });
});

describe('identity.public_clinician (22.5.1, TDR-14, 38.2 item 17)', () => {
  test('public and patient audiences see listed, active google clinicians (display name only); nothing else, and no sensitive column', async () => {
    const mk = async (
      name: string,
      o: { listed: boolean; status?: string; realm?: 'google' | 'admin_pool' },
    ) => {
      const p = await seedPrincipal(k, o.realm ?? 'google', {
        email: `${name.replace(/\W/g, '').toLowerCase()}@example.com`,
        ...(o.status === undefined ? {} : { status: o.status }),
      });
      await k.sa.query(
        `INSERT INTO identity.staff_profile (principal_id, organisation_id, display_name, npi, dea_number, directory_listed) VALUES ($1,$2,$3,'1234567890','AB1234563',$4)`,
        [p.principalId, ORG, name, o.listed],
      );
      return p.principalId;
    };
    const listed = await mk('Dr Listed', { listed: true });
    await mk('Dr Unlisted', { listed: false });
    await mk('Dr Disabled', { listed: true, status: 'disabled' });
    await mk('Dr Suspended', { listed: true, status: 'suspended' });
    await mk('Admin Listed', { listed: true, realm: 'admin_pool' });
    for (const audience of ['public', 'patient']) {
      await as('app_api', { 'app.audience': audience, 'app.org_id': ORG }, async (c) => {
        const r = await c.query('SELECT * FROM identity.public_clinician');
        assert.deepEqual(
          r.rows.map((x) => x['display_name']),
          ['Dr Listed'],
        );
        assert.deepEqual(Object.keys(r.rows[0] ?? {}).sort(), [
          'display_name',
          'organisation_id',
          'principal_id',
        ]);
        assert.equal(r.rows[0]?.['principal_id'], listed);
        assert.equal(
          await count(c, 'identity.staff_profile'),
          0,
          'the base table stays closed to public and patient',
        );
        assert.equal(await count(c, 'identity.principal'), audience === 'patient' ? 0 : 0);
        await c.query('SAVEPOINT s');
        await rejects(
          c.query('SELECT npi FROM identity.public_clinician'),
          '42703',
          'npi is not in the view',
        );
        await c.query('ROLLBACK TO s');
      });
    }
    await as('app_api', { 'app.audience': 'anonymous', 'app.org_id': ORG }, async (c) =>
      assert.equal(await count(c, 'identity.public_clinician'), 0),
    );
    await as(
      'app_api',
      { 'app.audience': 'staff', 'app.realm': 'google', 'app.org_id': ORG },
      async (c) =>
        assert.equal(
          await count(c, 'identity.public_clinician'),
          0,
          'the view is for public and patient',
        ),
    );
    await as('app_api', { 'app.audience': 'public', 'app.org_id': id(9) }, async (c) =>
      assert.equal(await count(c, 'identity.public_clinician'), 0, 'another organisation'),
    );
  });

  test('directory_ro cannot be used to write, and app_api cannot switch to it', async () => {
    await as('app_api', { 'app.audience': 'public', 'app.org_id': ORG }, async (c) => {
      // A join view is not auto-updatable (55000); anything that could be written is refused for privilege (42501).
      const refused = async (sql: string, code: string, what: string): Promise<void> => {
        await c.query('SAVEPOINT s');
        await assert.rejects(
          c.query(sql),
          (e: { code?: string }) => [code, '55000'].includes(e.code ?? ''),
          what,
        );
        await c.query('ROLLBACK TO s');
      };
      await refused(
        'SET LOCAL ROLE directory_ro',
        '42501',
        'app_api has no membership of directory_ro',
      );
      await refused(
        `UPDATE identity.public_clinician SET display_name = 'x'`,
        '42501',
        'update through the view',
      );
      await refused(`DELETE FROM identity.public_clinician`, '42501', 'delete through the view');
      assert.equal(
        (await c.query(`SELECT npi FROM identity.staff_profile`)).rows.length,
        0,
        'the base table returns nothing to a public transaction',
      );
    });
  });
});

describe('merge participant: identity.repointPatient (22.16, 38.2 item 11)', () => {
  const jobScope = (ids: string[]): ScopeSettings => ({
    audience: 'system',
    realm: 'worker',
    orgId: ORG,
    jobScope: 'patients',
    jobPatientIds: ids,
  });
  const REQ = id(9001);

  test('registered with the kernel registries with its tables and conflict rules; exportPart is published; double registration is refused', () => {
    const r = new ParticipantRegistries();
    registerIdentityParticipants(r);
    const p = r.mergeParticipants().find((x) => x.module === 'identity');
    assert.ok(p);
    assert.deepEqual([...p.tables], ['identity.patient_link', 'identity.proxy_grant']);
    assert.deepEqual(
      p.conflictRules.map((c) => c.table),
      ['identity.patient_link', 'identity.proxy_grant'],
    );
    assert.equal(
      r.exportContributors().find((x) => x.module === 'identity')?.exportPart,
      identityExportContributor.exportPart,
    );
    assert.throws(() => registerIdentityParticipants(r), /already registered/);
    assert.deepEqual(p, identityMergeParticipant);
  });

  test('both patients linked from one portal principal, an open grant to the same proxy on both, K rows kept: counts add up and the rules win as 22.16 says', async () => {
    const A = await seedPrincipal(k, 'patient_pool'); // linked to both
    const B = await seedPrincipal(k, 'patient_pool'); // linked to M only
    const X = await seedPrincipal(k, 'patient_pool'); // proxy: active on M, requested on S
    const Y = await seedPrincipal(k, 'patient_pool'); // proxy: verified on both (tie)
    const Z = await seedPrincipal(k, 'patient_pool'); // proxy: revoked on M (K)
    const W = await seedPrincipal(k, 'patient_pool'); // proxy: requested on M only
    const Mp = id(601);
    const Sp = id(602);
    for (const [pr, pa] of [
      [A, Mp],
      [A, Sp],
      [B, Mp],
    ] as const)
      await k.sa.query(
        `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
        [pr.principalId, pa, ORG],
      );
    const grant = async (
      pr: { principalId: string },
      patient: string,
      status: string,
    ): Promise<string> => {
      const gid = uuidv7();
      await k.sa.query(
        `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status, revoked_at, revoke_reason)
         VALUES ($1,$2,$3,$4,'parent','Kid K',$5, CASE WHEN $5='revoked' THEN now() END, CASE WHEN $5='revoked' THEN 'staff' END)`,
        [gid, ORG, pr.principalId, patient, status],
      );
      return gid;
    };
    const xm = await grant(X, Mp, 'active');
    const xs = await grant(X, Sp, 'requested');
    const ym = await grant(Y, Mp, 'verified');
    const ys = await grant(Y, Sp, 'verified');
    const zm = await grant(Z, Mp, 'revoked');
    const wm = await grant(W, Mp, 'requested');

    const counts = await k.wdb.withScope(jobScope([Mp, Sp]), (tx) =>
      identityMergeParticipant.repointPatient(tx, Mp, Sp, REQ),
    );
    const by = Object.fromEntries(counts.map((c) => [c.table, c]));
    const links = by['identity.patient_link'];
    const grants = by['identity.proxy_grant'];
    assert.ok(links && grants);
    assert.deepEqual([links.found, links.repointed, links.resolved, links.kept], [2, 1, 1, 0]);
    assert.equal(links.deleted.length, 1);
    assert.equal(
      (links.deleted[0] as { principal_id: string }).principal_id,
      A.principalId,
      'the deleted merged-ID link is returned for the residue',
    );
    assert.deepEqual([grants.found, grants.repointed, grants.resolved, grants.kept], [4, 2, 1, 1]);
    for (const c of counts)
      assert.equal(
        c.found,
        c.repointed + c.resolved + c.kept,
        `${c.table}: found = re-pointed + resolved + kept`,
      );

    const linkRows = await k.q(
      `SELECT principal_id, patient_id FROM identity.patient_link WHERE principal_id = ANY($1) ORDER BY principal_id, patient_id`,
      [[A.principalId, B.principalId]],
    );
    assert.equal(
      linkRows.filter((r) => r['patient_id'] === Mp).length,
      0,
      'no link left on the merged patient',
    );
    assert.equal(
      linkRows.filter((r) => r['principal_id'] === A.principalId && r['patient_id'] === Sp).length,
      1,
    );
    assert.equal(
      linkRows.filter((r) => r['principal_id'] === B.principalId && r['patient_id'] === Sp).length,
      1,
    );

    const g = async (gid: string) =>
      (
        await k.q(
          `SELECT patient_id, status, revoke_reason FROM identity.proxy_grant WHERE id = $1`,
          [gid],
        )
      )[0];
    assert.deepEqual(
      await g(xm),
      { patient_id: Sp, status: 'active', revoke_reason: null },
      'the more advanced (merged, active) grant wins and moves',
    );
    assert.deepEqual(
      await g(xs),
      { patient_id: Sp, status: 'revoked', revoke_reason: 'merged_duplicate' },
      "the survivor's requested duplicate is revoked",
    );
    assert.deepEqual(
      await g(ys),
      { patient_id: Sp, status: 'verified', revoke_reason: null },
      "a tie goes to the survivor's grant",
    );
    assert.deepEqual(
      await g(ym),
      { patient_id: Mp, status: 'revoked', revoke_reason: 'merged_duplicate' },
      'the merged duplicate is resolved and stays on the merged ID as K',
    );
    assert.deepEqual(
      await g(zm),
      { patient_id: Mp, status: 'revoked', revoke_reason: 'staff' },
      'a K row is kept untouched',
    );
    assert.deepEqual(
      await g(wm),
      { patient_id: Sp, status: 'requested', revoke_reason: null },
      'an open grant with no counterpart is re-pointed',
    );
    assert.equal(
      Number(
        (
          await k.q(
            `SELECT count(*) AS n FROM identity.proxy_grant WHERE patient_id = $1 AND status IN ('requested','verified','active')`,
            [Mp],
          )
        )[0]?.['n'],
      ),
      0,
      'no R row left on the merged patient',
    );
    // The unique rule still holds after the merge.
    assert.equal(
      Number(
        (
          await k.q(
            `SELECT count(*) AS n FROM identity.proxy_grant WHERE patient_id = $1 AND proxy_principal_id = $2 AND status IN ('requested','verified','active')`,
            [Sp, X.principalId],
          )
        )[0]?.['n'],
      ),
      1,
    );
  });

  test('it refuses to run outside a patients-scope system job that names both IDs', async () => {
    const Mp = id(611);
    const Sp = id(612);
    const run = (scope: ScopeSettings) =>
      k.wdb.withScope(scope, (tx) => identityMergeParticipant.repointPatient(tx, Mp, Sp, REQ));
    await assert.rejects(
      run({ audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' }),
      (e: unknown) => e instanceof IdentityScopeError,
    );
    await assert.rejects(run(jobScope([Mp])), (e: unknown) => e instanceof IdentityScopeError);
    await assert.rejects(
      k.db.withScope(
        { audience: 'staff', realm: 'google', orgId: ORG, principalId: uuidv7() },
        (tx) => identityMergeParticipant.repointPatient(tx, Mp, Sp, REQ),
      ),
      (e: unknown) => e instanceof IdentityScopeError,
    );
    await assert.rejects(
      k.wdb.withScope(jobScope([Mp, Sp]), (tx) =>
        identityMergeParticipant.repointPatient(tx, Mp, 'not-a-uuid', REQ),
      ),
      (e: unknown) => e instanceof IdentityValidationError,
    );
    // An empty merge is fine: found 0, nothing to do.
    const counts = await run(jobScope([Mp, Sp]));
    assert.deepEqual(
      counts.map((c) => [c.found, c.repointed, c.resolved, c.kept]),
      [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
    );
  });

  test('a failing count rolls the merge transaction back whole', async () => {
    const A = await seedPrincipal(k, 'patient_pool');
    const Mp = id(621);
    const Sp = id(622);
    await k.sa.query(
      `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
      [A.principalId, Mp, ORG],
    );
    await assert.rejects(
      k.wdb.withScope(jobScope([Mp, Sp]), async (tx) => {
        await identityMergeParticipant.repointPatient(tx, Mp, Sp, REQ);
        throw new Error('a later participant failed');
      }),
    );
    assert.equal(
      Number(
        (
          await k.q(
            `SELECT count(*) AS n FROM identity.patient_link WHERE principal_id = $1 AND patient_id = $2`,
            [A.principalId, Mp],
          )
        )[0]?.['n'],
      ),
      1,
      'the link is back on the merged patient',
    );
  });

  test('exportPart: what identity holds about the patients, with no email, subject or token; refuses IDs outside the job', async () => {
    const A = await seedPrincipal(k, 'patient_pool', {
      email: 'export@example.com',
      subject: 'secret-subject-xyz',
    });
    const Pp = id(631);
    await k.sa.query(
      `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
      [A.principalId, Pp, ORG],
    );
    await k.sa.query(
      `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status) VALUES ($1,$2,$3,$4,'guardian','Kid K','active')`,
      [uuidv7(), ORG, A.principalId, Pp],
    );
    const part = (await k.wdb.withScope(jobScope([Pp]), (tx) =>
      identityExportContributor.exportPart(tx, [Pp], REQ),
    )) as {
      module: string;
      patientLinks: Record<string, unknown>[];
      proxyGrants: Record<string, unknown>[];
    };
    assert.equal(part.module, 'identity');
    assert.equal(part.patientLinks.length, 1);
    assert.equal(part.proxyGrants.length, 1);
    const text = JSON.stringify(part);
    assert.ok(!text.includes('export@example.com') && !text.includes('secret-subject-xyz'));
    assert.equal(part.proxyGrants[0]?.['scope'], 'appointments');
    await assert.rejects(
      k.wdb.withScope(jobScope([Pp]), (tx) =>
        identityExportContributor.exportPart(tx, [Pp, id(632)], REQ),
      ),
      (e: unknown) => e instanceof IdentityScopeError,
    );
  });
});

void assignRole;
