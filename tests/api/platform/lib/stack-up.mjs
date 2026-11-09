// QA-05 stack for ENV-INT/ci: a THROWAWAY PostgreSQL database (real migrations, real roles), the REAL built API and worker
// processes, two fixture IdPs (patient, staff) and a per-run TLS front for https://staff.ci.test (the host the admin realm
// accepts). Synthetic data only (TEST-CASES 2, 3). This process stays running: it holds the per-run admin WebAuthn fixture in
// memory (CI attestation root + software authenticators) and exposes it to the test processes on a loopback control port. No
// private key is written to disk; the control bearer token lives in a mode-0600 file outside the repository.
//   node stack-up.mjs <repoRoot> <stateFile>   (keeps running; <stateFile> gets ready:true when the stack answers /readyz)
//   node stack-down.mjs <repoRoot> <stateFile> stops it and drops the database
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { seed, seedAdmins, ORG } from './seed.mjs';

process.env.CI = 'true';
process.env.EHR_ADMIN_CI_FIXTURE = '1';
const root = resolve(process.argv[2]);
const stateFile = resolve(process.argv[3]);
const logDir = resolve(dirname(stateFile), 'logs');
mkdirSync(logDir, { recursive: true });
if (!process.env.EHR_TEST_ADMIN_URL) throw new Error('EHR_TEST_ADMIN_URL is required (ci database admin)');
const pg = createRequire(root + '/package.json')('pg');
const imp = (p) => import(pathToFileURL(`${root}/${p}`).href);
const db = `ehr_qa05_${randomBytes(4).toString('hex')}`;
const admin = new URL(process.env.EHR_TEST_ADMIN_URL);
const urlFor = (user) => {
  const x = new URL(admin);
  x.username = user;
  x.password = '';
  x.pathname = '/' + db;
  return x.toString();
};
const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on('error', rej);
  });

const a = new pg.Client({ connectionString: process.env.EHR_TEST_ADMIN_URL });
await a.connect();
await a.query(`CREATE DATABASE ${db}`);
await a.end();

const env0 = { PATH: process.env.PATH, EHR_DB_ADMIN_URL: urlFor(admin.username), EHR_DB_MIGRATE_URL: urlFor('app_owner') };
for (const cmd of ['bootstrap', 'migrate'])
  execFileSync(process.execPath, [`${root}/db/tools/migrate.mjs`, cmd], { env: env0, stdio: 'inherit' });
await (await imp('packages/kernel/dist/queue/install.js')).installQueue(urlFor('app_owner'));

const ports = { api: await freePort(), patientIdp: 0, staffIdp: 0, tls: await freePort(), ctl: await freePort() };
// each fixture IdP uses two consecutive ports (idp, control)
const pair = async () => {
  for (;;) {
    const p = await freePort();
    try {
      await new Promise((res, rej) => {
        const s = net.createServer();
        s.once('error', rej);
        s.listen(p + 1, '127.0.0.1', () => s.close(() => res()));
      });
      return p;
    } catch {
      /* neighbour busy */
    }
  }
};
ports.patientIdp = await pair();
ports.staffIdp = await pair();

const staffHost = 'staff.ci.test';
const staffOrigin = `https://${staffHost}`;
const patientOrigin = `http://127.0.0.1:${ports.api}`;
const integrationsHost = 'integrations.localhost';

// --- admin-realm fixture (in memory) and the shared TLS front from the INT-04 admin stack ------------------------------------
// Same construction as scripts/ci/admin-fixture (INT04-F21), but the software authenticators are reachable over HTTP for the tests.
const { createAttestationFixture } = await imp('apps/api/dist/src/ci-fixture/attestation-ca.js');
const { SoftKey } = await imp('apps/api/dist/src/modules/identity/admin/softkey.js');
const ca = createAttestationFixture();
const fxEnv = {
  EHR_ENV: 'ci',
  EHR_ADMIN_CI_FIXTURE: '1',
  EHR_ADMIN_ATTESTATION_ROOTS_PEM: ca.rootPem,
  EHR_ADMIN_ALLOWED_AAGUIDS: ca.aaguid,
  EHR_ADMIN_DECOY_KEY: randomBytes(32).toString('hex'),
};
const softKeys = new Map(); // credential id (base64url) -> SoftKey; lives only in this process
const adminStack = await import(pathToFileURL(`${root}/scripts/ci/admin-stack.mjs`).href);
const tls = adminStack.generateCert();

// --- database preparation -------------------------------------------------------------------------------------------------------
const sa = new pg.Client({ connectionString: urlFor(admin.username) });
await sa.connect();
await sa.query(
  `INSERT INTO organisation.organisation (id, organisation_id, name, default_time_zone) VALUES ($1, $1, 'QA clinic', 'UTC') ON CONFLICT DO NOTHING`,
  [ORG],
);
const k = () => randomBytes(24).toString('hex');
const env1 = { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', EHR_ENV: 'ci', EHR_ORGANISATION_ID: ORG, EHR_MIN_CLIENT_RELEASE: '1' };
{
  const pool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 2 });
  const wdb = new (await imp('packages/kernel/dist/index.js')).KernelDb(pool);
  await (await imp('apps/worker/dist/jobs/identity/index.js')).runApplyReferenceData({ db: wdb, orgId: ORG });
  const { OrganisationService } = await imp('apps/api/dist/src/modules/organisation/index.js');
  await wdb.withScope({ audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' }, (tx) =>
    new OrganisationService().applySettingDefaults(tx, undefined),
  );
  await pool.end();
}
const fixtures = await seed(sa);
const enrolmentTokens = {};
const tokenOf = (key) => (enrolmentTokens[key] ??= randomBytes(32).toString('base64url'));
const admins = await seedAdmins(sa, tokenOf);
await sa.end();

// --- processes ----------------------------------------------------------------------------------------------------------------
const pids = {};
const start = (name, cmd, args, env) => {
  const out = openSync(`${logDir}/${name}.log`, 'a');
  const p = spawn(cmd, args, { env, stdio: ['ignore', out, out], detached: true });
  p.unref();
  pids[name] = p.pid;
  return p;
};
const idpJson = async (name, kind, port) => {
  const out = `${logDir}/${name}.json`;
  const fd = openSync(out, 'w');
  const p = spawn(process.execPath, [resolve(dirname(new URL(import.meta.url).pathname), 'idp-control.mjs'), kind, String(port), root], {
    stdio: ['ignore', fd, openSync(`${logDir}/${name}.log`, 'a')],
    detached: true,
  });
  p.unref();
  pids[name] = p.pid;
  await new Promise((r) => setTimeout(r, 2500));
  return JSON.parse(readFileSync(out, 'utf8'));
};
const pIdp = await idpJson('idp-patient', 'patient', ports.patientIdp);
const sIdp = await idpJson('idp-staff', 'staff', ports.staffIdp);
const base = {
  ...env1,
  EHR_INTEGRATIONS_HOST: integrationsHost,
  EHR_STAFF_HOST: staffHost,
  EHR_PATIENT_HOST: '127.0.0.1',
  EHR_ALLOWED_ORIGINS: `${patientOrigin},${staffOrigin}`,
  EHR_PORT: String(ports.api),
  EHR_OIDC_STATE_KEY: k(),
  EHR_CSRF_KEY: k(),
  EHR_RATE_KEY: k(),
  EHR_MATCH_CHECK_KEY: k(),
  EHR_CHECKIN_QR_KEY: k(),
  EHR_PATIENT_OIDC_ISSUER: pIdp.issuer,
  EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT: pIdp.authorizationEndpoint,
  EHR_PATIENT_OIDC_TOKEN_ENDPOINT: pIdp.tokenEndpoint,
  EHR_PATIENT_OIDC_JWKS_URI: pIdp.jwksUri,
  EHR_PATIENT_OIDC_CLIENT_ID: pIdp.clientId,
  EHR_PATIENT_OIDC_REDIRECT_URI: `${patientOrigin}/api/v1/auth/callback`,
  EHR_STAFF_OIDC_ISSUER: sIdp.issuer,
  EHR_STAFF_OIDC_AUTHORIZATION_ENDPOINT: sIdp.authorizationEndpoint,
  EHR_STAFF_OIDC_TOKEN_ENDPOINT: sIdp.tokenEndpoint,
  EHR_STAFF_OIDC_JWKS_URI: sIdp.jwksUri,
  EHR_STAFF_OIDC_CLIENT_ID: sIdp.clientId,
  EHR_STAFF_OIDC_CLIENT_SECRET: k(),
  EHR_STAFF_OIDC_REDIRECT_URI: `${staffOrigin}/api/v1/auth/callback`,
  EHR_STAFF_WORKSPACE_DOMAIN: 'example.com',
};
// Public fixture values only (root certificate, AAGUID, decoy key); only the API reads them.
start('api', process.execPath, [`${root}/apps/api/dist/src/main.js`], { ...base, EHR_DEPLOYABLE: 'api', EHR_DATABASE_URL: urlFor('app_api'), ...fxEnv });
start('worker', process.execPath, [`${root}/apps/worker/dist/main.js`], { ...base, EHR_DEPLOYABLE: 'worker', EHR_DATABASE_URL: urlFor('app_worker') });

// TLS front: /api/* -> the API (Host kept). Nothing else is needed (no portal is served).
const front = await adminStack.startTlsFront({
  key: tls.key,
  cert: tls.cert,
  tlsPort: ports.tls,
  apiPort: ports.api,
  staffPort: ports.api,
  logFile: `${logDir}/tls-front.log`,
});

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    ready = (await fetch(`${patientOrigin}/readyz`)).ok;
  } catch {
    /* not up yet */
  }
}

// --- control service for the test processes (admin WebAuthn fixture), loopback only, bearer token ------------------------------
const ctlDir = mkdtempSync(join(tmpdir(), 'qa05-ctl-'));
const ctlToken = randomBytes(24).toString('hex');
writeFileSync(join(ctlDir, 'token'), ctlToken);
chmodSync(join(ctlDir, 'token'), 0o600);
const readBody = (req) =>
  new Promise((res) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => res(Buffer.concat(c).toString('utf8')));
  });
const ctl = createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.headers.authorization !== `Bearer ${ctlToken}`) return send(401, { error: 'unauthorised' });
  const u = new URL(req.url, 'http://x');
  try {
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
    if (u.pathname === '/enrolment-token') {
      // single use: the daemon hands each token out once
      const key = u.searchParams.get('key');
      const t = enrolmentTokens[key];
      if (!t) return send(404, { error: 'unknown admin' });
      return send(200, { handle: admins[key].handle, token: t });
    }
    if (u.pathname === '/attest') {
      const key = new SoftKey();
      const r = key.create(body.options, {
        origin: staffOrigin,
        rpId: staffHost,
        aaguid: ca.aaguid,
        attestation: { x5c: ca.x5c, key: ca.leafKey },
        ...(body.opts ?? {}),
      });
      softKeys.set(key.id, key);
      return send(200, r);
    }
    if (u.pathname === '/assert') {
      const ids = (body.options.allowCredentials ?? []).map((c) => c.id);
      const key = ids.map((i) => softKeys.get(i)).find((x) => x !== undefined);
      if (!key) return send(404, { error: 'no matching credential' });
      return send(200, key.assert(body.options, { origin: staffOrigin, rpId: staffHost, ...(body.opts ?? {}) }));
    }
    return send(404, { error: 'unknown route' });
  } catch (e) {
    return send(500, { error: String(e?.message ?? e) });
  }
});
await new Promise((r) => ctl.listen(ports.ctl, '127.0.0.1', r));

writeFileSync(
  stateFile,
  JSON.stringify(
    {
      db,
      ports,
      pids: { ...pids, stack: process.pid },
      fixtures,
      admins: Object.fromEntries(Object.entries(admins).filter(([x]) => !x.startsWith('_')).map(([x, v]) => [x, v])),
      staffHost,
      integrationsHost,
      tlsCertPem: tls.cert, // public certificate only
      ctlTokenFile: join(ctlDir, 'token'),
      startedAt: new Date().toISOString(),
      ready,
      runId: randomUUID(),
    },
    null,
    2,
  ),
);
if (!ready) {
  console.error('API did not become ready; see logs');
  process.exit(1);
}
console.log(`stack ready: db=${db} api=${ports.api} tls=${ports.tls} ctl=${ports.ctl}`);
process.once('SIGTERM', () => {
  void front.close();
  ctl.close();
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
