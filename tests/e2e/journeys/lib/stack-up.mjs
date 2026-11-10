// QA-04 stack for ENV-INT/ci: a THROWAWAY PostgreSQL database (real migrations, real roles), the REAL built API and worker
// processes, and two fixture IdPs with control ports. Synthetic data only (TEST-CASES 3). No credential is printed or stored:
// the database admin URL comes from EHR_TEST_ADMIN_URL, per-run keys are generated here and live in the child environments.
//   node stack-up.mjs <repoRoot> <stateFile>      writes <stateFile> (ports, db name, pids; no secrets) and exits
//   node stack-down.mjs <stateFile>               stops the processes and drops the database
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { seed, ORG } from './seed.mjs';

const root = resolve(process.argv[2]);
const stateFile = resolve(process.argv[3]);
const logDir = resolve(dirname(stateFile), 'logs');
mkdirSync(logDir, { recursive: true });
if (!process.env.EHR_TEST_ADMIN_URL)
  throw new Error('EHR_TEST_ADMIN_URL is required (ci database admin)');
const pg = createRequire(root + '/package.json')('pg');
const db = `ehr_qa04_${randomBytes(4).toString('hex')}`;
const admin = new URL(process.env.EHR_TEST_ADMIN_URL);
const urlFor = (user) => {
  const x = new URL(admin);
  x.username = user;
  x.password = '';
  x.pathname = '/' + db;
  return x.toString();
};
const a = new pg.Client({ connectionString: process.env.EHR_TEST_ADMIN_URL });
await a.connect();
await a.query(`CREATE DATABASE ${db}`);
await a.end();

const env0 = {
  PATH: process.env.PATH,
  EHR_DB_ADMIN_URL: urlFor(admin.username),
  EHR_DB_MIGRATE_URL: urlFor('app_owner'),
};
for (const cmd of ['bootstrap', 'migrate'])
  execFileSync(process.execPath, [`${root}/db/tools/migrate.mjs`, cmd], {
    env: env0,
    stdio: 'inherit',
  });
const imp = (p) => import(pathToFileURL(`${root}/${p}`).href);
await (await imp('packages/kernel/dist/queue/install.js')).installQueue(urlFor('app_owner'));
const { KernelDb } = await imp('packages/kernel/dist/index.js');
const pool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 2 });
const wdb = new KernelDb(pool);
await (
  await imp('apps/worker/dist/jobs/identity/index.js')
).runApplyReferenceData({ db: wdb, orgId: ORG });
const { OrganisationService } = await imp('apps/api/dist/src/modules/organisation/index.js');
await wdb.withScope({ audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' }, (tx) =>
  new OrganisationService().applySettingDefaults(tx, undefined),
);
await pool.end();

const sa = new pg.Client({ connectionString: urlFor(admin.username) });
await sa.connect();
const fixtures = await seed(sa);
await sa.end();

const off = Number(process.env.QA_PORT_OFFSET ?? 0);
const ports = { api: 3610 + off, patientIdp: 9210 + off, staffIdp: 9220 + off };
const k = () => randomBytes(24).toString('hex');
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
  const p = spawn(
    process.execPath,
    [
      resolve(dirname(new URL(import.meta.url).pathname), 'idp-control.mjs'),
      kind,
      String(port),
      root,
    ],
    {
      stdio: ['ignore', fd, openSync(`${logDir}/${name}.log`, 'a')],
      detached: true,
    },
  );
  p.unref();
  pids[name] = p.pid;
  const fsm = await import('node:fs');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      return JSON.parse(fsm.readFileSync(out, 'utf8'));
    } catch {
      /* not written yet */
    }
  }
  throw new Error(`IdP ${name} did not start; see ${logDir}/${name}.log`);
};
const pIdp = await idpJson('idp-patient', 'patient', ports.patientIdp);
const sIdp = await idpJson('idp-staff', 'staff', ports.staffIdp);
const { createAttestationFixture } = await imp('apps/api/dist/src/ci-fixture/attestation-ca.js');
const ca = createAttestationFixture();
const base = {
  PATH: process.env.PATH,
  EHR_ENV: 'ci',
  EHR_ADMIN_CI_FIXTURE: '1',
  EHR_ADMIN_ATTESTATION_ROOTS_PEM: ca.rootPem,
  EHR_ADMIN_ALLOWED_AAGUIDS: ca.aaguid,
  EHR_ADMIN_DECOY_KEY: k(),
  EHR_ORGANISATION_ID: ORG,
  EHR_INTEGRATIONS_HOST: 'integrations.localhost',
  EHR_MIN_CLIENT_RELEASE: '1',
  EHR_STAFF_HOST: 'localhost',
  EHR_PATIENT_HOST: '127.0.0.1',
  EHR_ALLOWED_ORIGINS: `http://127.0.0.1:${ports.api},http://localhost:${ports.api}`,
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
  EHR_PATIENT_OIDC_REDIRECT_URI: `http://127.0.0.1:${ports.api}/api/v1/auth/callback`,
  EHR_STAFF_OIDC_ISSUER: sIdp.issuer,
  EHR_STAFF_OIDC_AUTHORIZATION_ENDPOINT: sIdp.authorizationEndpoint,
  EHR_STAFF_OIDC_TOKEN_ENDPOINT: sIdp.tokenEndpoint,
  EHR_STAFF_OIDC_JWKS_URI: sIdp.jwksUri,
  EHR_STAFF_OIDC_CLIENT_ID: sIdp.clientId,
  EHR_STAFF_OIDC_CLIENT_SECRET: k(),
  EHR_STAFF_OIDC_REDIRECT_URI: `http://localhost:${ports.api}/api/v1/auth/callback`,
  EHR_STAFF_WORKSPACE_DOMAIN: 'example.com',
};
start('api', process.execPath, [`${root}/apps/api/dist/src/main.js`], {
  ...base,
  EHR_DEPLOYABLE: 'api',
  EHR_DATABASE_URL: urlFor('app_api'),
});
start('worker', process.execPath, [`${root}/apps/worker/dist/main.js`], {
  ...base,
  EHR_DEPLOYABLE: 'worker',
  EHR_DATABASE_URL: urlFor('app_worker'),
});
let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    ready = (await fetch(`http://127.0.0.1:${ports.api}/readyz`)).ok;
  } catch {
    /* not up yet */
  }
}
writeFileSync(
  stateFile,
  JSON.stringify(
    { db, ports, pids, fixtures, startedAt: new Date().toISOString(), ready, runId: randomUUID() },
    null,
    2,
  ),
);
if (!ready) {
  console.error('API did not become ready; see logs');
  process.exit(1);
}
console.log(`stack ready: db=${db} api=${ports.api}`);
