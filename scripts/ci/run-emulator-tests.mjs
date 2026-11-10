// `pnpm test:emulator`: runs every `*.emulator.test.ts` in the repository with the Node test runner (TypeScript is
// type-stripped by Node 24, so tests use erasable syntax only and import workspace packages through their built dist/).
//
// Convention for backend tickets: name a test `<anything>.emulator.test.ts` next to the code it covers. The AWS-shaped
// endpoint and DUMMY credentials come from the environment (docs/runbooks/emulator-tests.md); a test reads
// `process.env.AWS_ENDPOINT_URL` and must skip itself with a clear message when that is unset, so a developer without
// Docker still gets a clean local run. Results are EMULATOR evidence only, never proof of a cloud behaviour.
//
// With no matching test the script passes cleanly (and says so). A matched file that runs zero tests, or whose tests are
// all skipped, FAILS when --require-endpoint is given (the CI job), so a silently skipped suite cannot look green.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = resolve(process.env.EMULATOR_TEST_ROOT ?? resolve(import.meta.dirname, '../..'));
const requireEndpoint = process.argv.includes('--require-endpoint');
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.ci-tools',
  'reports',
  '.next',
  'coverage',
]);

if (process.argv.includes('--selftest')) {
  // Three throwaway repositories: empty (must pass), one passing file (must pass), plus a failing file (must FAIL).
  const run = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'emu-selftest-'));
    for (const [n, body] of Object.entries(files)) writeFileSync(join(dir, n), body);
    const r = spawnSync(process.execPath, [self], {
      env: { ...process.env, EMULATOR_TEST_ROOT: dir, JUNIT_DIR: join(dir, 'junit') },
      stdio: 'pipe',
      encoding: 'utf8',
    });
    rmSync(dir, { recursive: true, force: true });
    return r.status;
  };
  const ok = "import test from 'node:test';\ntest('ok', () => {});\n";
  const bad =
    "import test from 'node:test';\nimport assert from 'node:assert';\ntest('bad', () => assert.fail('seeded'));\n";
  const results = [
    ['no tests passes', run({}) === 0],
    ['passing file passes', run({ 'a.emulator.test.ts': ok }) === 0],
    [
      'seeded failing file fails',
      run({ 'a.emulator.test.ts': ok, 'b.emulator.test.ts': bad }) !== 0,
    ],
  ];
  for (const [n, pass] of results) console.log(`${pass ? 'ok  ' : 'FAIL'} ${n}`);
  process.exit(results.every(([, p]) => p) ? 0 : 1);
}

const found = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.paperclip')) walk(join(dir, e.name));
    } else if (e.name.endsWith('.emulator.test.ts')) found.push(join(dir, e.name));
  }
};
walk(root);
found.sort();

if (found.length === 0) {
  console.log(
    'test:emulator: no *.emulator.test.ts files in the repository; nothing to run (pass).',
  );
  process.exit(0);
}
if (requireEndpoint && !process.env.AWS_ENDPOINT_URL) {
  console.error(
    '::error::test:emulator found tests but AWS_ENDPOINT_URL is not set; the emulator job must start LocalStack first',
  );
  process.exit(1);
}

const junitDir = process.env.JUNIT_DIR ?? join(root, 'reports', 'emulator');
mkdirSync(junitDir, { recursive: true });
console.log(
  `test:emulator: ${found.length} file(s)\n${found.map((f) => '  ' + relative(root, f)).join('\n')}`,
);
const r = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=junit',
    `--test-reporter-destination=${join(junitDir, 'emulator.xml')}`,
    ...found,
  ],
  { cwd: root, stdio: 'inherit', env: process.env },
);
if (r.status !== 0) process.exit(r.status ?? 1);

if (requireEndpoint) {
  // Skipped tests are not a pass of the emulator evidence.
  const xml = readFileSync(join(junitDir, 'emulator.xml'), 'utf8');
  const skipped = (xml.match(/<skipped\b/g) ?? []).length;
  const cases = (xml.match(/<testcase\b/g) ?? []).length;
  if (cases === 0 || skipped > 0) {
    console.error(`::error::emulator suite not a pass: ${cases} test case(s), ${skipped} skipped`);
    process.exit(1);
  }
}
