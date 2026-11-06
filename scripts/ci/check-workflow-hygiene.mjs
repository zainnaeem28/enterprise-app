// Workflow hygiene (DEVOPS-PLAN 5.1, DPR-14). Works on any GitHub plan. Line-based by design (no YAML
// dependency); actionlint covers syntax and expressions. Fails on, per file under .github/workflows
// and .github/actions:
//   - a `uses:` that is not `./local` or `owner/repo[/path]@<40 hex>`; docker:// references;
//   - a pinned action whose owner/repo is not in .github/ACTIONS-ALLOWLIST.md;
//   - no top-level `permissions:`; `permissions: write-all`;
//   - a job without `timeout-minutes`;
//   - `continue-on-error`, `|| true`, `|| :`, `|| exit 0`, `; true`;
//   - `pull_request_target`, and (ci.yml only) `id-token`, `secrets.` other than GITHUB_TOKEN, cloud login actions.
// Usage: node check-workflow-hygiene.mjs [repoRoot]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '../..'));
const problems = [];
const fail = (file, line, msg) => problems.push(`${file}${line ? `:${line}` : ''}: ${msg}`);

const allowPath = join(root, '.github/ACTIONS-ALLOWLIST.md');
if (!existsSync(allowPath)) {
  console.error(`::error::${relative(root, allowPath)} is missing`);
  process.exit(1);
}
const allowed = new Set();
for (const l of readFileSync(allowPath, 'utf8').split('\n')) {
  const m = /^\|\s*`([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^`]+)?)`\s*\|/.exec(l);
  if (m) allowed.add(m[1].toLowerCase());
}
if (allowed.size === 0) {
  console.error(
    '::error::the allow-list names no actions (expected table rows starting with `owner/repo`)',
  );
  process.exit(1);
}

const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];
const files = [
  ...walk(join(root, '.github/workflows')),
  ...walk(join(root, '.github/actions')),
].filter((f) => /\.ya?ml$/.test(f));
if (files.length === 0) {
  console.error('::error::no workflow files found');
  process.exit(1);
}

const stripComment = (l) => l.replace(/(^|\s)#.*$/, '$1');

for (const file of files) {
  const rel = relative(root, file);
  const isCi = rel === '.github/workflows/ci.yml';
  const lines = readFileSync(file, 'utf8').split('\n');
  let topPermissions = false;
  let inJobs = false;
  let job = null;
  const jobs = [];
  lines.forEach((raw, i) => {
    const n = i + 1;
    const l = stripComment(raw);
    if (/^permissions:/.test(l)) topPermissions = true;
    if (/^jobs:/.test(l)) inJobs = true;
    else if (/^\S/.test(l) && l.trim()) inJobs = false;
    if (inJobs) {
      const jm = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
      if (jm) {
        job = { name: jm[1], line: n, timeout: false };
        jobs.push(job);
      }
      if (job && /^ {4}timeout-minutes:/.test(l)) job.timeout = true;
    }
    if (/^\s*permissions:\s*write-all/.test(l)) fail(rel, n, 'permissions: write-all');

    const um = /^\s*-?\s*uses:\s*(\S+)/.exec(l);
    if (um) {
      const ref = um[1].replace(/^['"]|['"]$/g, '');
      if (ref.startsWith('./')) {
        // local action: reviewed in this repository
      } else if (ref.startsWith('docker://')) {
        fail(rel, n, `docker:// reference is not allowed (${ref})`);
      } else {
        const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)((?:\/[^@]+)?)@(.+)$/.exec(ref);
        if (!m) fail(rel, n, `uses is not owner/repo@<sha>: ${ref}`);
        else if (!/^[0-9a-f]{40}$/.test(m[3]))
          fail(rel, n, `uses is not pinned to a full 40-character commit SHA: ${ref}`);
        else if (!allowed.has((m[1] + m[2]).toLowerCase()) && !allowed.has(m[1].toLowerCase()))
          fail(rel, n, `action ${m[1] + m[2]} is not in .github/ACTIONS-ALLOWLIST.md`);
      }
    }
    if (/continue-on-error/.test(l)) fail(rel, n, 'continue-on-error is not allowed');
    if (/\|\|\s*(true\b|:(\s|$)|exit\s+0\b)/.test(l) || /;\s*true\s*$/.test(l))
      fail(rel, n, 'failure is swallowed (|| true / || : / || exit 0 / ; true)');
    if (/pull_request_target/.test(l)) fail(rel, n, 'pull_request_target is not allowed');
    if (isCi) {
      if (/id-token/.test(l))
        fail(rel, n, 'ci.yml must not request id-token (no cloud credentials on pull requests)');
      if (/\$\{\{[^}]*\bsecrets\.(?!GITHUB_TOKEN\b)/.test(l) || /secrets:\s*inherit/.test(l))
        fail(rel, n, 'ci.yml must not use secrets other than GITHUB_TOKEN');
      if (/aws-actions\/|google-github-actions\/auth|azure\/login|role-to-assume/.test(l))
        fail(rel, n, 'ci.yml must not log in to a cloud');
    }
  });
  if (!topPermissions) fail(rel, 0, 'no top-level `permissions:` declared');
  for (const j of jobs) if (!j.timeout) fail(rel, j.line, `job ${j.name} has no timeout-minutes`);
  if (isCi) {
    // every job except ci-status must be gated by ci-status (R1-03)
    const nm = /^ {4}needs:\s*\[([^\]]*)\]/m.exec(lines.slice(lines.findIndex((x) => /^ {2}ci-status:/.test(x))).join('\n'));
    const gated = new Set((nm?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean));
    if (!nm) fail(rel, 0, 'ci-status has no inline `needs: [..]` list');
    for (const j of jobs) if (j.name !== 'ci-status' && !gated.has(j.name)) fail(rel, j.line, `job ${j.name} is not in ci-status needs (ungated)`);
  }
  if (jobs.length === 0 && rel.startsWith('.github/workflows/')) fail(rel, 0, 'no jobs found');
}

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  console.error(`workflow hygiene: ${problems.length} violation(s)`);
  process.exit(1);
}
console.log(
  `workflow hygiene: ${files.length} file(s) checked against ${allowed.size} allowed action(s), no violations`,
);
