// Composition of milestone M4 (INT03-F01): the API's composition root mounts every M4 module's routes and defines every M4 job type.
// A fake database is enough: this proves wiring (route inventory, job registry, guard in front of each route), not persistence.
// Negative control: the same checks run against the composition with one module's controllers removed and must fail.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { createLogger } from '@ehr/kernel';
import type { KernelDb } from '@ehr/kernel';
import { MIN_RELEASE, R, start } from '../test/platform/harness.js';
import type { Running } from '../test/platform/harness.js';
import { buildComposition } from './composition.js';
import type { Composition } from './composition.js';
import { loadIdentityEnv } from './identity-env.js';
import { inventory } from './platform/inventory.js';

const K = 'k'.repeat(40);
const ENV = {
  EHR_ORGANISATION_ID: '00000000-0000-7000-8000-0000000000a1',
  EHR_STAFF_HOST: 'staff.example.test',
  EHR_PATIENT_HOST: 'my.example.test',
  EHR_ALLOWED_ORIGINS: 'https://staff.example.test,https://my.example.test',
  EHR_OIDC_STATE_KEY: K,
  EHR_CSRF_KEY: K,
  EHR_RATE_KEY: K,
  EHR_MATCH_CHECK_KEY: K,
  EHR_CHECKIN_QR_KEY: K,
  EHR_STAFF_OIDC_CLIENT_ID: 'staff',
  EHR_STAFF_OIDC_CLIENT_SECRET: K,
  EHR_STAFF_OIDC_REDIRECT_URI: 'https://staff.example.test/api/v1/auth/callback',
  EHR_STAFF_WORKSPACE_DOMAIN: 'example.com',
  EHR_PATIENT_OIDC_ISSUER: 'https://idp.example.test',
  EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT: 'https://idp.example.test/authorize',
  EHR_PATIENT_OIDC_TOKEN_ENDPOINT: 'https://idp.example.test/token',
  EHR_PATIENT_OIDC_JWKS_URI: 'https://idp.example.test/jwks',
  EHR_PATIENT_OIDC_CLIENT_ID: 'patient',
  EHR_PATIENT_OIDC_REDIRECT_URI: 'https://my.example.test/api/v1/auth/callback',
};

/** The M4 surface by module: controller class names and a route of each that must be mounted. */
const M4_ROUTES: Record<string, { controllers: string[]; routes: string[] }> = {
  'clinical chart': {
    controllers: ['ChartReadController', 'ChartWriteController', 'VitalRangeAdminController'],
    routes: [
      'GET /api/v1/patients/:patientId/banner',
      'GET /api/v1/patients/:patientId/chart-summary',
      'POST /api/v1/terminology/search',
      'POST /api/v1/admin/vital-ranges',
    ],
  },
  'clinical front door': {
    controllers: ['FrontdoorStaffController', 'FrontdoorPatientController'],
    routes: [
      'POST /api/v1/check-ins/:id/vitals',
      'POST /api/v1/check-ins/:id/triage',
      'PUT /api/v1/questionnaire-responses/:id',
      'POST /api/v1/referrals/:id/accept',
    ],
  },
  'clinical notes': {
    controllers: ['EncounterController', 'ClinicianNotesController', 'NoteController'],
    routes: [
      'POST /api/v1/encounters',
      'POST /api/v1/encounters/:id/complete',
      'POST /api/v1/notes/:id/sign',
      'POST /api/v1/notes/:id/cosign',
      'GET /api/v1/clinicians/:id/cosign-queue',
    ],
  },
  messaging: {
    controllers: [
      'MessagingThreadController',
      'MessagingTaskController',
      'MessagingPatientController',
    ],
    routes: [
      'GET /api/v1/threads',
      'POST /api/v1/threads/:id/messages',
      'PATCH /api/v1/tasks/:id',
      'POST /api/v1/patients/:patientId/threads',
    ],
  },
  privacy: {
    controllers: ['PrivacyPatientController', 'PrivacyStaffController', 'PrivacyAdminController'],
    routes: [
      'POST /api/v1/privacy-requests',
      'POST /api/v1/privacy-requests/:id/export/download-url',
      'POST /api/v1/admin/privacy-requests/:id/decide',
      'POST /api/v1/admin/incidents',
    ],
  },
  reporting: {
    controllers: ['ReportingOpsController'],
    routes: ['GET /api/v1/admin/reports/ops'],
  },
};

const M4_JOBS = [
  'clinical.terminology_load',
  'clinical.on_alert_unacknowledged',
  'clinical.note_sign_reminder',
  'messaging.on_correction_requested',
  'privacy.assemble_export',
  'privacy.check_legal_holds',
  'privacy.expire_packages',
  'reporting.refresh_ops',
];

/** Names of the M4 modules whose routes or jobs are missing from the composition (empty: all wired). */
function unwired(c: Pick<Composition, 'controllers' | 'registry'>): string[] {
  const mounted = new Set(
    inventory(c.controllers as never).routes.map((r) => `${r.method} ${r.path}`),
  );
  const names = new Set(c.controllers.map((x) => x.name));
  const out: string[] = [];
  for (const [mod, m] of Object.entries(M4_ROUTES)) {
    for (const n of m.controllers) if (!names.has(n)) out.push(`${mod}: controller ${n}`);
    for (const r of m.routes) if (!mounted.has(r)) out.push(`${mod}: route ${r}`);
  }
  const jobs = new Set(c.registry.list().map((j) => j.name));
  for (const j of M4_JOBS) if (!jobs.has(j)) out.push(`job ${j}`);
  return out;
}

/** `METHOD /path` (parameter names erased) of every operation of an OpenAPI file, read from its two-level `paths:` layout. */
function contractOperations(file: string): string[] {
  // The test runs from dist/src and from src: walk up to the directory that holds packages/contracts.
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'packages/contracts/openapi', file))) dir = dirname(dir);
  const text = readFileSync(join(dir, 'packages/contracts/openapi', file), 'utf8');
  const out: string[] = [];
  let path: string | undefined;
  for (const line of text.split('\n')) {
    const p = /^ {2}(\/\S+):\s*$/.exec(line);
    if (p !== null) path = p[1];
    else if (/^\S/.test(line)) path = undefined;
    const m = /^ {4}(get|put|post|patch|delete):\s*$/.exec(line);
    if (m !== null && path !== undefined)
      out.push(`${(m[1] as string).toUpperCase()} ${path.replace(/\{[^}]+\}/g, ':p')}`);
  }
  return out;
}
const PROXY_OPS = [
  'GET /api/v1/patients/:p/proxies',
  'DELETE /api/v1/patients/:p/proxies/:p',
  'POST /api/v1/patients/:p/proxy-requests',
];
/** The contract operations of the patient module (INT03-F13): patient.yaml and the 3 proxy operations of identity.yaml. */
const patientContract = (): string[] => [
  ...contractOperations('patient.yaml'),
  ...contractOperations('identity.yaml').filter((o) => PROXY_OPS.includes(o)),
];
const mountedKeys = (controllers: Composition['controllers']): string[] =>
  inventory(controllers as never).routes.map(
    (r) => `${r.method} ${r.path.replace(/:[A-Za-z]+/g, ':p')}`,
  );

let c: Composition;
let t: Running;
before(async () => {
  c = buildComposition({
    db: {} as unknown as KernelDb,
    logger: createLogger({ sink: () => undefined }),
    identity: loadIdentityEnv(ENV),
  });
  t = await start({ controllers: c.controllers, policy: c.policy });
});
after(async () => {
  await t.close();
});

describe('M4 composition (INT03-F01)', () => {
  test('every M4 module factory is wired: its controllers, routes and job types are present', () => {
    assert.deepEqual(unwired(c), []);
  });

  test('every mounted route declares a permission and a resolver (route inventory has no failures)', () => {
    assert.deepEqual(inventory(c.controllers as never).failures, []);
  });

  test('every operation of patient.yaml and the proxy routes of identity.yaml is mounted exactly once (INT03-F13)', () => {
    const want = patientContract();
    assert.equal(want.length, 34 + 3, 'the contract operations counted');
    const mounted = mountedKeys(c.controllers);
    const bad = want.filter((o) => mounted.filter((m) => m === o).length !== 1);
    assert.deepEqual(bad, []);
    assert.deepEqual(inventory(c.controllers as never).failures, []);
  });

  test('negative control: without the patient and merge controllers the inventory names the missing routes (INT03-F13)', () => {
    const patientNames = new Set([
      'PatientPortalController',
      'PatientStaffController',
      'PatientAdminController',
    ]);
    const kept = c.controllers.filter((x) => !patientNames.has(x.name) && !/Merge/.test(x.name));
    assert.ok(kept.length < c.controllers.length, 'some controllers were removed');
    const mounted = mountedKeys(kept);
    const missing = patientContract().filter((o) => !mounted.includes(o));
    assert.ok(missing.includes('GET /api/v1/patients/:p/profile'), missing.join(', '));
    assert.ok(missing.includes('POST /api/v1/patient-merges'), missing.join(', '));
  });

  test('no (method, path) is mounted twice', () => {
    const keys = inventory(c.controllers as never).routes.map((r) => `${r.method} ${r.path}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  test('negative control: with one module removed from the composition the check fails and names it', () => {
    for (const [mod, m] of Object.entries(M4_ROUTES)) {
      const without = c.controllers.filter((x) => !m.controllers.includes(x.name));
      const missing = unwired({ controllers: without, registry: c.registry });
      assert.ok(missing.length > 0, `${mod} removed but nothing reported`);
      assert.ok(
        missing.every((x) => x.startsWith(`${mod}:`)),
        `${mod}: ${missing.join('; ')}`,
      );
    }
    const noJob = { controllers: c.controllers, registry: { list: () => [] } as never };
    assert.deepEqual(
      unwired(noJob),
      M4_JOBS.map((j) => `job ${j}`),
    );
  });

  test('each M4 module answers behind the identity guard: mounted (not 404) and refused without a session', async () => {
    const probes = [
      '/api/v1/patients/00000000-0000-7000-8000-000000000001/chart-summary',
      '/api/v1/check-ins/00000000-0000-7000-8000-000000000001/triage',
      '/api/v1/clinicians/00000000-0000-7000-8000-000000000001/cosign-queue',
      '/api/v1/threads',
      '/api/v1/privacy-requests',
      '/api/v1/admin/reports/ops',
      // INT03-F13: the patient module's portal, staff, admin and merge routes
      '/api/v1/patients/00000000-0000-7000-8000-000000000001/profile',
      '/api/v1/patients/00000000-0000-7000-8000-000000000001/communication-preferences',
      '/api/v1/patients/00000000-0000-7000-8000-000000000001/proxies',
      '/api/v1/patients/00000000-0000-7000-8000-000000000001',
      '/api/v1/patient-merges/00000000-0000-7000-8000-000000000001',
      '/api/v1/duplicate-flags',
      '/api/v1/admin/consents',
    ];
    for (const p of probes) {
      const r = await fetch(`${t.base}${p}`, { headers: { 'x-client-release': R(MIN_RELEASE) } });
      assert.equal(r.status, 401, p);
    }
  });
});

describe('integrations host composition (INT03-F18)', () => {
  test('GET /public/v1/services|locations|clinicians is mounted and answers 200 without a session', async () => {
    const tx = { query: () => Promise.resolve({ rows: [] }) };
    const db = {
      withScope: (_s: unknown, fn: (x: unknown) => unknown) => fn(tx),
    } as unknown as KernelDb;
    const comp = buildComposition({
      db,
      logger: createLogger({ sink: () => undefined }),
      identity: loadIdentityEnv(ENV),
    });
    const run = await start({ controllers: comp.controllers, policy: comp.policy });
    try {
      for (const p of ['services', 'locations', 'clinicians']) {
        const r = await fetch(`${run.base}/public/v1/${p}`, {
          headers: { 'x-client-release': R(MIN_RELEASE) },
        });
        assert.equal(r.status, 200, p);
        assert.equal(r.headers.get('cache-control'), 'public, max-age=60', p);
      }
    } finally {
      await run.close();
    }
  });

  test('negative control: without the integrations host controllers /public/v1/services is 404', async () => {
    const kept = c.controllers.filter((x) => !/PublicDirectory|Webhook/.test(x.name));
    assert.ok(kept.length < c.controllers.length);
    const run = await start({ controllers: kept, policy: c.policy });
    try {
      const r = await fetch(`${run.base}/public/v1/services`, {
        headers: { 'x-client-release': R(MIN_RELEASE) },
      });
      assert.equal(r.status, 404);
    } finally {
      await run.close();
    }
  });
});
