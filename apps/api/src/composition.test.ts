// Composition of milestone M4 (INT03-F01): the API's composition root mounts every M4 module's routes and defines every M4 job type.
// A fake database is enough: this proves wiring (route inventory, job registry, guard in front of each route), not persistence.
// Negative control: the same checks run against the composition with one module's controllers removed and must fail.
import assert from 'node:assert/strict';
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
    ];
    for (const p of probes) {
      const r = await fetch(`${t.base}${p}`, { headers: { 'x-client-release': R(MIN_RELEASE) } });
      assert.equal(r.status, 401, p);
    }
  });
});
