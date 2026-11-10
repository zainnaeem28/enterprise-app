import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (n) =>
  readFileSync(fileURLToPath(new URL(`../../../.github/workflows/${n}`, import.meta.url)), 'utf8');
// The text of every `run:` step: the same line, or the indented block under `run: |`.
function runBodies(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let body = m[2] === '|' ? '' : m[2];
    const indent = m[1].length;
    while (
      i + 1 < lines.length &&
      (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > indent)
    )
      body += `\n${lines[++i]}`;
    out.push(body);
  }
  return out;
}
const wfs = {
  'bootstrap.yml': read('bootstrap.yml'),
  'audit-archive.yml': read('audit-archive.yml'),
};

for (const [name, text] of Object.entries(wfs)) {
  test(`${name}: manual only, empty top-level permissions, no secrets context, SHA-pinned actions`, () => {
    assert.match(text, /^on:\n {2}workflow_dispatch:/m);
    assert.doesNotMatch(text, /^\s+(push|pull_request|pull_request_target|schedule):/m);
    assert.match(text, /^permissions: \{\}$/m);
    assert.doesNotMatch(text, /\$\{\{\s*secrets\./);
    assert.doesNotMatch(text, /(write-all|contents: write)/);
    for (const m of text.matchAll(/^\s*- uses: (\S+)/gm))
      assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
    assert.match(text, /cancel-in-progress: false/);
  });
  test(`${name}: authored disabled, main only, no inline expression in any run script`, () => {
    assert.match(text, /refs\/heads\/main/);
    assert.match(text, /\[ "\$ENABLED" = "true" \]/);
    assert.match(text, /needs: \[enabled\]/);
    for (const body of runBodies(text))
      assert.doesNotMatch(body, /\$\{\{/, 'expressions go through env:, never into a script');
    assert.doesNotMatch(text, /\b(psql|pg_dump)\b/);
  });
}

test('bootstrap.yml: the environment is the only input and the cleanup and rotation steps always run after login', () => {
  const t = wfs['bootstrap.yml'];
  assert.equal([...t.matchAll(/^ {6}[a-z_]+:\n {8}description/gm)].length, 1);
  assert.match(t, /environment: bootstrap-\$\{\{ inputs\.environment \}\}/);
  assert.match(t, /group: bootstrap-\$\{\{ inputs\.environment \}\}/);
  assert.match(
    t,
    /if: \$\{\{ always\(\) && steps\.login\.outcome == 'success' \}\}\n {8}run: node scripts\/bootstrap\/cleanup\.mjs/,
  );
  assert.match(
    t,
    /if: \$\{\{ always\(\) && steps\.login\.outcome == 'success' \}\}\n {8}run: node scripts\/bootstrap\/rotate-credential\.mjs/,
  );
  assert.doesNotMatch(t, /--(custodian|enrollee|handle|token|person)/);
});
test('audit-archive.yml: environment audit-archive, record read before the task', () => {
  const t = wfs['audit-archive.yml'];
  assert.match(t, /environment: audit-archive/);
  assert.ok(t.indexOf('/approved/audit-archive') < t.indexOf('audit-archive/run-task.mjs'));
});
