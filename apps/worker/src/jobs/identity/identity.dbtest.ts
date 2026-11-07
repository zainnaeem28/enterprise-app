// Real-database tests for BE-04, worker side: identity.apply_reference_data (idempotent, reconciling, audited) and
// identity.purge_sessions (33.1, SAR-IDF-05).
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/jobs/identity/identity.dbtest.js
// Missing configuration FAILS; nothing skips. Synthetic data only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KernelDb } from '@ehr/kernel';
import { runApplyReferenceData, runPurgeSessions } from './index.js';
import { PERMISSIONS, REFERENCE_DATASET, REFERENCE_VERSION } from './reference-data.js';
import { uuidv7 } from './ids.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env['EHR_TEST_ADMIN_URL'];
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
const dbName = `ehr_be04_worker_${process.pid}_${Date.now()}`;
const urlFor = (user: string): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${dbName}`;
  return u.toString();
};
const ORG = '00000000-0000-7000-8000-0000000000a1';

type Client = {
  query(
    s: string,
    p?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  connect(): Promise<void>;
  end(): Promise<void>;
};
let sa: Client;
let pool: { end(): Promise<void> };
let wdb: KernelDb;
const q = (s: string, p?: unknown[]): Promise<Record<string, unknown>[]> =>
  sa.query(s, p).then((r) => r.rows);
const n = async (s: string, p?: unknown[]): Promise<number> => Number((await q(s, p))[0]?.['n']);

before(async () => {
  const a = new pg.Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`CREATE DATABASE ${dbName}`);
  await a.end();
  const env = {
    PATH: process.env['PATH'],
    EHR_DB_ADMIN_URL: urlFor(new URL(adminUrl).username),
    EHR_DB_MIGRATE_URL: urlFor('app_owner'),
  };
  for (const cmd of ['bootstrap', 'migrate'])
    execFileSync(process.execPath, [`${root}db/tools/migrate.mjs`, cmd], { env, stdio: 'ignore' });
  sa = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) });
  await sa.connect();
  pool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 3 });
  wdb = new KernelDb(pool as never);
});
after(async () => {
  await pool?.end();
  await sa?.end();
  const a = new pg.Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await a.end();
});

describe('identity.apply_reference_data', () => {
  test('loads the catalogue, the roles and the 27.3 mapping, labelled Proposal, with the version row', async () => {
    const r = await runApplyReferenceData({ db: wdb, orgId: ORG, jobId: 'job-1' });
    assert.deepEqual([r.permissions, r.roles, r.changed], [80, 11, true]);
    assert.equal(await n(`SELECT count(*) AS n FROM identity.permission`), 80);
    assert.equal(await n(`SELECT count(*) AS n FROM identity.role`), 11);
    assert.equal(await n(`SELECT count(*) AS n FROM identity.role_permission`), r.mappings);
    assert.equal(
      await n(`SELECT count(*) AS n FROM identity.role WHERE description LIKE 'Proposal%'`),
      11,
    );
    const v = (
      await q(`SELECT version FROM kernel.reference_data_version WHERE dataset = $1`, [
        REFERENCE_DATASET,
      ])
    )[0];
    assert.equal(v?.['version'], REFERENCE_VERSION);
    assert.match(String(v?.['version']), /proposal/);
    const elevation = await q(
      `SELECT key FROM identity.permission WHERE needs_elevation ORDER BY key`,
    );
    assert.ok(
      elevation.length > 10 &&
        elevation.every((e) => PERMISSIONS.find((p) => p.key === e['key'])?.needsElevation),
    );
  });

  test('a second run changes nothing and writes no second audit event; a config_change event recorded the first', async () => {
    const before = await n(`SELECT count(*) AS n FROM identity.role_permission`);
    const r = await runApplyReferenceData({ db: wdb, orgId: ORG, jobId: 'job-2' });
    assert.equal(r.changed, false);
    assert.equal(await n(`SELECT count(*) AS n FROM identity.role_permission`), before);
    const ev = await q(
      `SELECT change, job_id FROM audit.event WHERE action = 'config_change' AND resource_type = 'identity.role'`,
    );
    assert.equal(ev.length, 1);
    assert.equal(ev[0]?.['job_id'], 'job-1');
    const ch = ev[0]?.['change'] as {
      dataset: string;
      checksumBefore: string | null;
      checksumAfter: string;
    };
    assert.equal(ch.dataset, REFERENCE_DATASET);
    assert.equal(ch.checksumBefore, null);
    assert.match(ch.checksumAfter, /^[0-9a-f]{64}$/);
  });

  test('it reconciles drift: a removed mapping is restored and an extra one removed', async () => {
    await sa.query(
      `DELETE FROM identity.role_permission WHERE role_id = (SELECT id FROM identity.role WHERE key = 'assistant') AND permission_key = 'clinical.note.write'`,
    );
    await sa.query(
      `INSERT INTO identity.role_permission (organisation_id, role_id, permission_key) SELECT organisation_id, id, 'patient.read' FROM identity.role WHERE key = 'assistant'`,
    );
    await runApplyReferenceData({ db: wdb, orgId: ORG, jobId: 'job-3' });
    const keys = (
      await q(
        `SELECT permission_key FROM identity.role_permission rp JOIN identity.role r ON r.id = rp.role_id WHERE r.key = 'assistant' ORDER BY 1`,
      )
    ).map((r) => r['permission_key']);
    assert.deepEqual(keys, ['clinical.chart.read', 'clinical.list.write', 'clinical.note.write']);
  });

  test('it never moves a role to another realm', async () => {
    await sa.query(
      `UPDATE identity.role SET realm = 'admin_pool', privileged = true, location_bound = false WHERE key = 'assistant'`,
    );
    await assert.rejects(
      runApplyReferenceData({ db: wdb, orgId: ORG, jobId: 'job-4' }),
      /never changes realm/,
    );
    await sa.query(
      `UPDATE identity.role SET realm = 'google', privileged = false, location_bound = true WHERE key = 'assistant'`,
    );
  });

  test('only the worker, only as system, only for the organisation, may write the reference data', async () => {
    const c = new pg.Client({ connectionString: urlFor('app_api') });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.audience','staff',true), set_config('app.realm','admin_pool',true), set_config('app.org_id',$1,true)`,
        [ORG],
      );
      await assert.rejects(
        c.query(
          `INSERT INTO identity.permission (organisation_id, key, module, privileged, needs_elevation) VALUES ($1,'x.y.z','x',false,false)`,
          [ORG],
        ),
        (e: { code?: string }) => e.code === '42501',
      );
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    await assert.rejects(
      wdb.withScope(
        {
          audience: 'system',
          realm: 'worker',
          orgId: '00000000-0000-7000-8000-0000000000a2',
          jobScope: 'org',
        },
        (tx) =>
          tx.query(
            `INSERT INTO identity.permission (organisation_id, key, module, privileged, needs_elevation) VALUES ($1,'x.y.z','x',false,false)`,
            [ORG],
          ),
      ),
      (e: { code?: string }) => e.code === '42501',
    );
  });
});

describe('identity.purge_sessions', () => {
  const seed = async (
    label: string,
    o: { revokedAgo?: number; idleAgo: number; absoluteAgo: number },
  ): Promise<string> => {
    const pid = uuidv7();
    const personId = uuidv7();
    await sa.query('BEGIN');
    await sa.query(
      `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1,$2,$3)`,
      [personId, ORG, label],
    );
    await sa.query(
      `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject) VALUES ($1,$2,$3,'google',$4)`,
      [pid, ORG, personId, `s-${pid}`],
    );
    await sa.query('COMMIT');
    const sid = uuidv7();
    const h = (ms: number): Date => new Date(Date.now() - ms);
    const HOUR = 3_600_000;
    await sa.query(
      `INSERT INTO identity.session (id, organisation_id, token_hash, principal_id, person_id, realm, audience, auth_time, csrf_hash, idle_expires_at, absolute_expires_at, revoked_at, revoke_reason)
       VALUES ($1,$2,$3,$4,$5,'google','staff',$6,$3,$7,$8,$9,$10)`,
      [
        sid,
        ORG,
        // 32 bytes unique per session (sha-256 of the session id): a random single-byte fill collided (INT02-R10-N1).
        createHash('sha256').update(sid).digest(),
        pid,
        personId,
        h(30 * HOUR),
        h(o.idleAgo * HOUR),
        h(o.absoluteAgo * HOUR),
        o.revokedAgo === undefined ? null : h(o.revokedAgo * HOUR),
        o.revokedAgo === undefined ? null : 'sign_out',
      ],
    );
    return sid;
  };
  const exists = async (sid: string): Promise<boolean> =>
    (await n(`SELECT count(*) AS n FROM identity.session WHERE id = $1`, [sid])) === 1;

  test('deletes only sessions revoked or expired (idle or absolute) more than 24 hours ago', async () => {
    const oldRevoked = await seed('old revoked', { revokedAgo: 30, idleAgo: -5, absoluteAgo: -50 });
    const oldIdle = await seed('old idle', { idleAgo: 26, absoluteAgo: -5 });
    const oldAbsolute = await seed('old absolute', { idleAgo: 26, absoluteAgo: 25 });
    const recentRevoked = await seed('recent revoked', {
      revokedAgo: 2,
      idleAgo: -5,
      absoluteAgo: -50,
    });
    const recentIdle = await seed('recent idle', { idleAgo: 2, absoluteAgo: -5 });
    const live = await seed('live', { idleAgo: -1, absoluteAgo: -10 });
    const r = await runPurgeSessions({ db: wdb, orgId: ORG });
    assert.equal(r.deleted, 3);
    assert.deepEqual(
      [await exists(oldRevoked), await exists(oldIdle), await exists(oldAbsolute)],
      [false, false, false],
    );
    assert.deepEqual(
      [await exists(recentRevoked), await exists(recentIdle), await exists(live)],
      [true, true, true],
    );
  });

  test('a session with an unused, unexpired challenge row is kept until the challenge is gone (SAR-IDF-05)', async () => {
    const held = await seed('held', { revokedAgo: 30, idleAgo: -5, absoluteAgo: -50 });
    const free = await seed('free', { revokedAgo: 30, idleAgo: -5, absoluteAgo: -50 });
    const usedUp = await seed('used', { revokedAgo: 30, idleAgo: -5, absoluteAgo: -50 });
    await sa.query(
      `INSERT INTO identity.webauthn_challenge (id, organisation_id, purpose, session_id, challenge, expires_at, used_at)
       VALUES ($1, $5, 'elevation', $2, decode(repeat('ab', 32), 'hex'), now() + interval '20 minutes', NULL),
              ($3, $5, 'elevation', $4, decode(repeat('cd', 32), 'hex'), now() + interval '20 minutes', now())`,
      [uuidv7(), held, uuidv7(), usedUp, ORG],
    );
    const r = await runPurgeSessions({ db: wdb, orgId: ORG });
    assert.equal(r.deleted, 2);
    assert.equal(await exists(held), true);
    assert.equal(await exists(free), false);
    assert.equal(await exists(usedUp), false);
    // a challenge keeps its expiry (trigger), so "gone" is the row being removed, as the challenge purge does
    await sa.query(`DELETE FROM identity.webauthn_challenge`);
    assert.equal((await runPurgeSessions({ db: wdb, orgId: ORG })).deleted, 1);
    assert.equal(await exists(held), false);
  });
});
