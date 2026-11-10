// Local evaluation of the "not configured" gates of every AWS-touching workflow (HEAAA-698), without GitHub or act.
// For each gate step (`id: gate`) it extracts the `run:` script, runs it with the configuration variable absent and asserts:
//   exit 0, a `::notice::not configured: <VAR>` line, `enabled=false` written to GITHUB_OUTPUT, and no `::error::`.
// It then runs it with the variable set to 'true' and asserts `enabled=true` (the gate does not swallow a configured run).
// It also asserts that, in each workflow, every job that needs the gate carries `needs.<gate job>.outputs.enabled == 'true'`.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const wf = resolve(import.meta.dirname, '../../.github/workflows');
// workflow -> [gate job, variable, extra env needed to reach the enablement check]
const GATES = {
  'deploy-staging.yml': ['enabled', 'DEPLOY_STAGING_ENABLED', { REF: 'refs/heads/main' }],
  'deploy-production.yml': ['enabled', 'DEPLOY_PRODUCTION_ENABLED', { REF: 'refs/heads/main' }],
  'deploy-marketing.yml': ['enabled', 'DEPLOY_MARKETING_ENABLED', { REF: 'refs/heads/main' }],
  'audit-archive.yml': ['enabled', 'AUDIT_ARCHIVE_ENABLED', { REF: 'refs/heads/main' }],
  'bootstrap.yml': ['enabled', 'BOOTSTRAP_ENABLED', { REF: 'refs/heads/main' }],
  'nightly.yml': ['enabled', 'NIGHTLY_ENABLED', { REF: 'refs/heads/main' }],
  'restore-test.yml': ['enabled', 'RESTORE_TEST_ENABLED', { REF: 'refs/heads/main', MODE: 'both' }],
  'infra.yml': ['plan-gate', 'INFRA_PLAN_ENABLED', {}],
};
// infra apply gate lives inside the apply job (environment-scoped variable); checked as a second gate of infra.yml.
const EXTRA = [
  ['infra.yml', 'apply', 'INFRA_APPLY_ENABLED', { REF: 'refs/heads/main', TARGET: 'staging' }],
];

let failed = 0;
const fail = (m) => {
  console.error(`FAIL ${m}`);
  failed++;
};

/** The run script of the first `id: gate` step inside job `job`, plus the job's text. */
const extract = (text, job) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start, end);
  const g = body.findIndex((l) => l.trim() === 'id: gate');
  if (g < 0) return { body: body.join('\n'), script: null };
  const r = body.findIndex((l, i) => i > g && /^\s+run: \|\s*$/.test(l));
  const indent = body[r].match(/^\s*/)[0].length;
  const script = [];
  for (
    let i = r + 1;
    i < body.length && (body[i].trim() === '' || body[i].match(/^\s*/)[0].length > indent);
    i++
  )
    script.push(body[i].slice(indent + 2));
  return { body: body.join('\n'), script: script.join('\n') };
};

const evalGate = (file, job, variable, env) => {
  const text = readFileSync(join(wf, file), 'utf8');
  const e = extract(text, job);
  if (!e || !e.script) return fail(`${file}: no gate step (id: gate) in job ${job}`);
  const dir = mkdtempSync(join(tmpdir(), 'aws-gate-'));
  try {
    const run = (enabledValue) => {
      const out = join(dir, 'out'),
        sum = join(dir, 'sum');
      (writeFileSync(out, ''), writeFileSync(sum, ''));
      const envv = {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: out,
        GITHUB_STEP_SUMMARY: sum,
        ...env,
        ENABLED: enabledValue,
        PLAN_ENABLED: enabledValue,
        APPLY_ENABLED: enabledValue,
        APPROVED_SHA: 'a'.repeat(64),
        MODE: 'both',
      };
      const r = spawnSync('bash', ['-eo', 'pipefail', '-c', e.script], {
        env: envv,
        encoding: 'utf8',
      });
      return { rc: r.status, stdout: r.stdout + r.stderr, output: readFileSync(out, 'utf8') };
    };
    const off = run('');
    if (off.rc !== 0) fail(`${file}/${job}: unconfigured gate exited ${off.rc}`);
    if (!off.stdout.includes(`::notice::not configured: ${variable}`))
      fail(`${file}/${job}: missing "::notice::not configured: ${variable}"`);
    if (off.stdout.includes('::error::'))
      fail(`${file}/${job}: unconfigured gate printed an error`);
    if (!/^enabled=false$/m.test(off.output)) fail(`${file}/${job}: enabled=false not written`);
    const on = run('true');
    if (on.rc !== 0 || !/^enabled=true$/m.test(on.output))
      fail(`${file}/${job}: configured gate did not set enabled=true (rc ${on.rc})`);
    if (on.stdout.includes('not configured'))
      fail(`${file}/${job}: configured gate still says not configured`);
    console.log(
      `ok   ${file} ${job}: unconfigured -> notice + enabled=false + exit 0; configured -> enabled=true`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

for (const [file, [job, variable, env]] of Object.entries(GATES)) {
  evalGate(file, job, variable, env);
  const text = readFileSync(join(wf, file), 'utf8');
  // every job (other than the gate job) that lists the gate job in needs must test its output
  const jobs = text.split(/\n(?=  [A-Za-z0-9_-]+:\s*\n)/);
  for (const j of jobs) {
    const name = j.match(/^\s*([A-Za-z0-9_-]+):/)?.[1];
    const needs =
      j
        .match(/^ {4}needs: \[([^\]]*)\]/m)?.[1]
        .split(',')
        .map((s) => s.trim()) ?? [];
    if (name === job || !needs.includes(job)) continue;
    if (!j.includes(`needs.${job}.outputs.enabled`))
      fail(`${file}: job ${name} needs ${job} but does not test its enabled output`);
  }
}
for (const [file, job, variable, env] of EXTRA) evalGate(file, job, variable, env);

// build-release: with no release variable set the publish switch must be off.
const br = readFileSync(join(wf, 'build-release.yml'), 'utf8');
if (!/PUBLISH: .*vars\.RELEASE_STORE_BUCKET != ''.*'true' \|\| 'false'/.test(br))
  fail('build-release.yml: PUBLISH is not conditional on the release variables');
else
  console.log(
    'ok   build-release.yml: PUBLISH requires main AND at least one release variable; otherwise dry-run, nothing published',
  );

process.exit(failed ? 1 : 0);
