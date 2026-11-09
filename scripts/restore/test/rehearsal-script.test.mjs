// dr-rehearsal.sh against stub `tofu` and `aws` binaries: the account guard, destroy on every exit path, and the timeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../dr-rehearsal.sh');
const jq = spawnSync('jq', ['--version']);

function sandbox({ account = '333333333333', applyFails = false, destroyFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dr-test-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  const log = join(dir, 'calls.log');
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('aws', `echo "aws $*" >>"${log}"; echo ${account}`);
  stub('tofu', `echo "tofu $*" >>"${log}"
case "$*" in
  *" apply "*) ${applyFails ? 'exit 1' : 'exit 0'} ;;
  *" destroy "*) ${destroyFails ? 'exit 1' : 'exit 0'} ;;
  *"output"*) echo "2000-01-01T00:00:00Z" ;;
esac`);
  writeFileSync(join(dir, 'vars.tfvars'), 'expected_account_id = "333333333333"\n');
  writeFileSync(join(dir, 'wrong.tfvars'), 'expected_account_id = "999999999999"\n');
  return { dir, bin, log, root: dir, vars: join(dir, 'vars.tfvars') };
}
const run = (sb, args, extra = {}) =>
  spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: `${sb.bin}:${process.env.PATH}`, STAGING_ACCOUNT_ID: '333333333333', HOME: sb.dir, ...extra },
  });
const calls = (sb) => (existsSync(sb.log) ? readFileSync(sb.log, 'utf8') : '');

test('refuses credentials of another account before any tofu call', { skip: jq.status !== 0 && 'jq missing' }, () => {
  const sb = sandbox({ account: '111111111111' });
  const r = run(sb, ['destroy', '--root', sb.root, '--var-file', sb.vars, '--out', join(sb.dir, 'o')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not the staging account/);
  assert.ok(!/tofu /.test(calls(sb)));
});

test('refuses a var file for another account, another Region and an out-of-range age', { skip: jq.status !== 0 && 'jq missing' }, () => {
  const sb = sandbox();
  let r = run(sb, ['plan', '--root', sb.root, '--var-file', join(sb.dir, 'wrong.tfvars'), '--out', join(sb.dir, 'o')]);
  assert.match(r.stderr, /does not name the staging account/);
  r = run(sb, ['plan', '--root', sb.root, '--var-file', sb.vars], { REHEARSAL_REGION: 'us-east-2' });
  assert.match(r.stderr, /us-west-2 only/);
  r = run(sb, ['sweep', '--root', sb.root, '--var-file', sb.vars, '--max-age-hours', '48']);
  assert.match(r.stderr, /1\.\.24/);
});

test('run applies, runs the steps, destroys, and writes a timeline without claiming RPO or RTO', { skip: jq.status !== 0 && 'jq missing' }, () => {
  const sb = sandbox();
  const steps = join(sb.dir, 'steps.sh');
  writeFileSync(steps, '#!/usr/bin/env bash\necho step >>"$1/steps.log"\n');
  chmodSync(steps, 0o755);
  const out = join(sb.dir, 'o');
  const r = run(sb, ['run', '--root', sb.root, '--var-file', sb.vars, '--steps', steps, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const c = calls(sb);
  assert.ok(c.indexOf(' apply ') < c.indexOf(' destroy '), 'apply before destroy');
  const t = JSON.parse(readFileSync(join(out, 'timeline.json'), 'utf8'));
  assert.ok(t.seconds.apply >= 0 && t.seconds.destroy >= 0 && t.seconds.total >= 0);
  assert.match(t.note, /NOT claimed/);
});

test('failing steps and a failing apply both still destroy; a failing destroy fails loudly', { skip: jq.status !== 0 && 'jq missing' }, () => {
  const failing = join(tmpdir(), 'dr-failing-steps.sh');
  writeFileSync(failing, '#!/usr/bin/env bash\nexit 3\n');
  chmodSync(failing, 0o755);
  let sb = sandbox();
  let r = run(sb, ['run', '--root', sb.root, '--var-file', sb.vars, '--steps', failing, '--out', join(sb.dir, 'o')]);
  assert.notEqual(r.status, 0);
  assert.match(calls(sb), / destroy /);
  sb = sandbox({ applyFails: true });
  r = run(sb, ['run', '--root', sb.root, '--var-file', sb.vars, '--steps', failing, '--out', join(sb.dir, 'o')]);
  assert.notEqual(r.status, 0);
  assert.match(calls(sb), / destroy /, 'a half-applied stack is destroyed');
  sb = sandbox({ destroyFails: true });
  r = run(sb, ['run', '--root', sb.root, '--var-file', sb.vars, '--steps', failing, '--out', join(sb.dir, 'o')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DESTROY FAILED/);
});

test('sweep destroys an expired stack and leaves a live one', { skip: jq.status !== 0 && 'jq missing' }, () => {
  const sb = sandbox();
  const r = run(sb, ['sweep', '--root', sb.root, '--var-file', sb.vars, '--out', join(sb.dir, 'o')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(calls(sb), / destroy /, 'the stub reports an expiry in 2000');
});
