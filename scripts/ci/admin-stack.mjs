// Start script of the real-stack admin run (INT04-F22b). In ONE process it: creates the CI admin fixture (in memory), prepares the
// already-migrated database (queue library, task types, organisation, reference data, one admin principal with an approved
// enrolment token, one pending break-the-glass grant opened by someone else), starts the real API, the real worker and the BUILT
// staff app (`vite preview`, static files only) behind a per-run self-signed TLS front (https://staff.ci.test), runs scripts/ci/admin-run.mjs against them with the same fixture, and stops everything.
// The fixture must be shared with the driver: its attestation root is generated per run and only this process knows the leaf key.
//
// Usage (CI job `admin-run`, after `pnpm build` and scripts/ci/migration-check/prepare-db.sh ehr):
//   CI=true EHR_ENV=ci EHR_ADMIN_CI_FIXTURE=1 EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres \
//     node scripts/ci/admin-stack.mjs
//   node scripts/ci/admin-stack.mjs --selftest        (no database, no browser: checks the environment builders)
// Environment (names only):
//   EHR_TEST_ADMIN_URL    superuser URL of the job's throwaway PostgreSQL (required); database name from ADMIN_STACK_DB (default ehr).
//   ADMIN_STACK_PORT_API / _STAFF / _TLS   default 3000 / 4173 / 4443.   ADMIN_RUN_OUT   screenshots (default artifacts/admin-run).
//   ADMIN_STACK_LOGS      logs of the API, worker and preview (default reports/admin-run).
// Every key and token below is random per run, lives in this process and the children's environments only, and is never printed.
import { spawn, spawnSync } from 'node:child_process';
import { X509Certificate, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = new URL('../../', import.meta.url);
const path = (p) => new URL(p, root).pathname;
const ORG = '00000000-0000-7000-8000-0000000000a1'; // the organisation of the API tests; any UUID would do
const HANDLE = 'ci-admin';
// F27 (decision on HEAAA-513): the admin realm only accepts https://<EHR_STAFF_HOST>. The run serves exactly that origin (port 443)
// through a TLS front on loopback; the browser maps the name to the front (see scripts/ci/README.md, "Admin run").
export const CI_STAFF_HOST = 'staff.ci.test';
const CI_STAFF_ORIGIN = `https://${CI_STAFF_HOST}`;

/** Connection string for `role` on `database`, derived from the superuser URL (trust authentication, no password). */
export function urlFor(adminUrl, role, database) {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
}

/** Environment of the API and worker processes. `fixtureEnv` is `adminFixtureEnv()`; `keys` are random secrets. */
export function apiEnv({ adminUrl, database, apiPort, staffPort, fixtureEnv, keys, deployable }) {
  const staffHost = CI_STAFF_HOST;
  const staffOrigin = CI_STAFF_ORIGIN;
  const idp = 'http://127.0.0.1:9'; // nothing listens: staff and patient sign-in are not used by this run
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '/tmp',
    NODE_ENV: 'production',
    EHR_DEPLOYABLE: deployable,
    EHR_DATABASE_URL: urlFor(adminUrl, deployable === 'api' ? 'app_api' : 'app_worker', database),
    EHR_ORGANISATION_ID: ORG,
    EHR_MIN_CLIENT_RELEASE: '1',
    EHR_PORT: String(apiPort),
    EHR_STAFF_HOST: staffHost,
    EHR_PATIENT_HOST: 'localhost',
    EHR_ALLOWED_ORIGINS: staffOrigin,
    EHR_OIDC_STATE_KEY: keys.oidc,
    EHR_CSRF_KEY: keys.csrf,
    EHR_RATE_KEY: keys.rate,
    EHR_MATCH_CHECK_KEY: keys.match,
    EHR_CHECKIN_QR_KEY: keys.qr,
    EHR_STAFF_OIDC_CLIENT_ID: 'ci-staff',
    EHR_STAFF_OIDC_CLIENT_SECRET: keys.oidcClient,
    EHR_STAFF_OIDC_REDIRECT_URI: `${staffOrigin}/api/v1/auth/callback`,
    EHR_STAFF_WORKSPACE_DOMAIN: 'example.com',
    EHR_PATIENT_OIDC_ISSUER: idp,
    EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT: `${idp}/authorize`,
    EHR_PATIENT_OIDC_TOKEN_ENDPOINT: `${idp}/token`,
    EHR_PATIENT_OIDC_JWKS_URI: `${idp}/jwks`,
    EHR_PATIENT_OIDC_CLIENT_ID: 'ci-patient',
    EHR_PATIENT_OIDC_REDIRECT_URI: `http://localhost:${staffPort}/api/v1/auth/callback`,
    // Public fixture values only (root certificate, AAGUID, decoy key) plus EHR_ENV=ci and EHR_ADMIN_CI_FIXTURE=1. Only the API reads them.
    ...(deployable === 'api' ? fixtureEnv : { EHR_ENV: 'ci' }),
  };
}

export const randomKeys = () => {
  const k = () => randomBytes(32).toString('base64url');
  return {
    oidc: k(),
    csrf: k(),
    rate: k(),
    match: k(),
    qr: k(),
    oidcClient: k(),
    enrolment: randomBytes(32).toString('base64url'),
  };
};

function selftest() {
  const keys = randomKeys();
  const e = apiEnv({
    adminUrl: 'postgres://postgres@127.0.0.1:55432/postgres',
    database: 'ehr',
    apiPort: 3000,
    staffPort: 4173,
    fixtureEnv: { EHR_ENV: 'ci', EHR_ADMIN_CI_FIXTURE: '1', EHR_ADMIN_DECOY_KEY: 'd'.repeat(64) },
    keys,
    deployable: 'api',
  });
  assert.equal(e.EHR_DATABASE_URL, 'postgres://app_api@127.0.0.1:55432/ehr');
  assert.equal(e.EHR_ADMIN_CI_FIXTURE, '1');
  assert.equal(e.EHR_ENV, 'ci');
  assert.equal(e.EHR_STAFF_HOST, 'staff.ci.test');
  assert.equal(e.EHR_ALLOWED_ORIGINS, 'https://staff.ci.test');
  assert.ok(!e.EHR_ALLOWED_ORIGINS.includes('http://'), 'no http origin is allowed');
  assert.equal(e.EHR_STAFF_OIDC_REDIRECT_URI, 'https://staff.ci.test/api/v1/auth/callback');
  assert.notEqual(e.EHR_STAFF_HOST, e.EHR_PATIENT_HOST);
  const w = apiEnv({
    adminUrl: 'postgres://postgres@127.0.0.1:55432/postgres',
    database: 'ehr',
    apiPort: 3000,
    staffPort: 4173,
    fixtureEnv: { EHR_ADMIN_CI_FIXTURE: '1' },
    keys,
    deployable: 'worker',
  });
  assert.equal(w.EHR_DATABASE_URL, 'postgres://app_worker@127.0.0.1:55432/ehr');
  assert.equal(w.EHR_ADMIN_CI_FIXTURE, undefined, 'the worker never receives the fixture flag');
  for (const k of ['EHR_CSRF_KEY', 'EHR_RATE_KEY', 'EHR_OIDC_STATE_KEY'])
    assert.ok(e[k].length >= 32, `${k} is at least 32 characters`);
  assert.equal(new Set([keys.csrf, keys.rate, keys.oidc]).size, 3);
  console.log('admin-stack self-test: environments and key sizes ok');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, probe, seconds = 90) {
  for (let i = 0; i < seconds; i++) {
    if (await probe().catch(() => false)) return;
    await sleep(1000);
  }
  throw new Error(`${what} did not become ready within ${seconds} s`);
}

/** Per-run self-signed certificate for staff.ci.test (SAN only that name, 1 day). The key lives in memory; the temp dir is removed at once. */
export function generateCert() {
  const dir = mkdtempSync(join(tmpdir(), 'admin-tls-'));
  try {
    const r = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${CI_STAFF_HOST}`,
        '-addext',
        `subjectAltName=DNS:${CI_STAFF_HOST}`,
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { encoding: 'utf8' },
    );
    if (r.status !== 0)
      throw new Error(
        `openssl failed (exit ${r.status}): ${(r.stderr || '').trim().split('\n').pop()}`,
      );
    const key = readFileSync(join(dir, 'key.pem'), 'utf8');
    const cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    const spki = createHash('sha256')
      .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
    return { key, cert, spki };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STRIP = ['x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'forwarded'];

/** The TLS front: /api and /api/* go to the API (Host kept), everything else to vite preview (Host rewritten). Loopback only. */
export function startTlsFront({ key, cert, tlsPort, apiPort, staffPort, logFile }) {
  const log = createWriteStream(logFile);
  const server = https.createServer({ key, cert, minVersion: 'TLSv1.2' }, (req, res) => {
    const started = Date.now();
    const pathOnly = (req.url ?? '/').split('?')[0];
    const isApi = pathOnly === '/api' || pathOnly.startsWith('/api/');
    const headers = { ...req.headers };
    for (const h of STRIP) delete headers[h];
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? '127.0.0.1';
    if (!isApi) headers.host = `127.0.0.1:${staffPort}`;
    const up = http.request(
      {
        host: '127.0.0.1',
        port: isApi ? apiPort : staffPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
        res.on('close', () =>
          log.write(`${req.method} ${pathOnly} ${ur.statusCode} ${Date.now() - started}ms\n`),
        );
      },
    );
    up.on('error', () => {
      log.write(`${req.method} ${pathOnly} 502 ${Date.now() - started}ms\n`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('bad gateway');
    });
    req.pipe(up);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(tlsPort, '127.0.0.1', () =>
      resolve({
        server,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            log.end();
            server.closeAllConnections?.();
          }),
      }),
    );
  });
}

/** One GET through the front, trusting only this run's certificate; returns { status, body }. */
function frontGet(path, { cert, tlsPort }) {
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          host: '127.0.0.1',
          port: tlsPort,
          servername: CI_STAFF_HOST,
          ca: cert,
          path,
          headers: { host: CI_STAFF_HOST },
        },
        (r) => {
          let body = '';
          r.setEncoding('utf8');
          r.on('data', (d) => {
            if (body.length < 4096) body += d;
          });
          r.on('end', () => resolve({ status: r.statusCode, body }));
        },
      )
      .on('error', reject);
  });
}

async function main() {
  const adminUrl = process.env.EHR_TEST_ADMIN_URL;
  if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is required');
  const database = process.env.ADMIN_STACK_DB || 'ehr';
  const apiPort = Number(process.env.ADMIN_STACK_PORT_API || 3000);
  const staffPort = Number(process.env.ADMIN_STACK_PORT_STAFF || 4173);
  const tlsPort = Number(process.env.ADMIN_STACK_PORT_TLS || 4443);
  const logs = process.env.ADMIN_STACK_LOGS || 'reports/admin-run';
  mkdirSync(logs, { recursive: true });

  const { createAdminFixture } = await import('./admin-fixture/index.mjs');
  const fx = createAdminFixture(); // refuses unless CI=true, EHR_ADMIN_CI_FIXTURE=1 and EHR_ENV is ci or unset
  const keys = randomKeys();
  const common = { adminUrl, database, apiPort, staffPort, fixtureEnv: fx.adminFixtureEnv(), keys };
  const apiE = apiEnv({ ...common, deployable: 'api' });
  const workerE = apiEnv({ ...common, deployable: 'worker' });

  const children = [];
  const start = (name, cmd, args, env, cwd = path('')) => {
    const log = createWriteStream(`${logs}/${name}.log`);
    const c = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.pipe(log);
    c.stderr.pipe(log);
    c.exited = new Promise((r) => c.once('exit', (code) => r(code)));
    children.push(c);
    return c;
  };
  const once = (name, cmd, args, env) => {
    const r = spawnSync(cmd, args, { env, cwd: path(''), encoding: 'utf8' });
    if (r.status !== 0)
      throw new Error(
        `${name} failed (exit ${r.status}): ${(r.stderr || r.stdout).split('\n').slice(-5).join(' | ')}`,
      );
  };

  let code;
  let front;
  try {
    const tls = generateCert();
    const pg = (await import('pg')).default;
    const sa = new pg.Client({
      connectionString: urlFor(adminUrl, new URL(adminUrl).username, database),
    });
    await sa.connect();
    try {
      // 1. queue library, then the task types of the worker registry (the API enqueues audit jobs with them)
      const { installQueue } = await import(path('packages/kernel/dist/queue/install.js'));
      await installQueue(urlFor(adminUrl, 'app_owner', database));
      once(
        'sync-task-types',
        process.execPath,
        [path('apps/worker/dist/sync-task-types-cli.js')],
        workerE,
      );

      // 2. organisation and reference data (permissions, roles) through the real worker job
      await sa.query(
        `INSERT INTO organisation.organisation (id, organisation_id, name, default_time_zone) VALUES ($1, $1, 'CI clinic', 'UTC') ON CONFLICT DO NOTHING`,
        [ORG],
      );
      const { KernelDb } = await import(path('packages/kernel/dist/index.js'));
      const workerPool = new pg.Pool({ connectionString: workerE.EHR_DATABASE_URL, max: 2 });
      try {
        const { runApplyReferenceData } = await import(
          path('apps/worker/dist/jobs/identity/index.js')
        );
        await runApplyReferenceData({ db: new KernelDb(workerPool), orgId: ORG });
      } finally {
        await workerPool.end();
      }

      // 3. people: a requester and an approver (two different admins produce every grant), the administrator under test, a BTG holder
      const person = async (subject, realm = 'admin_pool') => {
        const personId = randomUUID();
        const principalId = randomUUID();
        // one transaction: the deferred trigger person_requires_principal checks at COMMIT
        await sa.query('BEGIN');
        try {
          await sa.query(
            `INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1,$2,$3)`,
            [personId, ORG, `CI ${subject}`],
          );
          await sa.query(
            `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, status) VALUES ($1,$2,$3,$4,$5,'active')`,
            [principalId, ORG, personId, realm, subject],
          );
          await sa.query('COMMIT');
        } catch (e) {
          await sa.query('ROLLBACK');
          throw e;
        }
        return { personId, principalId };
      };
      const requester = await person('ci-requester');
      const approver = await person('ci-approver');
      const admin = await person(HANDLE);
      const holder = await person('ci-btg-holder');
      const as = (personId) => sa.query(`SELECT set_config('app.person_id', $1, true)`, [personId]);

      // roles: the configuration role and the audit/break-the-glass role, each through the real request states
      for (const roleKey of ['org_admin', 'compliance_officer']) {
        const requestId = randomUUID();
        await sa.query('BEGIN');
        try {
          await as(requester.personId);
          await sa.query(
            `INSERT INTO identity.role_change_request (id, organisation_id, requester_person_id, subject_principal_id, change, before, request_hash, status, expires_at)
             VALUES ($1,$2,$3,$4,'{"add":[],"remove":[]}'::jsonb,'[]'::jsonb,decode(repeat('ab',32),'hex'),'requested',now() + interval '1 day')`,
            [requestId, ORG, requester.personId, admin.principalId],
          );
          await as(approver.personId);
          await sa.query(
            `UPDATE identity.role_change_request SET status='approved', approver_person_id=$2, decided_at=now() WHERE id=$1`,
            [requestId, approver.personId],
          );
          const ins = await sa.query(
            `INSERT INTO identity.role_assignment (id, organisation_id, principal_id, role_id, location_id, granted_via_request_id)
             SELECT $1,$2,$3,r.id,NULL,$4 FROM identity.role r WHERE r.organisation_id=$2 AND r.key=$5`,
            [randomUUID(), ORG, admin.principalId, requestId, roleKey],
          );
          if (ins.rowCount !== 1)
            throw new Error(`role ${roleKey} is missing from the reference data`);
          await sa.query(`UPDATE identity.role_change_request SET status='applied' WHERE id=$1`, [
            requestId,
          ]);
          await sa.query('COMMIT');
        } catch (e) {
          await sa.query('ROLLBACK');
          throw e;
        }
      }

      // approved single-use enrolment token (requested by one admin, approved by another), valid 30 minutes
      const tokenId = randomUUID();
      await sa.query('BEGIN');
      try {
        await as(requester.personId);
        await sa.query(
          `INSERT INTO identity.enrolment_token (id, organisation_id, principal_id, requested_by_person_id, expires_at, status)
           VALUES ($1,$2,$3,$4, now() + interval '30 minutes','requested')`,
          [tokenId, ORG, admin.principalId, requester.personId],
        );
        await as(approver.personId);
        await sa.query(
          `UPDATE identity.enrolment_token SET token_hash=$2, approved_by_person_id=$3, status='approved' WHERE id=$1`,
          [tokenId, createHash('sha256').update(keys.enrolment).digest(), approver.personId],
        );
        await sa.query('COMMIT');
      } catch (e) {
        await sa.query('ROLLBACK');
        throw e;
      }

      // one pending break-the-glass grant, opened by a different principal (the reviewer is never the holder)
      await sa.query(
        `INSERT INTO audit.btg_grant (id, organisation_id, holder_principal_id, holder_person_id, holder_realm, patient_id, reason, opened_at, expires_at)
         VALUES ($1,$2,$3,$4,'admin_pool',$5,'Synthetic emergency access for the CI admin run', now() - interval '1 hour', now() + interval '1 hour')`,
        [randomUUID(), ORG, holder.principalId, holder.personId, randomUUID()],
      );
    } finally {
      await sa.end();
    }

    // 4. the stack: API, worker, built staff app
    const api = start('api', process.execPath, [path('apps/api/dist/src/main.js')], apiE);
    start('worker', process.execPath, [path('apps/worker/dist/main.js')], workerE);
    const staff = start(
      'staff-preview',
      process.execPath,
      [
        path('apps/staff/node_modules/vite/bin/vite.js'),
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(staffPort),
        '--strictPort',
      ],
      {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        API_ORIGIN: `http://127.0.0.1:${apiPort}`,
      },
      path('apps/staff/'),
    );
    const early = (c, name) =>
      c.exited.then((x) => {
        throw new Error(`${name} exited early (code ${x}); see ${logs}/${name}.log`);
      });
    const guard = Promise.race([
      early(api, 'api'),
      early(staff, 'staff-preview'),
      new Promise(() => {}),
    ]);
    guard.catch(() => {});
    await Promise.race([
      waitFor(
        'the API (/readyz)',
        async () => (await fetch(`http://127.0.0.1:${apiPort}/readyz`)).status === 200,
      ),
      guard,
    ]);
    await Promise.race([
      waitFor(
        'the staff app',
        async () => (await fetch(`http://127.0.0.1:${staffPort}/`)).status === 200,
        60,
      ),
      guard,
    ]);

    // 4b. the TLS front (https://staff.ci.test -> 127.0.0.1:<tlsPort>), checked with the pinned client
    front = await startTlsFront({
      key: tls.key,
      cert: tls.cert,
      tlsPort,
      apiPort,
      staffPort,
      logFile: `${logs}/tls-front.log`,
    });
    const page = await frontGet('/', { cert: tls.cert, tlsPort });
    if (page.status !== 200)
      throw new Error(`TLS front: GET / answered ${page.status}, expected 200`);
    const sess = await frontGet('/api/v1/auth/session', { cert: tls.cert, tlsPort });
    if (sess.status === 502 || (sess.status === 403 && /Blocked request/i.test(sess.body)))
      throw new Error(
        `TLS front: /api/v1/auth/session did not reach the API (status ${sess.status})`,
      );

    // 5. the driver, with the same fixture (ADMIN_RUN_API_URL stays unset: enrolment goes through the front too)
    delete process.env.ADMIN_RUN_API_URL;
    Object.assign(process.env, {
      ADMIN_RUN_STAFF_URL: CI_STAFF_ORIGIN,
      ADMIN_RUN_CONNECT: `127.0.0.1:${tlsPort}`,
      ADMIN_RUN_TLS_CERT_PEM: tls.cert, // public certificate only; the key never leaves this process
      ADMIN_RUN_HANDLE: HANDLE,
      ADMIN_RUN_ENROLMENT_TOKEN: keys.enrolment,
    });
    const { main: run } = await import('./admin-run.mjs');
    code = await run(fx);
  } catch (e) {
    console.error(`admin stack: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
  } finally {
    if (front) await front.close();
    for (const c of children) c.kill('SIGTERM');
    await Promise.race([Promise.all(children.map((c) => c.exited)), sleep(10000)]);
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  }
  process.exit(code ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--selftest')) selftest();
  else main();
}
