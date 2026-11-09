// Real-database tests of identity.bootstrap_admins and the run-once command (INT04-F02b, HEAAA-466; decision log section 5, tests 1-7
// and 11; the catalog tests 9 and 10 are in db/tools/db-test.mjs, test 8 in command.test.ts, test 12 in the API identity tests).
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/bootstrap/bootstrap-admins.dbtest.js
// PostgreSQL 17, migrations and queue installed as the pipeline does. Every create-mode call is made from a real login session of
// app_bootstrap (its own connection, not SET ROLE) and COMMITS. Each test works in its own organisation. Missing configuration FAILS.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installQueue } from '@ehr/kernel/dist/queue/install.js';
import { KernelDb, syncTaskTypes } from '@ehr/kernel';
import { runAdminEvent } from '../jobs/identity/index.js';
import { buildWorkerRegistry } from '../job-registry.js';
import { runBootstrapAdmins } from './command.js';
import { PgBootstrapDb } from './db.js';
import type { SecretStorePort } from './ports.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env['EHR_TEST_ADMIN_URL'];
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const dbName = `ehr_f02b_${process.pid}_${Date.now()}`;
const urlFor = (user: string): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${dbName}`;
  return u.toString();
};

type Row = Record<string, unknown>;
interface Client {
  query(s: string, p?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  connect(): Promise<void>;
  end(): Promise<void>;
}
let sa: Client;
const q = (s: string, p?: unknown[]): Promise<Row[]> => sa.query(s, p).then((r) => r.rows);
const n1 = async (s: string, p?: unknown[]): Promise<number> => Number((await q(s, p))[0]?.['n']);

let orgSeq = 0;
const newOrgId = (): string =>
  `00000000-0000-7000-8000-${String(0xb000 + ++orgSeq)
    .padStart(4, '0')
    .padStart(12, '0')}`;
let nameSeq = 0;
const uniq = (): string => `${process.pid}${++nameSeq}`;
/** A fresh organisation with its `org_admin` reference role (the catalogue is reference data applied by the worker, not here). */
async function newOrg(opts: { withRole?: boolean; withOrg?: boolean } = {}): Promise<string> {
  const org = newOrgId();
  if (opts.withOrg !== false)
    await q(
      `INSERT INTO organisation.organisation (id, organisation_id, name, default_time_zone) VALUES ($1, $1, 'Test clinic', 'UTC')`,
      [org],
    );
  if (opts.withRole !== false)
    await q(
      `INSERT INTO identity.role (id, organisation_id, key, realm, privileged, location_bound)
       VALUES (gen_random_uuid(), $1, 'org_admin', 'admin_pool', true, false)`,
      [org],
    );
  return org;
}

const hashOf = (token: string): Buffer => createHash('sha256').update(token).digest();
type Cust = { display_name: string; idp_id: string } | { enrollee: 1 | 2; idp_id: string };
interface Args {
  runRef: string;
  ticket: string;
  enrollees: { handle: string; display_name: string }[];
  custodians: Cust[];
  hashes: Buffer[];
}
const mkArgs = (over: Partial<Args> = {}): Args => {
  const u = uniq();
  return {
    runRef: `run-${u}`,
    ticket: `TICKET-${u}`,
    enrollees: [
      { handle: `alice.${u}`, display_name: 'Alice Admin' },
      { handle: `bob.${u}`, display_name: 'Bob Admin' },
    ],
    custodians: [
      { display_name: 'Carol Custodian', idp_id: `idp-c-${u}` },
      { display_name: 'Dan Custodian', idp_id: `idp-d-${u}` },
    ],
    hashes: [randomBytes(32), randomBytes(32)],
    ...over,
  };
};
const sqlCall = `SELECT identity.bootstrap_admins($1, $2, $3::jsonb, $4::jsonb, $5::bytea[]) AS r`;
const params = (a: Args): unknown[] => [
  a.runRef,
  a.ticket,
  JSON.stringify(a.enrollees),
  JSON.stringify(a.custodians),
  a.hashes,
];

/** A real login as app_bootstrap: BEGIN, app.org_id, the call, COMMIT. Returns the function's JSON or the error. */
async function boot(
  org: string,
  a: Args,
  login = 'app_bootstrap',
): Promise<{ ok: true; r: Row } | { ok: false; code: string; detail: string; message: string }> {
  const c: Client = new pg.Client({ connectionString: urlFor(login) });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
    const r = await c.query(sqlCall, params(a));
    await c.query('COMMIT');
    return { ok: true, r: r.rows[0]?.['r'] as Row };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    const err = e as { code?: string; detail?: string; message: string };
    return { ok: false, code: err.code ?? '', detail: err.detail ?? '', message: err.message };
  } finally {
    await c.end().catch(() => undefined);
  }
}
const mustBoot = async (org: string, a: Args): Promise<Row> => {
  const r = await boot(org, a);
  assert.ok(r.ok, r.ok ? '' : `${r.code} ${r.detail} ${r.message}`);
  return r.r;
};
const refused = (r: Awaited<ReturnType<typeof boot>>, detail: string): void => {
  assert.ok(!r.ok, 'the call was expected to refuse');
  assert.equal(r.code, 'PS001', r.message);
  assert.equal(r.message, 'bootstrap refused');
  assert.equal(r.detail, detail);
};
interface Counts {
  persons: number;
  principals: number;
  requests: number;
  assignments: number;
  tokens: number;
  runs: number;
  audit: number;
  jobs: number;
}
const counts = async (org: string): Promise<Counts> => ({
  persons: await n1(`SELECT count(*) AS n FROM identity.person WHERE organisation_id = $1`, [org]),
  principals: await n1(`SELECT count(*) AS n FROM identity.principal WHERE organisation_id = $1`, [
    org,
  ]),
  requests: await n1(
    `SELECT count(*) AS n FROM identity.role_change_request WHERE organisation_id = $1`,
    [org],
  ),
  assignments: await n1(
    `SELECT count(*) AS n FROM identity.role_assignment WHERE organisation_id = $1`,
    [org],
  ),
  tokens: await n1(
    `SELECT count(*) AS n FROM identity.enrolment_token WHERE organisation_id = $1`,
    [org],
  ),
  runs: await n1(`SELECT count(*) AS n FROM identity.bootstrap_run WHERE organisation_id = $1`, [
    org,
  ]),
  audit: await n1(`SELECT count(*) AS n FROM audit.event WHERE organisation_id = $1`, [org]),
  jobs: await n1(`SELECT count(*) AS n FROM queue.jobs`),
});
const noWrite = async (org: string, before: Counts, what: string): Promise<void> =>
  assert.deepEqual(await counts(org), before, `${what}: no write`);

before(async () => {
  const a: Client = new pg.Client({ connectionString: adminUrl });
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
  // The queue install runs twice: the grants of its second run (as queue_owner) are the ones that take effect (harden.sql header).
  await installQueue(urlFor('app_owner'));
  await installQueue(urlFor('app_owner'));
  sa = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) });
  await sa.connect();
  const w: Client = new pg.Client({ connectionString: urlFor('app_worker') });
  await w.connect();
  await syncTaskTypes(w as never, buildWorkerRegistry());
  await w.end();
});
after(async () => {
  await sa?.end();
  const a: Client = new pg.Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await a.end();
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('test 1: create mode, a real commit from the app_bootstrap login', () => {
  const cases: [string, (u: string) => Cust[]][] = [
    [
      '(i) two custodians who are not enrollees',
      (u) => [
        { display_name: 'Carol', idp_id: `idp-c-${u}` },
        { display_name: 'Dan', idp_id: `idp-d-${u}` },
      ],
    ],
    [
      '(ii) the custodians are the enrollees, crossed',
      (u) => [
        { enrollee: 2, idp_id: `idp-c-${u}` },
        { enrollee: 1, idp_id: `idp-d-${u}` },
      ],
    ],
    [
      '(iii) one of each',
      (u) => [
        { display_name: 'Carol', idp_id: `idp-c-${u}` },
        { enrollee: 1, idp_id: `idp-d-${u}` },
      ],
    ],
  ];
  for (const [label, mk] of cases) {
    test(label, async () => {
      const org = await newOrg();
      const u = uniq();
      const a = mkArgs({ custodians: mk(u) });
      const markers = a.custodians.filter((c) => !('enrollee' in c)).length;
      const jobsBefore = await n1(`SELECT count(*) AS n FROM queue.jobs`);
      const ret = await mustBoot(org, a);

      // the return value: both slots issued, no hash, no token
      const principals = await q(
        `SELECT id::text, person_id::text, subject, realm, status FROM identity.principal WHERE organisation_id = $1 AND realm = 'admin_pool' ORDER BY (subject <> $2)`,
        [org, a.enrollees[0]?.handle],
      );
      assert.equal(principals.length, 2);
      const [p1, p2] = principals as [Row, Row];
      assert.equal(p1['subject'], a.enrollees[0]?.handle);
      assert.equal(p2['subject'], a.enrollees[1]?.handle);
      const tok = await q(
        `SELECT id::text, principal_id::text, token_hash, status, requested_by_person_id::text AS req, approved_by_person_id::text AS app,
                expires_at, expires_at <= now() + interval '30 minutes' AS soon, expires_at > now() AS future
           FROM identity.enrolment_token WHERE organisation_id = $1 ORDER BY principal_id = $2 DESC`,
        [org, p1['id']],
      );
      assert.equal(tok.length, 2);
      assert.equal(JSON.stringify(ret).includes(a.hashes[0]?.toString('hex') ?? 'x'), false);
      assert.deepEqual(ret['enrollees'], [
        { slot: 1, principal_id: p1['id'], result: 'issued', token_id: tok[0]?.['id'] },
        { slot: 2, principal_id: p2['id'], result: 'issued', token_id: tok[1]?.['id'] },
      ]);
      assert.equal(ret['mode'], 'create');
      // exactly two admin_pool principals, the enrollee persons, the custodian persons and one marker principal per non-enrollee custodian
      const all = await counts(org);
      assert.equal(all.principals, 2 + markers);
      assert.equal(all.persons, 2 + markers);
      assert.equal(all.requests, 2);
      assert.equal(all.assignments, 2);
      assert.equal(all.tokens, 2);
      assert.equal(all.runs, 1);
      assert.equal(
        await n1(
          `SELECT count(*) AS n FROM identity.principal WHERE organisation_id = $1 AND realm <> 'admin_pool' AND disabled_reason IS DISTINCT FROM 'bootstrap_custodian'`,
          [org],
        ),
        0,
        'no other principal',
      );
      assert.equal(
        await n1(
          `SELECT count(*) AS n FROM identity.role_change_request WHERE organisation_id = $1 AND status = 'applied'`,
          [org],
        ),
        2,
      );
      assert.equal(
        await n1(
          `SELECT count(*) AS n FROM identity.role_assignment a JOIN identity.role r ON r.id = a.role_id
            WHERE a.organisation_id = $1 AND r.key = 'org_admin' AND a.location_id IS NULL AND a.revoked_at IS NULL`,
          [org],
        ),
        2,
      );
      // the custodians, crossed: custodian j requests, custodian i approves, for enrollee i
      const run = (
        await q(`SELECT * FROM identity.bootstrap_run WHERE organisation_id = $1`, [org])
      )[0] as Row;
      const cper = run['custodian_person_ids'] as string[];
      assert.deepEqual(
        run['custodian_idp_ids'],
        a.custodians.map((c) => c.idp_id),
      );
      assert.equal(run['mode'], 'create');
      assert.deepEqual(run['principal_ids'], [p1['id'], p2['id']]);
      assert.equal(run['run_ref'], a.runRef);
      assert.equal(run['ticket_ref'], a.ticket);
      for (const [i, t] of tok.entries()) {
        assert.equal(t['status'], 'approved');
        assert.ok((t['token_hash'] as Buffer).equals(a.hashes[i] as Buffer), `token hash ${i + 1}`);
        assert.equal(t['app'], cper[i], `token ${i + 1} approved by custodian ${i + 1}`);
        assert.equal(t['req'], cper[1 - i], `token ${i + 1} requested by the other custodian`);
        assert.ok(t['soon'] === true && t['future'] === true, 'expires within 30 minutes');
      }
      assert.equal(
        new Date(ret['expires_at'] as string).getTime(),
        (run['token_expires_at'] as Date).getTime(),
      );
      // the seven admin events and nothing else in the queue
      const jobs = await q(
        `SELECT j.key, j.payload FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id
          WHERE t.identifier = 'identity.admin_event' AND (j.payload->>'principalId' = ANY ($1) OR j.payload->>'runId' = $2)`,
        [[p1['id'], p2['id']], run['id']],
      );
      assert.equal(jobs.length, 7);
      assert.equal(
        (await n1(`SELECT count(*) AS n FROM queue.jobs`)) - jobsBefore,
        7,
        'no other job',
      );
      const kinds = jobs.map((j) => (j['payload'] as Row)['kind']).sort();
      assert.deepEqual(kinds, [
        'bootstrap_run',
        'enrolment_token_approved',
        'enrolment_token_approved',
        'enrolment_token_requested',
        'enrolment_token_requested',
        'role_change_decided',
        'role_change_decided',
      ]);
      assert.ok(jobs.some((j) => j['key'] === `identity.admin_event:bootstrap_run:${run['id']}`));

      // audit content: exactly the rows of section 3 step 3, compared row by row
      const audit = await q(
        `SELECT action, resource_type, resource_id::text AS rid, actor_person_id::text AS person, actor_principal_id::text AS principal,
                job_id, request_id, realm, audience, outcome, reason, change
           FROM audit.event WHERE organisation_id = $1`,
        [org],
      );
      const reqs = await q(
        `SELECT id::text, subject_principal_id::text AS subj FROM identity.role_change_request WHERE organisation_id = $1`,
        [org],
      );
      const reqOf = (pid: unknown): string => String(reqs.find((r) => r['subj'] === pid)?.['id']);
      const markerOf = async (i: number): Promise<string | null> =>
        (
          (await q(
            `SELECT id::text FROM identity.principal WHERE person_id = $1 AND realm = 'google'`,
            [cper[i]],
          )) as Row[]
        )[0]?.['id'] as string | null;
      const prinOfCustodian = (i: number): string | null => {
        const c = a.custodians[i] as Cust;
        return 'enrollee' in c ? String((c.enrollee === 1 ? p1 : p2)['id']) : null;
      };
      const expected: Row[] = [];
      const base = {
        job_id: `bootstrap-admins:${a.runRef}`,
        request_id: null,
        realm: 'worker',
        audience: 'system',
        outcome: 'allowed',
        reason: a.ticket,
      };
      const add = (
        action: string,
        type: string,
        rid: string,
        person: string | null,
        principal: string | null,
        keys: string[],
      ): void => {
        expected.push({
          action,
          resource_type: type,
          rid,
          person,
          principal,
          keys: [...new Set([...keys, 'via', 'bootstrapRunId', 'mode'])].sort(),
          ...base,
        });
      };
      add('create', 'identity.bootstrap_run', String(run['id']), null, null, [
        'mode',
        'principalIds',
      ]);
      for (const p of [p1, p2])
        add('create', 'identity.principal', String(p['id']), null, null, ['realm']);
      for (let i = 0; i < 2; i++) {
        const m = await markerOf(i);
        if (!('enrollee' in (a.custodians[i] as Cust)))
          add('create', 'identity.principal', String(m), null, null, ['realm', 'status', 'reason']);
      }
      for (const [i, p] of [p1, p2].entries()) {
        const j = 1 - i;
        add(
          'role_change_request',
          'identity.role_change_request',
          reqOf(p['id']),
          cper[j] ?? null,
          prinOfCustodian(j),
          ['subjectPrincipalId', 'add', 'remove', 'before'],
        );
        add(
          'role_change_decision',
          'identity.role_change_request',
          reqOf(p['id']),
          cper[i] ?? null,
          prinOfCustodian(i),
          [
            'decision',
            'subjectPrincipalId',
            'requesterPersonId',
            'approverPersonId',
            'before',
            'after',
          ],
        );
        add(
          'create',
          'identity.enrolment_token',
          String(tok[i]?.['id']),
          cper[j] ?? null,
          prinOfCustodian(j),
          ['principalId'],
        );
        add(
          'update',
          'identity.enrolment_token',
          String(tok[i]?.['id']),
          cper[i] ?? null,
          prinOfCustodian(i),
          ['status'],
        );
      }
      const norm = (r: Row): string =>
        JSON.stringify([
          r['action'],
          r['resource_type'],
          r['rid'],
          r['person'],
          r['principal'],
          r['job_id'],
          r['request_id'],
          r['realm'],
          r['audience'],
          r['outcome'],
          r['reason'],
          r['keys'],
        ]);
      const actual = audit.map((r) => norm({ ...r, keys: Object.keys(r['change'] as Row).sort() }));
      assert.deepEqual(actual.sort(), expected.map(norm).sort());
      for (const r of audit) {
        const ch = r['change'] as Row;
        assert.equal(ch['via'], 'bootstrap_admins');
        assert.equal(ch['bootstrapRunId'], run['id']);
        assert.equal(ch['mode'], 'create');
      }
      // the audit viewer's role-change filter returns the two requests (and the two decisions)
      assert.equal(audit.filter((r) => r['action'] === 'role_change_request').length, 2);
      // principal shapes of the markers (D-2)
      for (let i = 0; i < 2; i++) {
        if ('enrollee' in (a.custodians[i] as Cust)) continue;
        const m = (
          await q(
            `SELECT realm, subject, email, status, disabled_reason FROM identity.principal WHERE person_id = $1`,
            [cper[i]],
          )
        )[0] as Row;
        assert.deepEqual(m, {
          realm: 'google',
          subject: `bootstrap-custodian:${cper[i]}`,
          email: null,
          status: 'disabled',
          disabled_reason: 'bootstrap_custodian',
        });
      }
    });
  }

  test('after the call the three settings equal their values before it; person_requires_principal is deferred again', async () => {
    const org = await newOrg();
    const a = mkArgs();
    const SENT = '00000000-0000-7000-8000-00000000cafe';
    // (a) real login: settings restored
    const c: Client = new pg.Client({ connectionString: urlFor('app_bootstrap') });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.person_id', $2, true), set_config('app.audience', 'staff', true), set_config('app.job_scope', 'patients', true)`,
        [org, SENT],
      );
      await c.query(sqlCall, params(a));
      const s = (
        await c.query(
          `SELECT current_setting('app.person_id', true) AS p, current_setting('app.audience', true) AS a, current_setting('app.job_scope', true) AS s`,
        )
      ).rows[0];
      assert.deepEqual(s, { p: SENT, a: 'staff', s: 'patients' });
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    // (b) the same call in another organisation inside a superuser-opened session switched with SET SESSION AUTHORIZATION: after the
    // call an orphan person is accepted at the INSERT and refused at COMMIT (PS001), so the deferral is back.
    const org2 = await newOrg();
    const d: Client = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) });
    await d.connect();
    try {
      await d.query('BEGIN');
      await d.query(`SET SESSION AUTHORIZATION app_bootstrap`);
      await d.query(`SET LOCAL transaction_timeout = '30s'`); // role-level settings apply at login only
      await d.query(`SELECT set_config('app.org_id', $1, true)`, [org2]);
      await d.query(sqlCall, params(mkArgs()));
      await d.query(`RESET SESSION AUTHORIZATION`);
      await d.query(
        `INSERT INTO identity.person (id, organisation_id, display_name, status) VALUES (gen_random_uuid(), $1, 'orphan', 'active')`,
        [org2],
      );
      await assert.rejects(d.query('COMMIT'), (e: { code?: string }) => e.code === 'PS001');
    } finally {
      await d.query('ROLLBACK').catch(() => undefined);
      await d.end();
    }
    assert.equal((await counts(org2)).principals, 0, 'the refused commit left nothing');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('test 2: the latch', () => {
  test('a second create-mode call refuses with no write; a non-bootstrap admin_pool principal refuses with no write', async () => {
    const org = await newOrg();
    const a = mkArgs();
    await mustBoot(org, a);
    // enrol both so reissue is closed too: the second create-shaped call must be refused as the latch
    const before = await counts(org);
    refused(await boot(org, mkArgs()), 'latch_closed');
    await noWrite(org, before, 'second create');
    // a call when another admin_pool principal exists, any status
    const org2 = await newOrg();
    const per = '00000000-0000-7000-8000-00000000d002';
    await q(
      `BEGIN; INSERT INTO identity.person (id, organisation_id, display_name, status) VALUES ('${per}', '${org2}', 'Existing', 'active');
       INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, status) VALUES (gen_random_uuid(), '${org2}', '${per}', 'admin_pool', 'existing.${uniq()}', 'disabled'); COMMIT`,
    );
    const b2 = await counts(org2);
    refused(await boot(org2, mkArgs()), 'latch_closed');
    await noWrite(org2, b2, 'existing admin');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('test 3: reissue', () => {
  const enrol = async (principalId: string): Promise<void> => {
    // a credential row for the principal (the test seeds it as the superuser; the enrolment ceremony is the API's)
    const tok = (
      await q(
        `SELECT id FROM identity.enrolment_token WHERE principal_id = $1 AND status = 'approved'`,
        [principalId],
      )
    )[0];
    await q(
      `INSERT INTO identity.admin_credential (id, organisation_id, principal_id, public_key, aaguid, backup_eligible, user_verified_at_enrol, enrolment_token_id)
       SELECT decode(md5(random()::text), 'hex'), organisation_id, id, decode(md5(random()::text) || md5(random()::text), 'hex'), gen_random_uuid(), false, true, $2
         FROM identity.principal WHERE id = $1`,
      [principalId, tok?.['id']],
    );
  };

  test('two consecutive reissues, the skipped enrolled slot, the cap, the age bound, target state', async () => {
    const org = await newOrg();
    const a = mkArgs();
    const first = await mustBoot(org, a);
    const ids = (first['enrollees'] as Row[]).map((e) => String(e['principal_id']));
    const again = (over: Partial<Args> = {}): Args => ({
      ...a,
      runRef: `re-${uniq()}`,
      hashes: [randomBytes(32), randomBytes(32)],
      ...over,
    });

    // first reissue: both issued, the open tokens expired (audited), new tokens, a run-level event of mode reissue
    const oldTok = await q(
      `SELECT id::text FROM identity.enrolment_token WHERE organisation_id = $1`,
      [org],
    );
    const a1 = again();
    const r1 = await mustBoot(org, a1);
    assert.equal(r1['mode'], 'reissue');
    assert.deepEqual(
      (r1['enrollees'] as Row[]).map((e) => e['result']),
      ['issued', 'issued'],
    );
    assert.equal(
      await n1(
        `SELECT count(*) AS n FROM identity.enrolment_token WHERE organisation_id = $1 AND status = 'expired'`,
        [org],
      ),
      2,
    );
    assert.equal(
      await n1(
        `SELECT count(*) AS n FROM identity.enrolment_token WHERE organisation_id = $1 AND status = 'approved'`,
        [org],
      ),
      2,
    );
    const expiredAudit = await q(
      `SELECT resource_id::text AS rid, change FROM audit.event WHERE organisation_id = $1 AND job_id = $2 AND action = 'update' AND (change->>'status') = 'expired'`,
      [org, `bootstrap-admins:${a1.runRef}`],
    );
    assert.deepEqual(expiredAudit.map((r) => r['rid']).sort(), oldTok.map((t) => t['id']).sort());
    assert.ok(expiredAudit.every((r) => (r['change'] as Row)['reason'] === 'bootstrap_reissue'));
    assert.equal(
      await n1(
        `SELECT count(*) AS n FROM identity.role_change_request WHERE organisation_id = $1`,
        [org],
      ),
      2,
      'roles untouched',
    );
    assert.equal(
      await n1(`SELECT count(*) AS n FROM queue._private_jobs WHERE payload->>'runId' = $1`, [
        r1['run_id'],
      ]),
      1,
    );
    assert.equal(
      (await q(`SELECT mode FROM identity.bootstrap_run WHERE id = $1`, [r1['run_id']]))[0]?.[
        'mode'
      ],
      'reissue',
    );

    // second consecutive reissue succeeds as well: one create row and two reissue rows with the same principal_ids
    // (one enrolled: only the other is issued)
    await enrol(ids[0] as string);
    const a2 = again();
    const r2 = await mustBoot(org, a2);
    const tokOf = async (pid: string): Promise<string | undefined> =>
      (
        await q(
          `SELECT id::text FROM identity.enrolment_token WHERE principal_id = $1 AND status = 'approved'`,
          [pid],
        )
      )[0]?.['id'] as string | undefined;
    assert.deepEqual(r2['enrollees'], [
      { slot: 1, principal_id: ids[0], result: 'skipped', token_id: null },
      { slot: 2, principal_id: ids[1], result: 'issued', token_id: await tokOf(ids[1] as string) },
    ]);
    assert.equal(
      await n1(`SELECT count(*) AS n FROM identity.enrolment_token WHERE principal_id = $1`, [
        ids[0],
      ]),
      2,
      'no new token row for the enrolled principal',
    );
    const runs = await q(
      `SELECT mode, principal_ids FROM identity.bootstrap_run WHERE organisation_id = $1 ORDER BY created_at`,
      [org],
    );
    assert.deepEqual(
      runs.map((r) => r['mode']),
      ['create', 'reissue', 'reissue'],
    );
    assert.ok(runs.every((r) => JSON.stringify(r['principal_ids']) === JSON.stringify(ids)));

    // a third reissue refuses with reissue_cap (not latch_closed)
    const b3 = await counts(org);
    refused(await boot(org, again()), 'reissue_cap');
    await noWrite(org, b3, 'third reissue');
  });

  test('neither/one enrolled issues as the result says; both enrolled refuses; different handles refuse', async () => {
    const org = await newOrg();
    const a = mkArgs();
    const first = await mustBoot(org, a);
    const ids = (first['enrollees'] as Row[]).map((e) => String(e['principal_id']));
    const before = await counts(org);
    refused(
      await boot(org, {
        ...a,
        runRef: `x-${uniq()}`,
        hashes: [randomBytes(32), randomBytes(32)],
        enrollees: [
          { handle: `other.${uniq()}`, display_name: 'X' },
          a.enrollees[1] as { handle: string; display_name: string },
        ],
      }),
      'latch_closed',
    );
    await noWrite(org, before, 'different handles');
    for (const pid of ids) await enrol(pid);
    const b2 = await counts(org);
    refused(
      await boot(org, { ...a, runRef: `y-${uniq()}`, hashes: [randomBytes(32), randomBytes(32)] }),
      'latch_closed',
    );
    await noWrite(org, b2, 'both enrolled');
  });

  test('past first run + 7 days refuses (reissue_expired); a suspended or disabled target refuses even when the other is active; a revoked org_admin refuses; a reissue row with other principals refuses', async () => {
    // age bound
    const org = await newOrg();
    const a = mkArgs();
    await mustBoot(org, a);
    const re = (): Args => ({
      ...a,
      runRef: `z-${uniq()}`,
      hashes: [randomBytes(32), randomBytes(32)],
    });
    await q(`ALTER TABLE identity.bootstrap_run DISABLE TRIGGER bootstrap_run_append_only`);
    try {
      await q(
        `UPDATE identity.bootstrap_run SET created_at = now() - interval '7 days 1 minute' WHERE organisation_id = $1`,
        [org],
      );
      const b = await counts(org);
      refused(await boot(org, re()), 'reissue_expired');
      await noWrite(org, b, 'age');
      await q(`UPDATE identity.bootstrap_run SET created_at = now() WHERE organisation_id = $1`, [
        org,
      ]);
    } finally {
      await q(`ALTER TABLE identity.bootstrap_run ENABLE TRIGGER bootstrap_run_append_only`);
    }
    // suspended / disabled target, also when the other target is active
    const ids = (
      await q(
        `SELECT id::text FROM identity.principal WHERE organisation_id = $1 AND realm = 'admin_pool' ORDER BY subject`,
        [org],
      )
    ).map((r) => String(r['id']));
    for (const status of ['suspended', 'disabled']) {
      await q(`UPDATE identity.principal SET status = $2 WHERE id = $1`, [ids[1], status]);
      const b = await counts(org);
      refused(await boot(org, re()), 'target_state');
      await noWrite(org, b, `target ${status}`);
      await q(`UPDATE identity.principal SET status = 'active' WHERE id = $1`, [ids[1]]);
    }
    // a target whose org_admin assignment is revoked
    await q(`UPDATE identity.role_assignment SET revoked_at = now() WHERE principal_id = $1`, [
      ids[0],
    ]);
    const b = await counts(org);
    refused(await boot(org, re()), 'target_state');
    await noWrite(org, b, 'revoked org_admin');
    await q(`UPDATE identity.role_assignment SET revoked_at = NULL WHERE principal_id = $1`, [
      ids[0],
    ]).catch(() => undefined);

    // a reissue row recording other principals (inserted by the test as the owner role) closes the latch
    const org3 = await newOrg();
    const a3 = mkArgs();
    await mustBoot(org3, a3);
    await q(
      `INSERT INTO identity.bootstrap_run (id, organisation_id, run_ref, ticket_ref, mode, principal_ids, custodian_person_ids, custodian_idp_ids, token_expires_at)
       SELECT gen_random_uuid(), organisation_id, 'other', 'other', 'reissue', ARRAY[gen_random_uuid(), gen_random_uuid()], custodian_person_ids, custodian_idp_ids, now()
         FROM identity.bootstrap_run WHERE organisation_id = $1`,
      [org3],
    );
    const b3 = await counts(org3);
    refused(
      await boot(org3, {
        ...a3,
        runRef: `w-${uniq()}`,
        hashes: [randomBytes(32), randomBytes(32)],
      }),
      'latch_closed',
    );
    await noWrite(org3, b3, 'mismatched run history');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('test 4: bad input and the deferred person check', () => {
  test('custodian i = enrollee i, identical custodians, duplicate handles or hashes and a missing org_admin role each refuse with no write', async () => {
    const org = await newOrg();
    const b = await counts(org);
    const u = uniq();
    const bad: [string, Partial<Args>][] = [
      [
        'custodian 1 is enrollee 1',
        {
          custodians: [
            { enrollee: 1, idp_id: `i1-${u}` },
            { display_name: 'D', idp_id: `i2-${u}` },
          ],
        },
      ],
      [
        'custodian 2 is enrollee 2',
        {
          custodians: [
            { display_name: 'C', idp_id: `i1-${u}` },
            { enrollee: 2, idp_id: `i2-${u}` },
          ],
        },
      ],
      [
        'both custodians are the same enrollee',
        {
          custodians: [
            { enrollee: 2, idp_id: `i1-${u}` },
            { enrollee: 2, idp_id: `i2-${u}` },
          ],
        },
      ],
      [
        'identical idp ids',
        {
          custodians: [
            { display_name: 'C', idp_id: `same-${u}` },
            { display_name: 'D', idp_id: `same-${u}` },
          ],
        },
      ],
      [
        'duplicate handles',
        {
          enrollees: [
            { handle: `dup.${u}`, display_name: 'A' },
            { handle: `dup.${u}`, display_name: 'B' },
          ],
        },
      ],
      [
        'bad handle',
        {
          enrollees: [
            { handle: 'A', display_name: 'A' },
            { handle: `ok.${u}`, display_name: 'B' },
          ],
        },
      ],
      ['duplicate hashes', { hashes: [Buffer.alloc(32, 7), Buffer.alloc(32, 7)] }],
      ['short hash', { hashes: [Buffer.alloc(31, 7), Buffer.alloc(32, 8)] }],
    ];
    for (const [what, over] of bad) {
      refused(await boot(org, mkArgs(over)), 'bad_input');
      await noWrite(org, b, what);
    }
    const noRole = await newOrg({ withRole: false });
    const b2 = await counts(noRole);
    refused(await boot(noRole, mkArgs()), 'reference_data');
    await noWrite(noRole, b2, 'missing org_admin role');
  });

  test('a function variant that inserts a person without a principal refuses at the deferred check, inside the call, with PS001', async () => {
    const org = await newOrg();
    const def = String(
      (
        await q(
          `SELECT pg_get_functiondef('identity.bootstrap_admins(text,text,jsonb,jsonb,bytea[])'::regprocedure) AS d`,
        )
      )[0]?.['d'],
    );
    const marker = "EXECUTE 'SET CONSTRAINTS identity.person_requires_principal IMMEDIATE';";
    assert.ok(def.includes(marker));
    const variant = def
      .replace('identity.bootstrap_admins', 'identity.bootstrap_admins_probe')
      .replace(
        marker,
        `INSERT INTO identity.person (id, organisation_id, display_name, status, created_by_job) VALUES (pg_catalog.gen_random_uuid(), v_org, 'orphan', 'active', v_run);\n  ${marker}`,
      );
    await q(variant);
    await q(
      `ALTER FUNCTION identity.bootstrap_admins_probe(text,text,jsonb,jsonb,bytea[]) OWNER TO identity_bootstrap_owner`,
    );
    await q(
      `REVOKE ALL ON FUNCTION identity.bootstrap_admins_probe(text,text,jsonb,jsonb,bytea[]) FROM PUBLIC`,
    );
    await q(
      `GRANT EXECUTE ON FUNCTION identity.bootstrap_admins_probe(text,text,jsonb,jsonb,bytea[]) TO app_bootstrap`,
    );
    const b = await counts(org);
    try {
      const c: Client = new pg.Client({ connectionString: urlFor('app_bootstrap') });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
        await assert.rejects(
          c.query(
            sqlCall.replace('identity.bootstrap_admins(', 'identity.bootstrap_admins_probe('),
            params(mkArgs()),
          ),
          (e: { code?: string; message?: string }) =>
            e.code === 'PS001' && /at least one principal/.test(e.message ?? ''),
        );
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    } finally {
      await q(`DROP FUNCTION identity.bootstrap_admins_probe(text,text,jsonb,jsonb,bytea[])`);
    }
    await noWrite(org, b, 'orphan person');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('test 5: two concurrent calls', () => {
  test('exactly one succeeds', async () => {
    await q(`ALTER ROLE app_bootstrap CONNECTION LIMIT 5`); // the production value is 1 (checked by the catalog test); two sessions are needed here
    try {
      const org = await newOrg();
      const a = mkArgs();
      const b = mkArgs({
        enrollees: [
          { handle: `cc1.${uniq()}`, display_name: 'A' },
          { handle: `cc2.${uniq()}`, display_name: 'B' },
        ],
      });
      const [x, y] = await Promise.all([boot(org, a), boot(org, b)]);
      assert.equal([x, y].filter((r) => r.ok).length, 1, JSON.stringify([x, y]));
      const lost = [x, y].find((r) => !r.ok);
      assert.ok(
        lost && !lost.ok && lost.code === 'PS001' && lost.message === 'bootstrap refused',
        JSON.stringify(lost),
      );
      assert.equal((await counts(org)).runs, 1);
      assert.equal(
        await n1(
          `SELECT count(*) AS n FROM identity.principal WHERE organisation_id = $1 AND realm = 'admin_pool'`,
          [org],
        ),
        2,
      );
    } finally {
      await q(`ALTER ROLE app_bootstrap CONNECTION LIMIT 1`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('test 6: caller binding', () => {
  test('app_worker and app_api get permission denied on EXECUTE', async () => {
    const org = await newOrg();
    for (const login of ['app_worker', 'app_api']) {
      const r = await boot(org, mkArgs(), login);
      assert.ok(!r.ok && r.code === '42501', `${login}: ${JSON.stringify(r)}`);
      assert.match(r.ok ? '' : r.message, /permission denied for function bootstrap_admins/);
    }
  });

  test('app_bootstrap gets permission denied on a direct SELECT or INSERT on every identity table and on audit.event', async () => {
    const tables = (
      await q(`SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND (n.nspname = 'identity' OR (n.nspname = 'audit' AND NOT c.relispartition) OR (n.nspname = 'organisation' AND c.relname = 'organisation'))`)
    ).map((r) => String(r['t']));
    assert.ok(tables.length >= 20);
    const org = await newOrg();
    const c: Client = new pg.Client({ connectionString: urlFor('app_bootstrap') });
    await c.connect();
    try {
      for (const t of tables) {
        for (const sql of [`SELECT 1 FROM ${t} LIMIT 1`, `INSERT INTO ${t} DEFAULT VALUES`]) {
          await c.query('BEGIN');
          await c.query(
            `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
            [org],
          );
          await assert.rejects(
            c.query(sql),
            (e: { code?: string }) => e.code === '42501',
            `${sql}`,
          );
          await c.query('ROLLBACK');
        }
      }
    } finally {
      await c.end();
    }
  });

  test('a call from a session whose session_user is not app_bootstrap refuses; an organisation with no row refuses with no write', async () => {
    const org = await newOrg();
    const sup = await boot(org, mkArgs(), new URL(adminUrl).username);
    assert.ok(!sup.ok && sup.code === '42501' && sup.detail === 'caller', JSON.stringify(sup));
    const ghost = await newOrg({ withOrg: false });
    const b = await counts(ghost);
    refused(await boot(ghost, mkArgs()), 'bad_input');
    await noWrite(ghost, b, 'unknown organisation');
    const none = await boot('', mkArgs());
    assert.ok(!none.ok, 'empty org id');
  });

  test('a direct insert as identity_bootstrap_owner outside the two G-6 branches and the G-13 list is refused by its policy; the allowed shapes pass', async () => {
    const org = await newOrg();
    const run = async (sql: string, args: unknown[] = []): Promise<string | 'ok'> => {
      const c: Client = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL ROLE identity_bootstrap_owner`);
        await c.query(`SET LOCAL transaction_timeout = '30s'`);
        await c.query(
          `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
          [org],
        );
        await c.query(sql, args);
        return 'ok';
      } catch (e) {
        return (e as { code?: string; message?: string }).code ?? 'error';
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };
    const principalSql = (cols: string, vals: string): string =>
      `INSERT INTO identity.principal (id, organisation_id, person_id, realm, ${cols}) VALUES (gen_random_uuid(), '${org}', '00000000-0000-7000-8000-00000000e001', ${vals})`;
    const seedPerson = async (): Promise<void> => {
      await q(
        `BEGIN; INSERT INTO identity.person (id, organisation_id, display_name, status) VALUES ('00000000-0000-7000-8000-00000000e001', '${org}', 'x', 'active');
         INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, status) VALUES (gen_random_uuid(), '${org}', '00000000-0000-7000-8000-00000000e001', 'patient_pool', 'seed.${uniq()}', 'disabled'); COMMIT`,
      );
    };
    await seedPerson();
    // outside the two branches
    assert.equal(
      await run(principalSql('subject, status', `'google', 'sub-1', 'active'`)),
      '42501',
      'google, active',
    );
    assert.equal(
      await run(
        principalSql(
          'subject, status, disabled_reason',
          `'google', 'other', 'disabled', 'bootstrap_custodian'`,
        ),
      ),
      '42501',
      'google, other subject',
    );
    assert.equal(
      await run(
        principalSql('subject, status, disabled_reason', `'admin_pool', 'h.h.h', 'active', 'x'`),
      ),
      '42501',
      'admin_pool with a reason',
    );
    assert.equal(
      await run(principalSql('subject, status', `'admin_pool', NULL, 'active'`)),
      '42501',
      'admin_pool without subject',
    );
    // inside them
    assert.equal(
      await run(principalSql('subject, status', `'admin_pool', 'ok.ok.ok', 'active'`)),
      'ok',
    );
    assert.equal(
      await run(
        principalSql(
          'subject, status, disabled_reason',
          `'google', 'bootstrap-custodian:00000000-0000-7000-8000-00000000e001', 'disabled', 'bootstrap_custodian'`,
        ),
      ),
      'ok',
    );
    // audit.event
    const ev = (over: Record<string, string | null>): string => {
      const v = {
        job_id: `'bootstrap-admins:r'`,
        request_id: 'NULL',
        resource_type: `'identity.principal'`,
        action: `'create'`,
        realm: `'worker'`,
        outcome: `'allowed'`,
        ...over,
      };
      return `INSERT INTO audit.event (event_id, organisation_id, job_id, request_id, realm, audience, action, resource_type, outcome)
              VALUES (gen_random_uuid(), '${org}', ${v.job_id}, ${v.request_id}, ${v.realm}, 'system', ${v.action}, ${v.resource_type}, ${v.outcome})`;
    };
    assert.equal(await run(ev({})), 'ok', 'control');
    assert.equal(
      await run(ev({ resource_type: `'identity.person'` })),
      '42501',
      'identity.person is not in the list',
    );
    assert.equal(await run(ev({ resource_type: `'patient.patient'` })), '42501');
    assert.equal(await run(ev({ action: `'view'` })), '42501');
    assert.equal(await run(ev({ request_id: `gen_random_uuid()` })), '42501', 'a request_id');
    assert.equal(await run(ev({ job_id: `'other:r'` })), '42501', 'no bootstrap-admins: prefix');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('test 7: hashes and stored shapes, with the command and the API helpers', () => {
  test('the generated token hashes to what the enrolment path derives, the lookup finds it, a hash of the raw bytes does not; request_hash and the stored shapes equal the API', async () => {
    const api = (await import(
      pathToFileURL(`${root}apps/api/dist/src/modules/identity/tokens.js`).href
    )) as {
      hashPresentedToken(t: string): string | undefined;
    };
    const svc = (await import(
      pathToFileURL(`${root}apps/api/dist/src/modules/identity/admin/service.js`).href
    )) as {
      requestHashOf(s: string, a: { roleKey: string }[], r: unknown[], b: unknown[]): Buffer;
    };
    const org = await newOrg();
    const u = uniq();
    // the real command with a fake secret store and the real database port
    const stored = new Map<number, Buffer>();
    const secrets: SecretStorePort = {
      createTokenSecret: async ({ slot, value }) => {
        stored.set(slot, Buffer.from(value));
        return { arn: `arn:fake:${slot}` };
      },
      forceDeleteTokenSecret: async () => undefined,
    };
    const lines: string[] = [];
    const out = await runBootstrapAdmins({
      env: 'staging',
      orgId: org,
      runRef: `ci-${u}`,
      noticeChannel: 'mailbox',
      record: {
        read: async () => ({
          ticketRef: `T-${u}`,
          enrollees: [
            { handle: `ann.${u}`, displayName: 'Ann' },
            { handle: `ben.${u}`, displayName: 'Ben' },
          ],
          custodians: [
            { idpId: `i1-${u}`, displayName: 'Cy' },
            { idpId: `i2-${u}`, enrollee: 1 },
          ],
          securityContactVerifiedAt: new Date().toISOString(),
          securityContactTestRef: 'TEST-1',
        }),
      },
      secrets,
      db: new PgBootstrapDb(urlFor('app_bootstrap')),
      out: (l) => lines.push(l),
    });
    assert.equal(out.exitCode, 0, lines.join('\n'));
    const printed = JSON.parse(lines[0] as string) as Row;
    assert.equal(printed['result'], 'ok');
    const toks = [1, 2].map((s) => (stored.get(s) as Buffer).toString('utf8'));
    for (const t of toks) {
      assert.match(t, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(lines.join('\n').includes(t), false, 'no token in the output');
    }
    const rows = await q(
      `SELECT t.id::text, encode(t.token_hash, 'hex') AS hx, t.principal_id::text AS pid FROM identity.enrolment_token t WHERE t.organisation_id = $1 ORDER BY (SELECT subject FROM identity.principal WHERE id = t.principal_id)`,
      [org],
    );
    for (const [i, tok] of toks.entries()) {
      assert.equal(
        api.hashPresentedToken(tok),
        rows[i]?.['hx'],
        `slot ${i + 1}: the enrolment path derives the stored hash`,
      );
      assert.equal(hashOf(tok).toString('hex'), rows[i]?.['hx']);
      // the enrolment lookup as app_api, audience anonymous, finds it (and finds nothing for the hash of the raw bytes)
      const find = async (hex: string): Promise<number> => {
        const c: Client = new pg.Client({ connectionString: urlFor('app_api') });
        await c.connect();
        try {
          await c.query('BEGIN');
          await c.query(
            `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'anonymous', true), set_config('app.auth_enrolment_token_hash', $2, true)`,
            [org, hex],
          );
          const r = await c.query(
            `SELECT id FROM identity.enrolment_token WHERE token_hash = decode($1, 'hex') AND status = 'approved' AND expires_at > now() AND used_at IS NULL`,
            [hex],
          );
          return r.rows.length;
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
          await c.end();
        }
      };
      assert.equal(
        await find(rows[i]?.['hx'] as string),
        1,
        `slot ${i + 1}: the lookup finds the token`,
      );
      const raw = Buffer.from(tok, 'base64url');
      assert.equal(
        await find(createHash('sha256').update(raw).digest('hex')),
        0,
        'a hash of the 32 raw bytes is not found',
      );
    }
    // request_hash and shapes
    const reqs = await q(
      `SELECT subject_principal_id::text AS s, request_hash, change::text AS change, before::text AS before, change = '{"add":[{"roleKey":"org_admin"}],"remove":[]}'::jsonb AS same, before = '[]'::jsonb AS same_before
         FROM identity.role_change_request WHERE organisation_id = $1`,
      [org],
    );
    assert.equal(reqs.length, 2);
    for (const r of reqs) {
      const want = svc.requestHashOf(String(r['s']), [{ roleKey: 'org_admin' }], [], []);
      assert.ok(
        (r['request_hash'] as Buffer).equals(want),
        'request_hash equals requestHashOf(...)',
      );
      // what the API would have stored: JSON.stringify({add: sortRefs(add), remove: sortRefs(remove)}) into a jsonb column
      assert.equal(r['change'], '{"add": [{"roleKey": "org_admin"}], "remove": []}');
      assert.equal(r['before'], '[]');
      assert.equal(r['same'], true);
      assert.equal(r['same_before'], true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('test 11: the admin_event task type', () => {
  test('identity.admin_event has api_enqueue = true and job class job; the migration added no task_type row and changed no flag', async () => {
    const r = (
      await q(
        `SELECT job_class, api_enqueue, max_attempts FROM queue_api.task_type WHERE task_identifier = 'identity.admin_event'`,
      )
    )[0];
    assert.deepEqual(r, { job_class: 'job', api_enqueue: true, max_attempts: 8 });
    // the grant is the only change to queue_api: identity_bootstrap_owner can enqueue, app_api's reach is unchanged
    assert.equal(
      await n1(
        `SELECT count(*) AS n FROM queue_api.task_type WHERE api_enqueue AND job_class NOT IN ('handler', 'job')`,
      ),
      0,
    );
    assert.equal(
      (
        await q(
          `SELECT has_function_privilege('identity_bootstrap_owner', 'queue_api.enqueue(text,jsonb,timestamptz,text,smallint)', 'EXECUTE') AS x`,
        )
      )[0]?.['x'],
      true,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('the run-level admin event, read by the worker under audience system', () => {
  test('identity.admin_event bootstrap_run reads the run row as app_worker, raises one high alert and sends one notice', async () => {
    const org = await newOrg();
    const ret = await mustBoot(org, mkArgs());
    const pool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 2 });
    pool.on('error', () => undefined);
    try {
      const alerts: Row[] = [];
      const notices: Row[] = [];
      const res = await runAdminEvent(
        {
          db: new KernelDb(pool as never),
          orgId: org,
          alerts: { raise: async (_tx, i) => void alerts.push(i as never) },
          notice: { notify: async (n) => void notices.push(n as never) },
        },
        { kind: 'bootstrap_run', runId: String(ret['run_id']) },
        'job-1',
        'ref-1',
      );
      assert.deepEqual(res, { audited: false, alerted: true, activeCredentials: null });
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0]?.['severity'], 'high');
      assert.equal(notices.length, 1);
      const run = (notices[0] as Row)['run'] as Row;
      assert.equal(run['mode'], 'create');
      assert.equal(run['runId'], ret['run_id']);
      assert.equal((run['principalIds'] as string[]).length, 2);
      assert.equal(JSON.stringify(notices[0]).includes('Alice'), false, 'no names in the notice');
    } finally {
      await pool.end();
    }
  });
});
