// Harness test for check-junit.mjs schema-growth pins (HEAAA-914): matching growth passes as a pin; one extra name, one missing name,
// a removed entry, an unlisted test, a non-list assertion and a stale pin each fail.  node --test scripts/ci/migration-check/check-junit.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const T1 = 'every identity table has ENABLE and FORCE row level security, a data class and no PUBLIC policy';
const T2 = 'app_api has no UPDATE of identity columns beyond the 21.2 list; app_worker none on principal or person';
const P = 'apps/api/dist/src/modules/identity/rls.dbtest.js';
const TABLES = ['admin_credential', 'proxy_grant', 'push_subscription', 'role'];
const COLS = ['revoke_reason', 'revoked_at', 'status'];
const NEW_COLS = ['accepted_at', 'ended_by', 'proxy_principal_id', 'scopes'];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const list = (a) => `[ ${a.map((x) => `'${x}'`).join(', ')} ]`;
function failure({ actual, expected, line, operator = 'deepStrictEqual' }) {
  const body = [
    'Error [ERR_TEST_FAILURE]: Expected values to be strictly deep-equal:',
    '  code: \'ERR_TEST_FAILURE\',',
    '  cause: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:',
    `      at TestContext.<anonymous> (file:///tmp/previous-release-tree/${P}:${line}:16)`,
    '    generatedMessage: true,',
    `    actual: ${actual},`,
    `    expected: ${expected},`,
    `    operator: '${operator}',`,
    '    diff: \'simple\'',
  ].join('\n');
  return `<failure type="testCodeFailure" message="x">${esc(body)}</failure>`;
}
const tc = (name, inner = '') => `<testcase name="${esc(name)}" file="/tmp/previous-release-tree/${P}">${inner}</testcase>`;

function run(cases, pinRows = [[T1, 96, 'growth:proxy_invite_code'], [T2, 172, `growth:${NEW_COLS.join(',')}`]]) {
  const dir = mkdtempSync(join(tmpdir(), 'cj-'));
  writeFileSync(join(dir, 'api.xml'), `<testsuites>${cases.join('')}</testsuites>`);
  writeFileSync(join(dir, 'pins.tsv'), pinRows.map(([n, l, g]) => ['api', n, `${P}:${l}`, g, 'r'].join('\t')).join('\n') + '\n');
  writeFileSync(join(dir, 'cat.mjs'), 'export const definerInventory = new Array(41).fill(0);\n');
  const r = spawnSync(process.execPath, [join(HERE, 'check-junit.mjs'), '--pins', join(dir, 'pins.tsv'), '--catalog', join(dir, 'cat.mjs'), '--report', join(dir, 'rep.txt'), dir, 'api'], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}
const f1 = (o = {}) => tc(T1, failure({ line: 96, actual: list([...TABLES, 'proxy_invite_code']), expected: list(TABLES), ...o }));
const f2 = (o = {}) => tc(T2, failure({ line: 172, actual: list([...COLS, ...NEW_COLS].sort()), expected: list(COLS), ...o }));

test('exact additive growth passes as a pin (reported, not a pass)', () => {
  const r = run([f1(), f2()]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /N-1 PIN \(not a pass\)/);
});
test('one extra name fails', () => {
  assert.equal(run([f1({ actual: list([...TABLES, 'proxy_invite_code', 'extra_table']) }), f2()]).status, 1);
  assert.equal(run([f1(), f2({ actual: list([...COLS, ...NEW_COLS, 'surprise'].sort()) })]).status, 1);
});
test('one missing name fails', () => {
  assert.equal(run([f1(), f2({ actual: list([...COLS, 'accepted_at', 'ended_by', 'scopes'].sort()) })]).status, 1);
});
test('a removed entry fails', () => {
  assert.equal(run([f1({ actual: list(['admin_credential', 'proxy_grant', 'proxy_invite_code', 'push_subscription']) }), f2()]).status, 1);
  assert.equal(run([f1(), f2({ actual: list([...COLS.slice(1), ...NEW_COLS].sort()) })]).status, 1);
});
test('a reordered entry fails', () => {
  assert.equal(run([f1({ actual: list(['proxy_invite_code', 'role', ...TABLES.slice(0, 3)]) }), f2()]).status, 1);
});
test('an unlisted test with the same failure fails', () => {
  const r = run([tc('some other list test', failure({ line: 50, actual: list([...TABLES, 'proxy_invite_code']), expected: list(TABLES) })), f1(), f2()]);
  assert.equal(r.status, 1);
  assert.match(r.out, /api: 3 test\(s\), 1 failure\(s\)/);
});
test('a non-list or different assertion fails', () => {
  assert.equal(run([f1({ operator: 'strictEqual' }), f2()]).status, 1);
  assert.equal(run([f1({ actual: '41', expected: '36' }), f2()]).status, 1);
  assert.equal(run([f1({ line: 97 }), f2()]).status, 1);
});
test('a growth pin outside the allowed tests and names fails', () => {
  const rows = [[T1, 96, 'growth:proxy_invite_code,other_table'], [T2, 172, `growth:${NEW_COLS.join(',')}`]];
  assert.equal(run([f1({ actual: list([...TABLES, 'proxy_invite_code', 'other_table']) }), f2()], rows).status, 1);
});
test('a stale pin (test passes) fails', () => {
  const r = run([tc(T1), f2()]);
  assert.equal(r.status, 1);
  assert.match(r.out, /PIN is stale/);
});
