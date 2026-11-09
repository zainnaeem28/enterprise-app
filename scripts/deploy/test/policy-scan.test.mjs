// The policy scan must catch what the acceptance criteria forbid: mutate a copy of the real files and expect failure.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmp } from './helpers.mjs';

const repo = join(import.meta.dirname, '../../..');
const scan = join(repo, 'scripts/deploy/policy-scan.mjs');

function copy() {
  const d = tmp();
  mkdirSync(join(d, '.github/workflows'), { recursive: true });
  for (const w of ['deploy-staging.yml', 'deploy-production.yml', 'deploy-marketing.yml'])
    cpSync(join(repo, '.github/workflows', w), join(d, '.github/workflows', w));
  cpSync(join(repo, 'scripts/deploy'), join(d, 'scripts/deploy'), { recursive: true });
  return d;
}
const run = (d) => spawnSync('node', [scan, d], { encoding: 'utf8' });
const mutate = (d, file, from, to) => {
  const p = join(d, file);
  const s = readFileSync(p, 'utf8');
  assert.ok(s.includes(from), `mutation target not found: ${from}`);
  writeFileSync(p, s.replace(from, to));
};
const P = '.github/workflows/deploy-production.yml';

test('unmodified files pass', () => assert.equal(run(copy()).status, 0, run(copy()).stderr));

for (const [name, file, from, to, expect] of [
  [
    'push trigger added',
    P,
    'on:\n  workflow_dispatch:',
    'on:\n  push:\n    branches: [main]\n  workflow_dispatch:',
    /workflow_dispatch only/,
  ],
  [
    'cancel-in-progress true',
    P,
    'cancel-in-progress: false',
    'cancel-in-progress: true',
    /production-release/,
  ],
  [
    'concurrency group renamed',
    P,
    'group: production-release',
    'group: prod',
    /production-release/,
  ],
  ['secret used', P, 'GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.PAT }}', /secrets/],
  ['record not read', P, '/approved/release', '/approved/other', /\/approved\/release/],
  [
    'verify removed',
    P,
    'verify-release.mjs --manifest "$WORK/current',
    'echo --manifest "$WORK/current',
    /does not run verify-release/,
  ],
  ['observe not read-only', P, "DEPLOY_READ_ONLY: '1'", 'FOO: x', /DEPLOY_READ_ONLY/],
  [
    'observe mutates',
    P,
    'node scripts/deploy/observe.mjs',
    'node scripts/deploy/rollout.mjs',
    /mutating/,
  ],
  ['recover not gated', P, "rollout_started == 'true' && ", '', /rollout_started/],
  ['gate removed', P, 'needs: [enabled]', 'needs: []', /enabled/],
  [
    'account id literal',
    P,
    'AWS_REGION: ${{ vars.DEPLOY_AWS_REGION }}',
    'AWS_REGION: ${{ vars.DEPLOY_AWS_REGION }}\n  ACC: "123456789012"',
    /account id/,
  ],
  [
    'permissions widened',
    P,
    'permissions: {}\n\n# One production',
    'permissions: write-all\n\n# One production',
    /permissions/,
  ],
  [
    'swallowed failure',
    '.github/workflows/deploy-staging.yml',
    'node scripts/deploy/smoke.mjs',
    'node scripts/deploy/smoke.mjs || true; #',
    /swallowed/,
  ],
  [
    'script registers a task definition',
    'scripts/deploy/rollout.mjs',
    "'update-service'",
    "'register-task-definition'",
    /registers a task definition/,
  ],
]) {
  test(`policy scan catches: ${name}`, () => {
    const d = copy();
    mutate(d, file, from, to);
    const r = run(d);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, expect);
  });
}
