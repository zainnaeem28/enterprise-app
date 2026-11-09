import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_IDS, SCHEMA, summarise, validateResult } from '../lib/result.mjs';

const check = (id, o = {}) => ({ id, status: 'pass', reason: 'none', duration_ms: 5, ...o });
const doc = (o = {}) => ({
  schema: SCHEMA, run_id: '20261109-42-1', mode: 'pitr', image_digest: `sha256:${'a'.repeat(64)}`, overall: 'pass', restore_point_age_seconds: 600,
  timings_seconds: { restore: 1200, credentials_reset: 90, checks: 300, total: 1590 },
  checks: CHECK_IDS.map((id) => check(id)), ...o,
});

test('a complete, PHI-free document validates and summarises', () => {
  assert.deepEqual(validateResult(doc()), []);
  assert.match(summarise(doc()), /restore test 20261109-42-1: pass/);
});

test('free text, unknown keys and values that are not numbers or digests are refused (PHI canary)', () => {
  const canary = 'PHI-CANARY-Jane-Doe-1975-01-01';
  const withCounts = (counts) => doc({ checks: CHECK_IDS.map((id) => (id === 'row-counts' ? check(id, { counts }) : check(id))) });
  assert.match(validateResult(withCounts({ audit_event: canary })).join(), /not a non-negative integer/);
  assert.match(validateResult(withCounts({ [canary]: 1 })).join(), /key is not an identifier/);
  assert.match(validateResult(doc({ note: canary })).join(), /unexpected key "note"/);
  const hashed = doc({ checks: CHECK_IDS.map((id) => (id === 'checksums' ? check(id, { hashes: { t: canary } }) : check(id))) });
  assert.match(validateResult(hashed).join(), /not a sha256/);
  const message = doc({ overall: 'fail', checks: CHECK_IDS.map((id) => (id === 'schema-version' ? check(id, { status: 'fail', reason: canary }) : check(id))) });
  assert.match(validateResult(message).join(), /not a known reason code/);
  assert.match(validateResult(doc({ run_id: canary })).join(), /run_id/);
  assert.match(validateResult(doc({ checks: [...doc().checks, { ...check('schema-version'), extra: canary }] })).join(), /unexpected key "extra"/);
  for (const problems of [validateResult(withCounts({ [canary]: 1 })), validateResult(withCounts({ audit_event: canary })), validateResult(message)])
    assert.ok(!problems.join().includes('Jane'), 'validator messages never echo a value');
});

test('a missing check is not a pass, and overall must follow the checks', () => {
  assert.match(validateResult(doc({ checks: doc().checks.slice(1) })).join(), /"credentials-reset" is missing/);
  const failing = doc({ checks: CHECK_IDS.map((id) => (id === 'catalogue-rls' ? check(id, { status: 'fail', reason: 'catalogue_violation', violations: 2 }) : check(id))) });
  assert.match(validateResult(failing).join(), /overall "pass" does not match/);
  assert.deepEqual(validateResult({ ...failing, overall: 'fail' }), []);
  const partial = doc({ overall: 'partial', checks: CHECK_IDS.map((id) => (id === 'checksums' ? check(id, { status: 'partial', reason: 'baseline_unavailable' }) : check(id))) });
  assert.deepEqual(validateResult(partial), []);
  assert.match(validateResult({ ...partial, overall: 'pass' }).join(), /does not match/);
});

test('a pass cannot carry a reason and a non-pass must', () => {
  const bad = doc({ checks: CHECK_IDS.map((id) => (id === 'checksums' ? check(id, { reason: 'check_error' }) : check(id))) });
  assert.match(validateResult(bad).join(), /a pass carries reason "none"/);
  const bad2 = doc({ overall: 'fail', checks: CHECK_IDS.map((id) => (id === 'checksums' ? check(id, { status: 'fail' }) : check(id))) });
  assert.match(validateResult(bad2).join(), /needs a reason code/);
});

test('summarise refuses an invalid document instead of printing it', () => {
  assert.throws(() => summarise(doc({ note: 'x' })), /result refused/);
});
