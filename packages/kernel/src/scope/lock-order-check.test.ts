import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLockOrder, checkSignInCallSites } from './lock-order-check.js';

const good = `
export const confirm = (db) => db.withScope(scope, async (tx) => {
  await tx.lockPatients([id], 'no_key_update');
  await tx.callScopeOwner('patient.ensure_care_relationship', [id]);
});`;

const noLock = `
export const confirm = (db) => db.withScope(scope, async (tx) => {
  await tx.query('SELECT patient.complete_merge($1)', [id]);
});`;

const wrongOrder = `
db.withScope(scope, async (tx) => {
  await tx.callScopeOwner('patient.begin_merge', [a, b]);
  await tx.lockPatients([a, b], 'no_key_update');
});`;

test('passes when lockPatients comes first', () =>
  assert.deepEqual(checkLockOrder('a.ts', good), []));

test('fails a handler that calls a patient_scope_owner function without lockPatients', () => {
  const v = checkLockOrder('b.ts', noLock);
  assert.deepEqual(
    v.map((x) => x.rule),
    ['lock-order'],
  );
  assert.equal(v[0]!.line, 3);
});

test('fails when lockPatients is after the call', () => {
  assert.deepEqual(
    checkLockOrder('c.ts', wrongOrder).map((x) => x.rule),
    ['lock-order'],
  );
});

test('fails a call outside any withScope callback', () => {
  const v = checkLockOrder(
    'd.ts',
    `export const x = (tx) => tx.query('SELECT patient.register($1)', [1]);`,
  );
  assert.deepEqual(
    v.map((x) => x.rule),
    ['outside-scope'],
  );
});

test('comments do not count as a lock or as a call', () => {
  assert.equal(
    checkLockOrder(
      'e.ts',
      `db.withScope(s, async (tx) => { // lockPatients( patient.begin_merge\n await tx.callScopeOwner('patient.begin_merge', []); });`,
    ).length,
    1,
  );
  assert.deepEqual(
    checkLockOrder('f.ts', `// patient.begin_merge is described here\nexport const a = 1;`),
    [],
  );
});

test('two handlers in one file are judged separately', () => {
  assert.equal(checkLockOrder('g.ts', `${good}\n${noLock}`).length, 1);
});

test('generic type argument on withScope is understood', () => {
  assert.deepEqual(
    checkLockOrder(
      'h.ts',
      `db.withScope<number>(s, async (tx) => { await tx.lockPatients([a],'no_key_update'); await tx.callScopeOwner('patient.attach', []); });`,
    ),
    [],
  );
});

test('sign-in setter call sites are limited to the allowed files', () => {
  const src = `tx.setAuthIdentity({ realm: 'google', subject: 's' });`;
  const allowed = (f: string): boolean => f.startsWith('apps/api/src/modules/identity/signin/');
  assert.equal(checkSignInCallSites('apps/api/src/modules/patient/x.ts', src, allowed).length, 1);
  assert.equal(
    checkSignInCallSites('apps/api/src/modules/identity/signin/google.ts', src, allowed).length,
    0,
  );
});
