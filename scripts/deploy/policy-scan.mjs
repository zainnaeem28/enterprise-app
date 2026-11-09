#!/usr/bin/env node
// Policy scan for the three deploy workflows and scripts/deploy (DO-06 acceptance, C-01). Line-based like
// scripts/ci/check-workflow-hygiene.mjs (which still runs over these files too). Fails on:
//   all three: any trigger but workflow_dispatch; `secrets.` other than none; static AWS keys; top-level permissions
//     missing/not `{}`; an enabled-gate job missing; an account id (12 digits) or ARN literal in the file;
//   production: concurrency group production-release with cancel-in-progress false; id-token only in jobs that name an
//     environment; the observe job has contents: read + id-token only and sets DEPLOY_READ_ONLY=1; a recover job gated on
//     rollout_started; the verify step reading /approved/release;
//   scripts: any `register-task-definition`, `execute-command`, `--overrides`, `aws iam`, `put-parameter` on /approved
//     (outside the guard lists in lib/aws.mjs and this file), `|| true`.
// Usage: node policy-scan.mjs [repoRoot]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '../..'));
const problems = [];
const fail = (file, msg) => problems.push(`${file}: ${msg}`);
const read = (f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : null);
const strip = (t) =>
  t
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');

const workflows = ['deploy-staging.yml', 'deploy-production.yml', 'deploy-marketing.yml'];
for (const w of workflows) {
  const file = `.github/workflows/${w}`;
  const raw = read(file);
  if (raw === null) {
    fail(file, 'missing');
    continue;
  }
  const t = strip(raw);
  const triggers = /^on:\s*\n((?:[ ]{2,}.*\n|\n)+)/m.exec(t)?.[1] ?? '';
  const names = [...triggers.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
  if (names.length !== 1 || names[0] !== 'workflow_dispatch')
    fail(file, `triggers must be workflow_dispatch only, found: ${names.join(', ') || 'none'}`);
  if (/\bsecrets\./.test(t) || /secrets:\s*inherit/.test(t))
    fail(file, 'uses secrets.*: the file must hold no environment secret (C-01)');
  if (/AWS_ACCESS_KEY_ID\s*:|AWS_SECRET_ACCESS_KEY\s*:|aws-actions\/|role-to-assume/.test(t))
    fail(file, 'static AWS key or login action');
  if (!/^permissions:\s*\{\}\s*$/m.test(t)) fail(file, 'top-level `permissions: {}` is required');
  if (/\b\d{12}\b/.test(t) || /arn:aws:/.test(t))
    fail(file, 'account id or ARN literal in the workflow (use environment variables)');
  if (!/^ {2}enabled:\s*$/m.test(t) || !/DEPLOY_[A-Z]+_ENABLED/.test(t))
    fail(
      file,
      'the `enabled` gate job (DEPLOY_*_ENABLED) is missing: the workflow would be live when enabled in GitHub',
    );
  if (!/needs:\s*\[enabled\]/.test(t)) fail(file, 'no job needs the `enabled` gate');
  if (/continue-on-error|\|\|\s*true\b/.test(t)) fail(file, 'swallowed failure');
  // id-token only with an environment in the same job
  for (const jm of t.matchAll(/^ {2}([a-z-]+):\n((?: {4}.*\n|\n)+)/gm)) {
    const [, name, body] = jm;
    if (/id-token:\s*write/.test(body) && !/^ {4}environment:/m.test(body))
      fail(file, `job ${name} has id-token: write without an environment`);
  }
}

const prod = read('.github/workflows/deploy-production.yml');
if (prod) {
  const t = strip(prod);
  if (!/concurrency:\s*\n\s+group:\s*production-release\s*\n\s+cancel-in-progress:\s*false/.test(t))
    fail(
      'deploy-production.yml',
      'concurrency must be group production-release with cancel-in-progress: false',
    );
  const deploy = /^ {2}deploy:\n((?: {4}.*\n|\n)+)/m.exec(t)?.[1] ?? '';
  if (!/\/approved\/release\b/.test(deploy))
    fail('deploy-production.yml', 'the deploy job does not read the record at /approved/release');
  if (!/verify-release\.mjs[^\n]*current\/release-manifest\.json/.test(deploy))
    fail(
      'deploy-production.yml',
      'the deploy job does not run verify-release.mjs on the manifest (digest = record)',
    );
  // the verification must come before anything that changes the environment
  const at = (re) => deploy.search(re);
  for (const mut of [
    /run-migration\.mjs/,
    /rollout\.mjs/,
    /portal-switch\.mjs/,
    /set-release-config\.mjs/,
  ])
    if (at(mut) !== -1 && at(/verify-release\.mjs/) > at(mut))
      fail('deploy-production.yml', `${mut.source} runs before verify-release.mjs`);
  const observe = /^ {2}observe:\n((?: {4}.*\n|\n)+)/m.exec(t)?.[1] ?? '';
  if (!observe) fail('deploy-production.yml', 'no observe job');
  else {
    if (!/DEPLOY_READ_ONLY:\s*'1'/.test(observe))
      fail('deploy-production.yml', 'observe job does not set DEPLOY_READ_ONLY=1');
    if (!/gh-observe-production/.test(observe))
      fail('deploy-production.yml', 'observe job does not use gh-observe-production');
    if (
      /run-migration|rollout\.mjs|update-service|set-release-config|portal-switch|put-|delete-|create-/.test(
        observe,
      )
    )
      fail('deploy-production.yml', 'observe job contains a mutating command');
    const perms = /permissions:\n((?: {6}.*\n)+)/.exec(observe)?.[1] ?? '';
    if (/write/.test(perms.replace(/id-token:\s*write/, '')))
      fail('deploy-production.yml', 'observe job has write permissions beyond id-token');
  }
  const recover = /^ {2}recover:\n((?: {4}.*\n|\n)+)/m.exec(t)?.[1] ?? '';
  if (!/rollout_started == 'true'/.test(recover))
    fail('deploy-production.yml', 'recover job is not gated on rollout_started');
  if (!/gh-recover-production/.test(recover) || !/\/approved\/recover/.test(recover))
    fail(
      'deploy-production.yml',
      'recover job must use gh-recover-production and the recover record',
    );
  if (/run-migration/.test(recover))
    fail('deploy-production.yml', 'a rollback never runs a migration (8.1)');
}

const walk = (d) =>
  existsSync(d)
    ? readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() && n !== 'test' && n !== 'fixtures'
          ? walk(p)
          : statSync(p).isFile()
            ? [p]
            : [];
      })
    : [];
const forbidden = [
  [/register-task-definition/, 'registers a task definition (only platform-admin-apply may, 7.5)'],
  [/execute-command/, 'ecs execute-command (7.2)'],
  [/--overrides/, 'RunTask overrides (7.5, DPR-28)'],
  [/\baws\s+iam\b|'iam'/, 'IAM call'],
  [/\|\|\s*true\b/, 'swallowed failure'],
  [
    /\/approved\//,
    'touches /approved/* (only the read of the record in a workflow step; never a script)',
  ],
];
// lib/aws.mjs and this file legitimately NAME the forbidden things in order to refuse them.
const guardFiles = new Set([
  'scripts/deploy/lib/aws.mjs',
  'scripts/deploy/policy-scan.mjs',
  'scripts/deploy/set-release-config.mjs',
  'scripts/deploy/README.md',
]);
for (const f of walk(join(root, 'scripts/deploy')).filter((x) => /\.(mjs|sh)$/.test(x))) {
  const rel = relative(root, f);
  if (guardFiles.has(rel)) continue;
  const t = strip(readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  for (const [re, why] of forbidden) if (re.test(t)) fail(rel, why);
}

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  console.error(`deploy policy scan: ${problems.length} violation(s)`);
  process.exit(1);
}
console.log(
  `deploy policy scan: ${workflows.length} workflows and scripts/deploy checked, no violations`,
);
