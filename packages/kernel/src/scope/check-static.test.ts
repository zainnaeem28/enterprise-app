import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('./check-static.js', import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

const dir = mkdtempSync(join(tmpdir(), 'f04-static-'));
writeFileSync(
  join(dir, 'bad-handler.ts'),
  `export const h = (db: any) => db.withScope(s, async (tx: any) => {\n  await tx.query("SELECT patient.complete_merge($1)", [1]);\n});\n`,
);
writeFileSync(
  join(dir, 'good-handler.ts'),
  `export const h = (db: any) => db.withScope(s, async (tx: any) => {\n  await tx.lockPatients([1], 'no_key_update');\n  await tx.query("SELECT patient.complete_merge($1)", [1]);\n});\n`,
);
writeFileSync(join(dir, 'signin.ts'), `setAuthIdentity(tx, id);\n`);

test('exits non-zero and names file, line and rule for a handler without lockPatients', () => {
  const r = run(join(dir, 'bad-handler.ts'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad-handler\.ts:2 lock-order/);
});

test('exits zero for a compliant handler', () => {
  const r = run(join(dir, 'good-handler.ts'));
  assert.equal(r.status, 0, r.stderr);
});

test('sign-in setter outside the allowed path fails, inside it passes', () => {
  assert.equal(run(join(dir, 'signin.ts')).status, 1);
  assert.equal(run('--signin-allow', 'signin.ts', join(dir, 'signin.ts')).status, 0);
});

test('scanning a directory finds the violating file', () => {
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad-handler\.ts/);
});

test('usage error exits 2', () => assert.equal(run().status, 2));
