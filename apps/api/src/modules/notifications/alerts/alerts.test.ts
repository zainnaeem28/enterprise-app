// Database-free tests of the alert part: the route inventory of its controllers (ARCHITECTURE 38.2 item 9), the closed
// vocabularies against the migration, the job declaration, and the input validation that runs before any query.
//   pnpm --filter @ehr/api build && node --test apps/api/dist/src/modules/notifications/alerts/alerts.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JobRegistry } from '@ehr/kernel';
import type { KernelDb, Queue, Tx } from '@ehr/kernel';
import { inventory } from '../../../platform/inventory.js';
import { NotificationsValidationError } from '../errors.js';
import { createAlertStreamController } from '../stream/controller.js';
import type { StreamHub } from '../stream/hub.js';
import { createAlertsController } from './controller.js';
import { ALERT_JOBS } from './jobs.js';
import { AlertService, decodeCursor, encodeCursor, toView } from './service.js';
import { ALERT_SEVERITIES, ALERT_TYPES, PATIENT_ALERT_TYPES } from './types.js';

let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/migrations`)) root = join(root, '..') + '/';
const sql = readFileSync(`${root}db/migrations/1200_staff_alert_tables.sql`, 'utf8');

describe('alert routes and declarations', () => {
  test('the alert and stream controllers declare every route: 4 routes, known permissions, no failures', () => {
    const alerts = createAlertsController({
      db: {} as KernelDb,
      alerts: {} as AlertService,
      scopeOf: () => {
        throw new Error('unused');
      },
    });
    const stream = createAlertStreamController({} as StreamHub, () => {
      throw new Error('unused');
    });
    const r = inventory([alerts, stream] as never);
    assert.deepEqual(r.failures, []);
    assert.deepEqual(
      r.routes.map((x) => `${x.method} ${x.path} ${x.declaration?.permission}`).sort(),
      [
        'GET /api/v1/alerts notifications.alert.read',
        'GET /api/v1/alerts/open-ids notifications.alert.read',
        'GET /api/v1/alerts/stream notifications.alert.read',
        'POST /api/v1/alerts/:id/acknowledge notifications.alert.acknowledge',
      ],
    );
    // INT04-F10-D: every alert route accepts the staff and the admin realm, and no other (ARCHITECTURE 32.2 point 1).
    for (const x of r.routes)
      assert.deepEqual(x.declaration?.realm, ['google', 'admin_pool'], `${x.method} ${x.path}`);
    const s = r.routes.find((x) => x.path.endsWith('/stream'));
    assert.equal(s?.declaration?.routeClass, 'stream');
  });

  test('the type and severity lists equal the CHECK constraints of migration 1200', () => {
    const list = (re: RegExp): string[] =>
      [...(re.exec(sql)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
    assert.deepEqual(list(/type\s+text\s+NOT NULL CHECK \(type IN \(([^)]*)\)/), [...ALERT_TYPES]);
    assert.deepEqual(list(/severity\s+text\s+NOT NULL CHECK \(severity IN \(([^)]*)\)/), [
      ...ALERT_SEVERITIES,
    ]);
    assert.deepEqual([...PATIENT_ALERT_TYPES], ['red_flag', 'note_unsigned']);
  });

  test('the escalation job declares scope, on_merged and attempts (TICKETS 3, 33.1) and registers', () => {
    const reg = new JobRegistry();
    for (const j of ALERT_JOBS) reg.defineJob(j);
    const t = reg.get('notifications.escalate_alert');
    assert.equal(t.carriesPatientIds, true);
    assert.equal(t.onMerged, 'resolve');
    assert.equal(t.maxAttempts, 3);
    assert.equal(t.jobClass, 'job');
  });
});

describe('input validation (before any query)', () => {
  const svc = new AlertService({ queue: {} as Queue });
  const tx = {
    scope: { audience: 'system', orgId: 'x' },
    query: () => Promise.reject(new Error('no query')),
  } as unknown as Tx;
  const base = {
    type: 'red_flag',
    severity: 'critical',
    targets: { kind: 'principal', principalIds: ['00000000-0000-7000-8000-000000000001'] },
    resourceType: 'triage_assessment',
    resourceId: '00000000-0000-7000-8000-000000000002',
    patientId: '00000000-0000-7000-8000-000000000003',
  } as const;
  const bad = async (over: Record<string, unknown>, field: string): Promise<void> => {
    await assert.rejects(
      svc.raise(tx, { ...base, ...over } as never),
      (e: unknown) => e instanceof NotificationsValidationError && e.fields.includes(field),
      field,
    );
  };
  test('bad type, severity, resource, patient and location are refused by field name', async () => {
    await bad({ type: 'other' }, 'type');
    await bad({ severity: 'urgent' }, 'severity');
    await bad({ resourceType: 'Bad Type' }, 'resourceType');
    await bad({ resourceId: 'x' }, 'resourceId');
    await bad({ patientId: 'x' }, 'patientId');
    await bad({ locationId: 'x' }, 'locationId');
    await bad({ type: 'kill_switch_used' }, 'patientId'); // a patient on an admin-realm type
  });
  test('list rejects a bad status, limit and cursor; a cursor round-trips', async () => {
    for (const q of [
      { status: 'x' },
      { limit: 0 },
      { limit: 201 },
      { limit: 1.5 },
      { cursor: 'zzz' },
    ])
      await assert.rejects(
        svc.list(
          {
            scope: { principalId: 'p' },
            query: () => Promise.reject(new Error('q')),
          } as unknown as Tx,
          q,
        ),
        (e: unknown) => e instanceof NotificationsValidationError,
      );
    assert.equal(decodeCursor(encodeCursor(123456)), 123456);
  });
  test('toView nulls escalatesAt unless the alert is open (29.3 null rule)', () => {
    const row = {
      id: 'i',
      seq: '5',
      type: 'red_flag',
      severity: 'high',
      created_at: new Date(0),
      escalation_level: 0,
      escalate_at: new Date(1000),
      acknowledged_at: null,
      acknowledged_by: null,
      patient_id: null,
      resource_type: 'x',
      resource_id: null,
    };
    assert.equal(toView({ ...row, status: 'open' }).escalatesAt, new Date(1000).toISOString());
    for (const status of ['acknowledged', 'escalated', 'closed'])
      assert.equal(toView({ ...row, status }).escalatesAt, null, status);
    assert.equal(toView({ ...row, status: 'open', escalate_at: null }).escalatesAt, null);
  });
});
