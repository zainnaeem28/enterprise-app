import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const text = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/restore-test.yml', import.meta.url)),
  'utf8',
);
const job = (name) => {
  const m = text.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:\\n|(?![\\s\\S]))`, 'm'),
  );
  assert.ok(m, `job ${name} exists`);
  return m[1];
};

test('authored disabled: refuses unless RESTORE_TEST_ENABLED is true and the ref is main', () => {
  const j = job('enabled');
  assert.match(j, /refs\/heads\/main/);
  assert.match(j, /vars\.RESTORE_TEST_ENABLED/);
  assert.match(j, /\[ "\$ENABLED" = "true" \]/);
  assert.match(job('restore'), /needs: \[enabled\]/);
});

test('workflow permissions are empty at top level and minimal per job', () => {
  assert.match(text, /^permissions: \{\}$/m);
  const r = job('restore');
  assert.match(r, /contents: read/);
  assert.match(r, /id-token: write/);
  assert.doesNotMatch(r, /(write-all|contents: write|actions: write)/);
});

test('teardown of the target always runs and restores are serialised', () => {
  const r = job('restore');
  assert.match(r, /if: \$\{\{ always\(\) && steps\.start\.outputs\.target != '' \}\}/);
  assert.match(r, /teardown\.mjs --target/);
  assert.match(r, /max-parallel: 1/);
  assert.match(text, /cancel-in-progress: false/);
});

test('every action is pinned to a full commit SHA', () => {
  const uses = [...text.matchAll(/^\s*- uses: (\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
});

test('the runner makes API calls only: no database client, no secrets context', () => {
  assert.doesNotMatch(text, /\b(psql|pg_dump|pg_restore)\b/);
  assert.doesNotMatch(text, /\$\{\{\s*secrets\./);
});
