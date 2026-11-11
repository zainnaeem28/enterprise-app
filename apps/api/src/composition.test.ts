// Composition of milestone M4 (INT03-F01): the API's composition root mounts every M4 module's routes and defines every M4 job type.
// A fake database is enough: this proves wiring (route inventory, job registry, guard in front of each route), not persistence.
// Negative control: the same checks run against the composition with one module's controllers removed and must fail.
import assert from 'node:assert/strict';
import { createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { stringToSign } from './modules/integrations-host/index.js';
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
  'clinical.on_questionnaire_red_flag',
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

  test('no (method, path, host) is mounted twice; a shared path is host-bound on both sides (INT03-F21-O1)', () => {
    const routes = inventory(c.controllers as never).routes;
    const keys = routes.map((r) => `${r.method} ${r.host ?? '*'} ${r.path}`);
    assert.equal(new Set(keys).size, keys.length);
    const shared = routes.filter(
      (r) => routes.filter((o) => o.method === r.method && o.path === r.path).length > 1,
    );
    assert.equal(
      shared.length,
      16,
      'four shared documents paths and four shared booking paths (QA-EXEC-F07), two controllers each',
    );
    assert.ok(shared.every((r) => r.host !== undefined));
  });

  test('the booking calendar file, the calendar-link routes and the Google push webhook are mounted (QA-EXEC-F08)', () => {
    const routes = inventory(c.controllers as never).routes;
    const has = (method: string, path: string): boolean =>
      routes.some((r) => r.method === method && r.path === path);
    assert.ok(has('GET', '/api/v1/appointments/:id/calendar.ics'));
    for (const [m, p] of [
      ['GET', '/api/v1/calendar-link'],
      ['POST', '/api/v1/calendar-link/start'],
      ['GET', '/api/v1/calendar-link/callback'],
      ['DELETE', '/api/v1/calendar-link'],
      ['POST', '/webhooks/google/calendar'],
    ] as const)
      assert.ok(has(m, p), `${m} ${p}`);
  });

  test('staff variants of the booking paths declare scheduling.booking.manage on the staff host only (QA-EXEC-F07)', () => {
    const routes = inventory(c.controllers as never).routes;
    for (const path of [
      '/api/v1/holds',
      '/api/v1/appointments/:id/confirm',
      '/api/v1/appointments/:id/cancel',
      '/api/v1/appointments/:id/reschedule',
    ]) {
      const both = routes.filter((r) => r.method === 'POST' && r.path === path);
      assert.equal(both.length, 2, path);
      assert.deepEqual(
        both.map((r) => r.declaration?.permission).sort(),
        ['proxy', 'scheduling.booking.manage'],
        path,
      );
    }
  });

  test('inventory: an unbound duplicate of a host-bound path is a failure (INT03-F21-O1)', async () => {
    const { Controller, Get } = await import('@nestjs/common');
    const { Route } = await import('./platform/route.js');
    const make = (host?: string) => {
      class Dup {
        h(): void {}
      }
      if (host === undefined) Controller('x')(Dup);
      else Controller({ path: 'x', host })(Dup);
      const d = Object.getOwnPropertyDescriptor(Dup.prototype, 'h')!;
      Get('y')(Dup.prototype, 'h', d);
      Route({ permission: 'patient', resolver: 'r' })(Dup.prototype, 'h', d);
      return Dup;
    };
    assert.deepEqual(inventory([make('a.test'), make('b.test')] as never).failures, []);
    assert.equal(inventory([make('a.test'), make()] as never).failures.length, 1);
    assert.equal(inventory([make('a.test'), make('a.test')] as never).failures.length, 1);
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
  test('GET /public/v1/services|locations|clinicians|banners is mounted and answers 200 without a session', async () => {
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
      for (const p of ['services', 'locations', 'clinicians', 'banners']) {
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

  test('POST /webhooks/sns/receipts is mounted by buildComposition: a signed SES delivery is sealed and stored through receive_inbound, and unconfigured it is 404 (INT-N2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sns-comp-'));
    try {
      const sh = (...a: string[]): void =>
        void execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
      sh(
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'k.pem',
        '-out',
        'c.pem',
        '-days',
        '2',
        '-subj',
        '/CN=sns.amazonaws.com',
      );
      const key = readFileSync(join(dir, 'k.pem'), 'utf8');
      const topic = 'arn:aws:sns:eu-west-2:123456789012:ehr-ses-events';
      const f: Record<string, string> = {
        Type: 'Notification',
        MessageId: 'm-comp-1',
        TopicArn: topic,
        Message: JSON.stringify({
          eventType: 'Delivery',
          mail: { messageId: 'ses-1' },
          delivery: { timestamp: new Date().toISOString() },
        }),
        Timestamp: new Date().toISOString(),
      };
      const body = JSON.stringify({
        ...f,
        SignatureVersion: '2',
        Signature: createSign('RSA-SHA256')
          .update(stringToSign('Notification', f), 'utf8')
          .sign(key, 'base64'),
        SigningCertURL: 'https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-abc123.pem',
      });
      const sql: { text: string; params: unknown[] }[] = [];
      const tx = {
        query: (text: string, params: unknown[] = []) => {
          sql.push({ text, params });
          return Promise.resolve({
            rows: [{ outcome: 'inserted', message_id: '00000000-0000-7000-8000-000000000001' }],
            rowCount: 1,
          });
        },
      };
      const sealed: string[] = [];
      const logs: string[] = [];
      const db = {
        withScope: (_s: unknown, fn: (x: unknown) => unknown) => fn(tx),
      } as unknown as KernelDb;
      const comp = buildComposition({
        db,
        logger: createLogger({ sink: (l) => logs.push(l) }),
        identity: loadIdentityEnv(ENV),
        receiptPorts: {
          region: 'eu-west-2',
          topics: new Map([[topic, 'email']]),
          sealer: {
            seal: (plain, ctx) => {
              sealed.push(ctx);
              return Promise.resolve(Buffer.concat([Buffer.from('sealed:'), plain]));
            },
          },
          fetchCertificate: () => Promise.resolve(readFileSync(join(dir, 'c.pem'), 'utf8')),
        },
      });
      const run = await start({ controllers: comp.controllers, policy: comp.policy });
      try {
        const post = (b: string) =>
          fetch(`${run.base}/webhooks/sns/receipts`, {
            method: 'POST',
            headers: {
              'content-type': 'text/plain; charset=UTF-8',
              'x-client-release': R(MIN_RELEASE),
            },
            body: b,
          });
        assert.equal((await post(body)).status, 200, logs.join('\n'));
        assert.deepEqual(sealed, ['inbound:email\nm-comp-1']);
        const recv = sql.find((q) => /receive_inbound/.test(q.text));
        assert.deepEqual(recv?.params.slice(0, 3), ['email', 'm-comp-1', 'delivery_receipt']);
        assert.ok(
          sql.some((q) => JSON.stringify(q.params).includes('integration_core.dispatch_inbound')),
          'a dispatch job is enqueued with the message: ' +
            sql.map((q) => q.text.slice(0, 60)).join(' | '),
        );
        assert.equal((await post(body.replace('Delivery', 'Bounce'))).status, 401);
        assert.equal(sealed.length, 1, 'a tampered request seals and stores nothing');
      } finally {
        await run.close();
      }
      // Unconfigured: the same route answers 404.
      const bare = buildComposition({
        db,
        logger: createLogger({ sink: () => undefined }),
        identity: loadIdentityEnv(ENV),
      });
      const run2 = await start({ controllers: bare.controllers, policy: bare.policy });
      try {
        const r = await fetch(`${run2.base}/webhooks/sns/receipts`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain', 'x-client-release': R(MIN_RELEASE) },
          body: body,
        });
        assert.equal(r.status, 404);
      } finally {
        await run2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

describe('documents and alerts composition (INT03-F21)', () => {
  const noDb = { withScope: () => Promise.reject(new Error('no db')) } as unknown as KernelDb;
  const build = (listen?: () => never) =>
    buildComposition({
      db: noDb,
      logger: createLogger({ sink: () => undefined }),
      identity: loadIdentityEnv(ENV),
      ...(listen === undefined ? {} : { listen }),
    });
  const P = '11111111-1111-4111-8111-111111111111';
  const routes: [string, string][] = [
    ['GET', '/api/v1/alerts'],
    ['GET', '/api/v1/alerts/open-ids'],
    ['POST', `/api/v1/alerts/${P}/acknowledge`],
    ['GET', `/api/v1/patients/${P}/documents`],
    ['POST', `/api/v1/patients/${P}/document-uploads`],
    ['POST', `/api/v1/documents/${P}/confirm`],
  ];

  test('the routes are mounted: without a session they are refused (401), not 404', async () => {
    const comp = build();
    const run = await start({ controllers: comp.controllers, policy: comp.policy });
    try {
      for (const [m, p] of routes) {
        for (const host of ['staff.example.test', 'my.example.test']) {
          const r = await fetch(`${run.base}${p}`, {
            method: m,
            headers: { 'x-client-release': R(MIN_RELEASE), 'x-forwarded-host': host },
          });
          // The staff-only route exists on the staff host only (INT03-F21-O1).
          const want = p.endsWith('/confirm') && host === 'my.example.test' ? 404 : 401;
          assert.equal(r.status, want, `${m} ${p} on ${host}`);
        }
      }
      // A host that is neither configured host reaches no host-bound documents route (404).
      const other = await fetch(`${run.base}/api/v1/patients/${P}/documents`, {
        headers: { 'x-client-release': R(MIN_RELEASE), 'x-forwarded-host': 'other.example.test' },
      });
      assert.equal(other.status, 404);
    } finally {
      await run.close();
    }
  });

  test('the notifications stream hub is composed only when a LISTEN factory is given', () => {
    assert.equal(build().alertStreamHub, undefined);
    assert.ok(build((() => undefined) as never).alertStreamHub !== undefined);
  });

  test('negative control: without these controllers the routes are 404', async () => {
    const comp = build();
    const kept = comp.controllers.filter((x) => !/Alerts|Documents/.test(x.name));
    assert.ok(kept.length < comp.controllers.length);
    const run = await start({ controllers: kept, policy: comp.policy });
    try {
      const r = await fetch(`${run.base}/api/v1/alerts`, {
        headers: { 'x-client-release': R(MIN_RELEASE) },
      });
      assert.equal(r.status, 404);
      const d = await fetch(`${run.base}/api/v1/patients/${P}/documents`, {
        headers: { 'x-client-release': R(MIN_RELEASE), 'x-forwarded-host': 'staff.example.test' },
      });
      assert.equal(d.status, 404);
    } finally {
      await run.close();
    }
  });
});
