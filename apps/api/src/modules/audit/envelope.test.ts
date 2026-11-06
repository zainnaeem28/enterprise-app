import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ScopeSettings } from '@ehr/kernel';
import { AUDIT_ACTIONS, buildRow, type AuditEnvelope } from './envelope.js';
import { AuditEnvelopeError } from './errors.js';
import { filterSql, validateFilter } from './filter.js';
import { isUuid, uuidv7 } from './ids.js';

const U = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const scope: ScopeSettings = {
  audience: 'staff',
  realm: 'google',
  orgId: U(1),
  principalId: U(2),
  personId: U(3),
};
const base: AuditEnvelope = {
  requestId: U(9),
  action: 'view',
  resourceType: 'clinical.note',
  patientId: U(5),
};
const fields = (fn: () => unknown): readonly string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AuditEnvelopeError) return e.fields;
    throw e;
  }
  return [];
};

describe('envelope', () => {
  test('the action list is the 22.2 closed list (8.1 plus six additions), 27 entries', () => {
    assert.equal(AUDIT_ACTIONS.length, 27);
    for (const a of [
      'care_attach',
      'consent_exception',
      'kill_switch',
      'enrol',
      'link_person',
      'secret_write',
      'denied',
    ])
      assert.ok((AUDIT_ACTIONS as readonly string[]).includes(a), a);
  });
  test('the actor comes from the scope; nothing the caller sends can override it', () => {
    const r = buildRow(
      scope,
      { ...base, actorPrincipalId: U(77), realm: 'admin_pool' } as never,
      U(8),
    );
    assert.equal(r.actorPrincipalId, U(2));
    assert.equal(r.actorPersonId, U(3));
    assert.equal(r.realm, 'google');
    assert.equal(r.audience, 'staff');
    assert.equal(r.organisationId, U(1));
  });
  test('allowed rows carry no denial reason; denied rows carry one and the action denied', () => {
    const a = buildRow(scope, base, U(8));
    assert.deepEqual([a.outcome, a.denialReason, a.action], ['allowed', null, 'view']);
    const d = buildRow(
      scope,
      { requestId: U(9), resourceType: 'patient.patient', denialReason: 'not_visible' },
      U(8),
    );
    assert.deepEqual([d.outcome, d.denialReason, d.action], ['denied', 'not_visible', 'denied']);
    assert.deepEqual(
      fields(() =>
        buildRow(
          scope,
          { requestId: U(9), resourceType: 'x.y', denialReason: 'because' as never },
          U(8),
        ),
      ),
      ['denialReason'],
    );
  });
  test('a missing organisation or realm in the scope fails closed', () => {
    assert.deepEqual(
      fields(() => buildRow({ audience: 'staff' }, base, U(8))),
      ['scope.orgId', 'scope.realm'],
    );
  });
  test('export and BTG need a reason; at most 500 characters; user agent at most 512', () => {
    assert.deepEqual(
      fields(() => buildRow(scope, { ...base, action: 'export' }, U(8))),
      ['reason'],
    );
    assert.deepEqual(
      fields(() => buildRow(scope, { ...base, action: 'btg_open', reason: '   ' }, U(8))),
      ['reason'],
    );
    assert.deepEqual(
      fields(() => buildRow(scope, { ...base, reason: 'x'.repeat(501) }, U(8))),
      ['reason'],
    );
    assert.deepEqual(
      fields(() => buildRow(scope, { ...base, userAgent: 'x'.repeat(513) }, U(8))),
      ['userAgent'],
    );
    assert.equal(
      buildRow(scope, { ...base, action: 'export', reason: 'annual review' }, U(8)).reason,
      'annual review',
    );
  });
  test('a worker job uses job_id instead of request_id; neither is refused', () => {
    assert.equal(
      buildRow(scope, { ...base, requestId: null, jobId: 'audit.anchor:1' }, U(8)).requestId,
      null,
    );
    assert.deepEqual(
      fields(() => buildRow(scope, { ...base, requestId: null }, U(8))),
      ['requestId', 'jobId'],
    );
  });
  test('ids, resource type and ip are validated; no value is echoed in the error', () => {
    assert.deepEqual(
      fields(() => buildRow(scope, { ...base, patientId: 'x' }, U(8))),
      ['patientId'],
    );
    assert.deepEqual(
      fields(() => buildRow(scope, { ...base, resourceType: 'Clinical Note' }, U(8))),
      ['resourceType'],
    );
    assert.deepEqual(
      fields(() => buildRow(scope, { ...base, ip: '999.1.1.1' }, U(8))),
      ['ip'],
    );
    assert.equal(buildRow(scope, { ...base, ip: '2001:db8::1' }, U(8)).ip, '2001:db8::1');
    try {
      buildRow(scope, { ...base, patientId: 'secret-looking-value' }, U(8));
    } catch (e) {
      assert.ok(!JSON.stringify(e).includes('secret-looking-value'));
      assert.ok(!(e as Error).message.includes('secret-looking-value'));
    }
  });
  test('change: secrets only as version ids, bounded size and depth, objects only', () => {
    const ok = buildRow(
      scope,
      {
        ...base,
        action: 'config_change',
        change: { before: { limit: 1 }, after: { limit: 2 }, passwordVersionId: 'v3' },
      },
      U(8),
    );
    assert.ok(ok.change);
    for (const change of [
      { password: 'x' },
      { a: { b: { apiKey: 'k' } } },
      { token: 't' },
      { credential: 'c' },
      { big: 'x'.repeat(17000) },
    ])
      assert.deepEqual(
        fields(() => buildRow(scope, { ...base, change }, U(8))),
        ['change'],
      );
    assert.deepEqual(
      fields(() => buildRow(scope, { ...base, change: [1] as never }, U(8))),
      ['change'],
    );
  });
});

describe('filter', () => {
  const from = new Date('2026-11-01T00:00:00Z');
  const to = new Date('2026-11-05T00:00:00Z');
  test('half-open range, from before to, search at most 31 days', () => {
    validateFilter({ from, to }, 31);
    assert.deepEqual(
      fields(() => validateFilter({ from: to, to: from })),
      ['from', 'to'],
    );
    assert.deepEqual(
      fields(() => validateFilter({ from, to: from })),
      ['from', 'to'],
    );
    assert.deepEqual(
      fields(() => validateFilter({ from, to: new Date('2026-12-02T00:00:01Z') }, 31)),
      ['from', 'to'],
    );
    validateFilter({ from, to: new Date('2026-12-02T00:00:00Z') }, 31);
    assert.deepEqual(
      fields(() => validateFilter({ from: new Date('x'), to })),
      ['from'],
    );
  });
  test('optional terms are validated and parameterised, never concatenated', () => {
    assert.deepEqual(
      fields(() => validateFilter({ from, to, patientId: "1'; DROP TABLE audit.event;--" })),
      ['patientId'],
    );
    assert.deepEqual(
      fields(() => validateFilter({ from, to, action: 'delete' })),
      ['action'],
    );
    assert.deepEqual(
      fields(() => validateFilter({ from, to, resourceType: 'A B' })),
      ['resourceType'],
    );
    const { where, params } = filterSql({ from, to, patientId: U(5), action: 'view' }, 3);
    assert.match(
      where,
      /occurred_at >= \$3::timestamptz AND occurred_at < \$4::timestamptz AND patient_id = \$5::uuid AND action = \$6/,
    );
    assert.equal(params.length, 4);
    assert.ok(!where.includes(U(5)));
  });
});

describe('ids', () => {
  test('uuidv7 is a valid, time-ordered version 7 UUID', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    assert.ok(isUuid(a) && isUuid(b));
    assert.equal(a[14], '7');
    assert.ok('89ab'.includes(a[19] as string));
    assert.ok(a.slice(0, 13) < b.slice(0, 13) || a.slice(0, 8) < b.slice(0, 8));
    assert.equal(a.slice(0, 13), uuidv7(1_700_000_000_000).slice(0, 13));
  });
});
