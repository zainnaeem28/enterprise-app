// Guard (INT04-F22b): the CI admin fixture must never reach a deployed environment. Fails if any deploy-side file sets EHR_ENV=ci or
// mentions EHR_ADMIN_CI_FIXTURE. Scanned: every workflow and local action except the one job `admin-run` of ci.yml, and the
// deployment trees (infra/, docker/, scripts/deploy/, Dockerfiles). Only ci.yml's `admin-run` job may set either, and only there.
// Line-based like check-workflow-hygiene.mjs (no YAML dependency); comments are ignored.
// Usage: node check-ci-fixture-isolation.mjs [repoRoot]      node check-ci-fixture-isolation.mjs --selftest
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ALLOWED = { file: '.github/workflows/ci.yml', job: 'admin-run' };
const FLAG = /EHR_ADMIN_CI_FIXTURE/;
// EHR_ENV: ci / EHR_ENV=ci / -e EHR_ENV=ci / "EHR_ENV": "ci" / EHR_ENV: 'ci'
const ENV_CI = /EHR_ENV["']?\s*[:=]\s*["']?ci\b/;
const stripComment = (l) => l.replace(/(^|\s)#.*$/, '$1');

const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((n) => {
        if (n === 'node_modules' || n === '.git') return [];
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];

export function scan(root) {
  const files = [
    ...walk(join(root, '.github/workflows')),
    ...walk(join(root, '.github/actions')),
    ...walk(join(root, 'infra')),
    ...walk(join(root, 'docker')),
    ...walk(join(root, 'scripts/deploy')),
  ];
  const problems = [];
  for (const file of files) {
    const rel = relative(root, file);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    const isAllowedFile = rel === ALLOWED.file;
    let job = null;
    let inJobs = false;
    text.split('\n').forEach((raw, i) => {
      const l = stripComment(raw);
      if (isAllowedFile) {
        if (/^jobs:/.test(l)) inJobs = true;
        else if (/^\S/.test(l) && l.trim()) inJobs = false;
        const jm = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l) : null;
        if (jm) job = jm[1];
      }
      const hit = FLAG.test(l) ? 'EHR_ADMIN_CI_FIXTURE' : ENV_CI.test(l) ? 'EHR_ENV=ci' : null;
      if (hit === null) return;
      if (isAllowedFile && job === ALLOWED.job) return;
      problems.push(
        `${rel}:${i + 1}: ${hit} is set outside the ${ALLOWED.file} job ${ALLOWED.job} (the CI admin fixture must never reach a deployed environment)`,
      );
    });
  }
  return { problems, scanned: files.length };
}

function selftest() {
  const d = mkdtempSync(join(tmpdir(), 'fixture-guard-'));
  const w = (p, c) => {
    mkdirSync(join(d, p, '..'), { recursive: true });
    writeFileSync(join(d, p), c);
  };
  try {
    w(
      '.github/workflows/ci.yml',
      'jobs:\n  admin-run:\n    env:\n      EHR_ADMIN_CI_FIXTURE: "1"\n      EHR_ENV: ci\n  other:\n    steps: []\n',
    );
    w(
      '.github/workflows/deploy-staging.yml',
      'jobs:\n  d:\n    env:\n      EHR_ENV: staging # EHR_ENV: ci\n',
    );
    assert.deepEqual(scan(d).problems, [], 'allowed job and comments are clean');
    for (const [name, body] of [
      ['.github/workflows/deploy-production.yml', 'env:\n  EHR_ENV: ci\n'],
      ['.github/workflows/deploy-staging.yml', "env:\n  EHR_ENV: 'ci'\n"],
      ['.github/workflows/build-release.yml', 'run: docker run -e EHR_ENV=ci x\n'],
      ['.github/workflows/deploy-marketing.yml', 'env:\n  EHR_ADMIN_CI_FIXTURE: "1"\n'],
      [
        'infra/task.json',
        '{"name": "EHR_ENV", "value": "ci"}\n'.replace(
          '"name": "EHR_ENV", "value": "ci"',
          '"EHR_ENV": "ci"',
        ),
      ],
      [
        '.github/workflows/ci.yml',
        'jobs:\n  admin-run:\n    steps: []\n  other:\n    env:\n      EHR_ADMIN_CI_FIXTURE: "1"\n',
      ],
    ]) {
      const e = mkdtempSync(join(tmpdir(), 'fixture-guard-'));
      try {
        mkdirSync(join(e, '.github/workflows'), { recursive: true });
        mkdirSync(join(e, name, '..'), { recursive: true });
        writeFileSync(join(e, name), body);
        assert.equal(scan(e).problems.length, 1, `seeded violation in ${name} is caught`);
      } finally {
        rmSync(e, { recursive: true, force: true });
      }
    }
    console.log(
      'ci-fixture isolation self-test: allowed job and comments pass, 6 seeded violations fail',
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--selftest')) selftest();
  else {
    const root = resolve(process.argv[2] ?? join(import.meta.dirname, '../..'));
    const { problems, scanned } = scan(root);
    if (scanned === 0) {
      console.error('::error::no deploy-side files found to scan (wrong root?)');
      process.exit(1);
    }
    for (const p of problems) console.error(`::error::${p}`);
    if (problems.length > 0) process.exit(1);
    console.log(
      `ci-fixture isolation: ${scanned} file(s) scanned, the fixture is set nowhere outside the admin-run job`,
    );
  }
}
