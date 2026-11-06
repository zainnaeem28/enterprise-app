import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapDatabaseError, toProblem } from './map.js';

const CANARY = 'CANARY-PHI-Jane-Doe-1980-02-29';
const pg = (code: string, extra: Record<string, unknown> = {}): unknown => ({
  code,
  message: `row for ${CANARY} failed`,
  detail: `Key (patient_id)=(${CANARY}) conflicts`,
  hint: CANARY,
  constraint: CANARY,
  ...extra,
});

const CASES: [string, string, number, string?][] = [
  ['PM001', 'patient.merged', 409],
  ['PS001', 'scheduling.invalid_transition', 409, 'scheduling'],
  ['PK001', 'kernel.idempotency_conflict', 409],
  ['23P01', 'scheduling.slot_taken', 409],
  ['40001', 'kernel.unavailable', 503],
  ['40P01', 'kernel.unavailable', 503],
  ['57014', 'kernel.timeout', 504],
  ['25P04', 'kernel.timeout', 504],
  ['42501', 'auth.forbidden', 403],
  ['PA001', 'kernel.internal', 500],
  ['XX000', 'kernel.internal', 500],
];

for (const [sqlstate, code, status, mod] of CASES) {
  test(`SQLSTATE ${sqlstate} -> ${code}, no PHI in the body`, () => {
    const m = mapDatabaseError(pg(sqlstate), mod ?? 'kernel');
    assert.equal(m.code, code);
    assert.equal(m.status, status);
    const body = JSON.stringify(toProblem(m, '0192-test'));
    assert.ok(!body.includes('CANARY'), body);
    assert.ok(!body.includes('Jane'), body);
  });
}

test('PS002 uses the reason code of DETAIL only when it has the registry shape', () => {
  assert.equal(
    mapDatabaseError(pg('PS002', { detail: 'scheduling.max_future_reached' }), 'scheduling').code,
    'scheduling.max_future_reached',
  );
  const bad = mapDatabaseError(pg('PS002', { detail: `reason ${CANARY}` }), 'scheduling');
  assert.ok(!JSON.stringify(toProblem(bad, 'r')).includes('CANARY'));
  assert.equal(bad.status, 422);
});

test('42501 is 404 for a by-ID write and audited', () => {
  const m = mapDatabaseError(pg('42501'), 'scheduling', { byIdWrite: true });
  assert.deepEqual([m.status, m.code, m.audit], [404, 'kernel.not_found', true]);
  assert.equal(mapDatabaseError(pg('42501'), 'scheduling').audit, true);
});

test('40001/40P01 are retried internally first, then 503 kernel.unavailable', () => {
  assert.equal(mapDatabaseError(pg('40P01'), 'kernel').internalRetry, true);
  assert.equal(
    mapDatabaseError(pg('40P01'), 'kernel', { retriesExhausted: true }).internalRetry,
    false,
  );
});

test('an unknown module cannot inject text into a code', () => {
  assert.equal(mapDatabaseError(pg('PS001'), `x.${CANARY}`).code, 'kernel.invalid_transition');
});

test('non-object errors map to 500 without throwing', () => {
  for (const e of [undefined, null, 'boom', 42])
    assert.equal(mapDatabaseError(e, 'kernel').status, 500);
});
