// Harness self-tests (run: node tests/e2e/harness/selftest.mjs). They prove the harness fails for the right reasons.
// They do not test the application and are not acceptance evidence for any TC- case.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ACCOUNTS, accountByKey, credentialsFromEnv, secretVar } from '../../data/accounts.mjs';
import { buildDataset } from '../../data/generate.mjs';
import {
  VOLUME_SETS,
  namedPatients,
  organisations,
  patient,
  seeds,
  services,
  volumePatients,
} from '../../data/generators.mjs';
import { scanJson, scanText } from '../../data/identifier-scan.mjs';
import { seedFiles } from '../../data/seed-files.mjs';
import { rng, stableUuid } from '../../data/prng.mjs';
import { archiveDir } from './archive.mjs';
import { finalize } from './finalize.mjs';
import { assertJunitGreen, junitCounts, junitXml } from './junit.mjs';
import { assertTargetAllowed, candidateCommit, requireEnvironment } from './run-meta.mjs';
import { buildArgs, redact, run as runSchemathesis } from '../../api/harness/schemathesis-run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'qa-harness-'));
const COMMIT = 'a'.repeat(40);
const fakePlaywright = () => {
  const bin = join(mkdtempSync(join(tmpdir(), 'qa-pw-')), 'playwright');
  writeFileSync(bin, '#!/usr/bin/env bash\necho "Version 1.64.1-fake"\n');
  chmodSync(bin, 0o755);
  return bin;
};
const PW = fakePlaywright();

test('prng: same seed same stream, different seed different stream', () => {
  const a = rng('x'),
    b = rng('x'),
    c = rng('y');
  const sa = [a(), a(), a()],
    sb = [b(), b(), b()],
    sc = [c(), c(), c()];
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  assert.equal(stableUuid('n', 'k'), stableUuid('n', 'k'));
  assert.notEqual(stableUuid('n', 'k'), stableUuid('n', 'l'));
  assert.match(
    stableUuid('n', 'k'),
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('accounts: every TEST-CASES 2 account exists once with stable ids', () => {
  const want = [
    'PAT-01',
    'PAT-12',
    'PRX-01',
    'STF-FD-A',
    'STF-TRI-A',
    'STF-COORD-A',
    'STF-DR-A1',
    'STF-DR-A2',
    'STF-DR-B1',
    'STF-ASST-A',
    'STF-TRN-A',
    'STF-ONCALL',
    'STF-MRO-A',
    'STF-BILL-A',
    'STF-MKT',
    'ADM-1',
    'ADM-2',
    'ADM-3',
    'CMP-1',
    'CMP-2',
    'STF-OUT-OU',
    'STF-SUPER',
    'STF-SUSP',
    'STF-NO2SV',
    'VIS-01',
  ];
  for (const k of want) assert.ok(accountByKey(k), k);
  assert.equal(new Set(ACCOUNTS.map((a) => a.key)).size, ACCOUNTS.length);
  assert.equal(new Set(ACCOUNTS.map((a) => a.principalId)).size, ACCOUNTS.length);
  assert.equal(accountByKey('PAT-03').dependantOf, 'PRX-01');
  assert.deepEqual(accountByKey('PRX-01').proxyFor, ['PAT-03']);
  assert.equal(accountByKey('STF-BILL-A').role, 'none'); // QA-AL-02: no R1 role
  assert.equal(accountByKey('STF-DR-A1').epcsProofing, false);
  assert.equal(accountByKey('VIS-01').email, null);
});

test('credentials come from the environment and a gap is an error naming variables, not values', () => {
  assert.equal(secretVar('STF-DR-A1'), 'QA_SECRET_STF_DR_A1');
  assert.deepEqual(credentialsFromEnv(['PAT-01', 'VIS-01'], { QA_SECRET_PAT_01: 's3cret-value' }), {
    'PAT-01': 's3cret-value',
  });
  assert.throws(
    () => credentialsFromEnv(['PAT-01', 'ADM-1'], { QA_SECRET_PAT_01: '' }),
    (e) => /QA_SECRET_PAT_01, QA_SECRET_ADM_1/.test(e.message) && !/s3cret/.test(e.message),
  );
});

test('no secret-looking literal is committed under tests/data or the harness directories', () => {
  const root = join(here, '..', '..');
  const files = ['data', 'e2e/harness', 'api/harness'].flatMap((d) =>
    readdirSync(join(root, d))
      .filter((f) => /\.(mjs|md|json)$/.test(f))
      .map((f) => join(root, d, f)),
  );
  const bad =
    /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|xox[bp]-[0-9A-Za-z-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/;
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), bad, f);
});

test('dataset is deterministic, differs by seed, and has no real-identifier-looking value', () => {
  const a = JSON.stringify(buildDataset({ seed: 's1' }));
  assert.equal(a, JSON.stringify(buildDataset({ seed: 's1' })));
  assert.notEqual(a, JSON.stringify(buildDataset({ seed: 's2' })));
  assert.deepEqual(scanJson(buildDataset()), []);
  assert.deepEqual(
    [...volumePatients('VOL-1', { limit: 50 })],
    [...volumePatients('VOL-1', { limit: 50 })],
  );
  assert.deepEqual(scanJson([...volumePatients('VOL-1', { limit: 500 })]), []);
});

test('synthetic shapes follow TEST-CASES 3', () => {
  const o = organisations();
  assert.deepEqual(
    o[0].locations.map((l) => [l.code, l.timezone]),
    [
      ['LOC-A1', 'America/New_York'],
      ['LOC-A2', 'America/New_York'],
      ['LOC-B1', 'America/Los_Angeles'],
    ],
  );
  assert.equal(o[1].locations.length, 1); // ORG-2: one location
  assert.equal(new Set([...o[0].locations, ...o[1].locations].map((l) => l.id)).size, 4);
  const svc = Object.fromEntries(services().map((s) => [s.code, s]));
  assert.notEqual(svc['SVC-SENS'].internalName, svc['SVC-SENS'].patientVisibleName);
  assert.doesNotMatch(svc['SVC-SENS'].patientVisibleName, /HIV/i);
  const p = Object.fromEntries(namedPatients().map((x) => [x.key, x]));
  for (const f of ['givenName', 'familyName', 'dateOfBirth', 'phone'])
    assert.equal(p['PAT-04'][f], p['PAT-05'][f], `duplicates share ${f}`);
  assert.notEqual(p['PAT-04'].id, p['PAT-05'].id);
  const s = seeds();
  assert.equal(s['SEED-CHART-1'].allergies.filter((x) => !x.coded).length, 1); // SA-F-08 uncoded entry
  assert.equal(s['SEED-DUP'].patients.length, 2);
  assert.equal(VOLUME_SETS['VOL-1'].patients, 250_000);
  assert.equal(VOLUME_SETS['VOL-3'].parallelSessionsOnOnePatient, 100);
  assert.ok(patient(0).phone.startsWith('+1-202-555-01'));
});

test('seed files include EICAR (built at run time), mismatch and double extension', () => {
  const f = seedFiles({ oversizeBytes: 1024 });
  assert.match(
    f.eicar.bytes.toString(),
    /^X5O!P%@AP.*EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$H\+H\*$/,
  );
  assert.ok(f.oversized.bytes.length > 1024);
  assert.ok(
    f.mismatchedType.bytes.subarray(1, 4).toString() === 'PNG' &&
      f.mismatchedType.type === 'application/pdf',
  );
  assert.match(f.doubleExtension.name, /\.pdf\.exe$/);
  assert.doesNotMatch(
    readFileSync(join(here, '..', '..', 'data', 'seed-files.mjs'), 'utf8'),
    /EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$/,
  );
});

test('identifier scan catches SSN-shaped, card, real-range phone and real-domain email; allows reserved values', () => {
  assert.deepEqual(
    scanText('ssn 123-45-6789').map((x) => x.rule),
    ['ssn-shaped'],
  );
  assert.ok(scanText('card 4111 1111 1111 1111').some((x) => x.rule === 'card-number'));
  assert.ok(
    scanText('call +1-415-867-5309').some((x) => x.rule === 'phone-outside-reserved-range'),
  );
  assert.ok(scanText('mail jane@gmail.com').some((x) => x.rule === 'email-on-real-domain'));
  assert.deepEqual(scanText('call +1-202-555-0123 mail a@b.qa-test.invalid c@example.com'), []);
});

test('environment binding: name required, "ENV-INT" alone and unknown names refused', () => {
  assert.equal(requireEnvironment('ENV-INT/ci'), 'ENV-INT/ci');
  assert.throws(() => requireEnvironment(''), /QA_ENVIRONMENT is required/);
  assert.throws(() => requireEnvironment('ENV-INT'), /unknown QA environment/);
});

test('target guard: ci is loopback or listed services only; forbidden hosts always refused', () => {
  assertTargetAllowed('ENV-INT/ci', 'http://127.0.0.1:3000/x', {});
  assertTargetAllowed('ENV-INT/ci', 'http://api:3000', { QA_CI_SERVICE_HOSTS: 'api, db' });
  assert.throws(
    () => assertTargetAllowed('ENV-INT/ci', 'https://staging.example.org', {}),
    /loopback/,
  );
  assert.throws(
    () =>
      assertTargetAllowed('ENV-INT/staging', 'https://app.prod.example.org', {
        QA_FORBIDDEN_HOSTS: 'prod.example.org',
      }),
    /forbidden/,
  );
  assert.throws(
    () =>
      assertTargetAllowed('ENV-INT/ci', 'http://localhost', { QA_FORBIDDEN_HOSTS: 'localhost' }),
    /forbidden/,
  );
});

test('candidate commit must be a 40-hex commit', () => {
  assert.equal(candidateCommit({ QA_CANDIDATE_COMMIT: COMMIT }), COMMIT);
  assert.throws(
    () => candidateCommit({ QA_CANDIDATE_COMMIT: 'abc' }, tmp()),
    /candidate commit unknown/,
  );
});

test('junit: writer output is read back; escaping; green gate rejects empty, failing and skipped runs', () => {
  const xml = junitXml({
    name: 's<>',
    properties: { env: 'ENV-INT/ci' },
    cases: [
      { classname: 'a', name: 'ok "q" & <b>', status: 'passed' },
      { classname: 'a', name: 'bad', status: 'failed', message: 'x<y' },
      { classname: 'a', name: 'sk', status: 'skipped' },
    ],
  });
  assert.deepEqual(junitCounts(xml), { tests: 3, failures: 1, errors: 0, skipped: 1, passed: 1 });
  assert.ok(xml.includes('ok &quot;q&quot; &amp; &lt;b&gt;'));
  assert.throws(() => assertJunitGreen(junitXml({ name: 'e', cases: [] })), /empty run fails/);
  assert.throws(() => assertJunitGreen(xml), /failing case/);
  assert.throws(
    () =>
      assertJunitGreen(
        junitXml({ name: 's', cases: [{ classname: 'a', name: 'sk', status: 'skipped' }] }),
      ),
    /skipped/,
  );
  assert.throws(
    () =>
      assertJunitGreen(
        junitXml({ name: 's', cases: [{ classname: 'a', name: 'p', status: 'passed' }] }),
        { minTests: 2 },
      ),
    /< required 2/,
  );
  // A lying root attribute does not hide a failure.
  assert.throws(
    () =>
      assertJunitGreen(
        '<testsuite tests="1" failures="0"><testcase name="a"><failure/></testcase></testsuite>',
      ),
    /failing/,
  );
  assert.deepEqual(
    assertJunitGreen(
      junitXml({ name: 's', cases: [{ classname: 'a', name: 'p', status: 'passed' }] }),
    ).passed,
    1,
  );
});

function fakeReport(dir, cases, withTraces = true) {
  mkdirSync(join(dir, 'traces', 't1'), { recursive: true });
  if (withTraces) writeFileSync(join(dir, 'traces', 't1', 'trace.zip'), 'PK-fake-trace');
  writeFileSync(join(dir, 'junit.xml'), junitXml({ name: 'pw', cases }));
}
const passed = (n) =>
  Array.from({ length: n }, (_, i) => ({ classname: 'e2e', name: `c${i}`, status: 'passed' }));

test('finalize: writes manifest with environment, candidate, hashes and a trace archive', () => {
  const d = tmp();
  fakeReport(d, passed(3));
  const m = finalize({
    reportDir: d,
    minTests: 3,
    command: 'pw',
    env: { QA_ENVIRONMENT: 'ENV-INT/ci', QA_CANDIDATE_COMMIT: COMMIT, QA_PLAYWRIGHT_BIN: PW },
  });
  assert.equal(m.environment, 'ENV-INT/ci');
  assert.equal(m.candidateCommit, COMMIT);
  assert.equal(m.counts.tests, 3);
  assert.equal(m.tools.playwright, 'Version 1.64.1-fake');
  assert.equal(m.traces.traceZips, 1);
  assert.ok(m.node);
  assert.ok(existsSync(join(d, 'traces.tar.gz')) && statSync(join(d, 'traces.tar.gz')).size > 0);
  assert.match(m.traces.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(d, 'run-manifest.json'), 'utf8')).environment,
    'ENV-INT/ci',
  );
  assert.match(
    execFileSync('tar', ['-tzf', join(d, 'traces.tar.gz')], { encoding: 'utf8' }),
    /traces\/t1\/trace\.zip/,
  );
});

test('finalize refuses: empty run, too few tests, failure, skip, no traces, no JUnit, no environment', () => {
  const env = { QA_ENVIRONMENT: 'ENV-INT/ci', QA_CANDIDATE_COMMIT: COMMIT, QA_PLAYWRIGHT_BIN: PW };
  const t = (setup, opts, re) => {
    const d = tmp();
    setup(d);
    assert.throws(() => finalize({ reportDir: d, env, ...opts }), re);
  };
  t((d) => fakeReport(d, []), {}, /empty run/);
  t((d) => fakeReport(d, passed(2)), { minTests: 5 }, /< required 5/);
  t(
    (d) => fakeReport(d, [...passed(1), { classname: 'e', name: 'f', status: 'failed' }]),
    {},
    /failing/,
  );
  t(
    (d) => fakeReport(d, [...passed(1), { classname: 'e', name: 's', status: 'skipped' }]),
    {},
    /skipped/,
  );
  t((d) => fakeReport(d, passed(1), false), {}, /nothing to archive|no trace output/);
  t(() => {}, {}, /no JUnit report/);
  const d = tmp();
  fakeReport(d, passed(1));
  assert.throws(
    () => finalize({ reportDir: d, env: { QA_CANDIDATE_COMMIT: COMMIT, QA_PLAYWRIGHT_BIN: PW } }),
    /QA_ENVIRONMENT is required/,
  );
});

test('finalize refuses when the Playwright version cannot be determined', () => {
  const d = tmp();
  fakeReport(d, passed(1));
  assert.throws(
    () =>
      finalize({
        reportDir: d,
        env: {
          QA_ENVIRONMENT: 'ENV-INT/ci',
          QA_CANDIDATE_COMMIT: COMMIT,
          QA_PLAYWRIGHT_BIN: '/nonexistent/pw',
        },
      }),
    /cannot determine the Playwright version/,
  );
});

test('archive: refuses an empty directory', () => {
  assert.throws(() => archiveDir(join(tmp(), 'none'), join(tmp(), 'x.tgz')), /nothing to archive/);
});

test('playwright config: refuses without environment, base url, test dir; otherwise JUnit + traces on', async () => {
  const load = (env) =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(join(here, 'playwright.config.mjs'))}); console.log(JSON.stringify(m.default))`,
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  assert.throws(() => load({}), /QA_ENVIRONMENT is required/);
  assert.throws(() => load({ QA_ENVIRONMENT: 'ENV-INT/ci' }), /QA_BASE_URL is required/);
  assert.throws(
    () => load({ QA_ENVIRONMENT: 'ENV-INT/ci', QA_BASE_URL: 'https://www.example.org' }),
    /loopback/,
  );
  const ok = JSON.parse(
    load({
      QA_ENVIRONMENT: 'ENV-INT/ci',
      QA_BASE_URL: 'http://127.0.0.1:4173',
      QA_CANDIDATE_COMMIT: COMMIT,
      QA_TEST_DIR: 'tests/x',
      QA_REPORT_DIR: '/tmp/r',
    }),
  );
  assert.equal(ok.use.trace, 'on');
  assert.equal(ok.retries, 0);
  assert.equal(ok.forbidOnly, true);
  assert.ok(ok.reporter.some((r) => r[0] === 'junit' && r[1].outputFile === '/tmp/r/junit.xml'));
  assert.deepEqual(ok.metadata, { environment: 'ENV-INT/ci', candidateCommit: COMMIT });
});

test('schemathesis args: cap, seed, single worker, junit; bearer redacted in logs and command', () => {
  const args = buildArgs({
    schema: 's.json',
    url: 'http://127.0.0.1:3000',
    outDir: '/o',
    bearer: 'tok-123',
  });
  assert.ok(args.includes('--rate-limit') && args.includes('5/s'));
  assert.equal(args[args.indexOf('--workers') + 1], '1');
  assert.ok(args.includes('junit,har'));
  assert.equal(
    redact('Authorization: Bearer tok-123 ok', 'tok-123'),
    'Authorization: Bearer «redacted» ok',
  );
});

function fakeSchemathesis({ cases = 2, fail = false, exit = 0 } = {}) {
  const d = tmp();
  const bin = join(d, 'schemathesis');
  const junit = junitXml({
    name: 'st',
    cases: [...passed(cases), ...(fail ? [{ classname: 's', name: 'f', status: 'failed' }] : [])],
  })
    .replace(/\n/g, '\\n')
    .replace(/'/g, "'\\''");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "schemathesis 4.33.1-fake"; exit 0; fi
while [ $# -gt 0 ]; do [ "$1" = "--report-dir" ] && dir="$2"; shift; done
mkdir -p "$dir"; printf '${junit}' > "$dir/junit.xml"; echo "Authorization seen: $QA_API_BEARER"; exit ${exit}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}
const stEnv = (bin, extra = {}) => ({
  ...process.env,
  QA_ENVIRONMENT: 'ENV-INT/ci',
  QA_CANDIDATE_COMMIT: COMMIT,
  SCHEMATHESIS_BIN: bin,
  ...extra,
});

test('schemathesis runner (fake binary, runner logic only): manifest, redaction and refusals', () => {
  const out = tmp();
  const m = runSchemathesis({
    schema: 's.json',
    url: 'http://127.0.0.1:3000',
    out,
    minTests: 2,
    env: stEnv(fakeSchemathesis(), { QA_API_BEARER: 'tok-xyz' }),
  });
  assert.equal(m.counts.tests, 2);
  assert.equal(m.tools.schemathesis, 'schemathesis 4.33.1-fake');
  assert.equal(m.candidateCommit, COMMIT);
  assert.doesNotMatch(readFileSync(join(out, 'run-manifest.json'), 'utf8'), /tok-xyz/);
  assert.doesNotMatch(readFileSync(join(out, 'schemathesis.log'), 'utf8'), /tok-xyz/);
  const bad = (opts, env, re) =>
    assert.throws(
      () =>
        runSchemathesis({
          schema: 's.json',
          url: 'http://127.0.0.1:3000',
          out: tmp(),
          ...opts,
          env,
        }),
      re,
    );
  bad({}, stEnv(fakeSchemathesis({ fail: true })), /failing case/);
  bad({}, stEnv(fakeSchemathesis({ cases: 0 })), /empty run/);
  bad({}, stEnv(fakeSchemathesis({ exit: 1 })), /exited 1/);
  bad({ minTests: 5 }, stEnv(fakeSchemathesis({ cases: 2 })), /< required 5/);
  bad({}, stEnv('/nonexistent/schemathesis'), /not available/);
  bad({ url: 'https://api.example.org' }, stEnv(fakeSchemathesis()), /loopback/);
});
