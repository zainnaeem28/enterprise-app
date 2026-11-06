// Unit-test gate. Runs every workspace `test` script and the root boundary test, then requires a
// JUnit report per suite under reports/unit/. Fails when: no suite exists, a suite exits non-zero,
// a report is missing/malformed, a suite ran zero tests, or any test was skipped.
//
// Contract for workspace packages: every package with a `test` script must write JUnit XML to $JUNIT_DIR/<anything>.xml
// (for example `node --test --test-reporter=junit --test-reporter-destination=$JUNIT_DIR/kernel.xml`).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const outDir = join(process.env.REPORT_ROOT ?? join(root, 'reports'), 'unit');
const junitDir = join(outDir, 'junit');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(junitDir, { recursive: true });

const failures = [];
const run = (label, cmd, args, extraEnv = {}) => {
  console.log(`\n== ${label}: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, JUNIT_DIR: junitDir, ...extraEnv },
  });
  if (r.status !== 0) failures.push(`${label} exited with ${r.status ?? r.signal}`);
  return r.status === 0;
};

// Build prerequisite: workspace packages import @ehr/kernel and @ehr/contracts through their dist/,
// which a clean checkout does not have. Build them first (same order as the root typecheck script).
run('build prerequisites', 'pnpm', [
  '--filter',
  '@ehr/kernel',
  '--filter',
  '@ehr/contracts',
  'run',
  'build',
]);

// Root boundary test (F-01): a failing and a passing fixture. Wrapped into a JUnit record here.
const boundaryOk = run('boundary', 'pnpm', ['run', 'test:boundary']);
writeFileSync(
  join(junitDir, 'boundary.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="boundary" tests="1" failures="${boundaryOk ? 0 : 1}" skipped="0">` +
    `<testcase classname="boundary" name="upward import rejected, downward import accepted">${boundaryOk ? '' : '<failure message="test:boundary failed"/>'}</testcase></testsuite></testsuites>\n`,
);

// Workspace suites. Every package that defines a `test` script is a suite and MUST write at least
// one JUnit report into its own $JUNIT_DIR; a script that exits 0 without a report fails.
const ls = spawnSync('pnpm', ['-r', 'ls', '--json', '--depth', '-1'], {
  cwd: root,
  encoding: 'utf8',
});
if (ls.status !== 0) failures.push(`pnpm ls failed: ${ls.stderr}`);
const pkgs = ls.status === 0 ? JSON.parse(ls.stdout) : [];
for (const p of pkgs) {
  if (resolve(p.path) === root) continue;
  const scripts = JSON.parse(readFileSync(join(p.path, 'package.json'), 'utf8')).scripts ?? {};
  if (!scripts.test) continue;
  const name = (p.name ?? p.path).replace(/[^A-Za-z0-9_.-]/g, '_');
  const dir = join(junitDir, name);
  mkdirSync(dir, { recursive: true });
  run(`test ${p.name ?? p.path}`, 'pnpm', ['--dir', p.path, 'run', 'test'], { JUNIT_DIR: dir });
  if (!readdirSync(dir).some((f) => f.endsWith('.xml')))
    failures.push(
      `${p.name ?? p.path}: test script wrote no JUnit report to $JUNIT_DIR (a suite that runs nothing fails)`,
    );
}

let tests = 0;
let skipped = 0;
let failed = 0;
const reports = readdirSync(junitDir, { recursive: true }).filter((f) => f.endsWith('.xml'));
for (const f of reports) {
  const xml = readFileSync(join(junitDir, f), 'utf8');
  if (!/<testsuite[ s>]/.test(xml)) {
    failures.push(`${f}: not a JUnit report`);
    continue;
  }
  const cases = (xml.match(/<testcase[\s>]/g) ?? []).length;
  const skips = (xml.match(/<skipped[\s/>]/g) ?? []).length;
  const fails = (xml.match(/<(failure|error)[\s/>]/g) ?? []).length;
  console.log(`${f}: ${cases} tests, ${skips} skipped, ${fails} failed`);
  if (cases === 0) failures.push(`${f}: suite ran zero tests`);
  tests += cases;
  skipped += skips;
  failed += fails;
}
if (skipped > 0) failures.push(`${skipped} skipped test(s): skipped tests count as failure`);
if (failed > 0) failures.push(`${failed} failed test case(s) in reports`);
if (tests === 0) failures.push('no tests ran (an empty suite fails)');

writeFileSync(
  join(outDir, 'summary.json'),
  JSON.stringify({ reports, tests, skipped, failed, failures }, null, 2),
);
if (failures.length > 0) {
  for (const f of failures) console.error(`::error::${f}`);
  process.exit(1);
}
console.log(`unit: ${tests} tests in ${reports.length} report(s), none skipped or failed`);
