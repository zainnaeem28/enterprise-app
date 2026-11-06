#!/usr/bin/env node
// After a Playwright run: validate the JUnit file (non-empty, no failure or skip), archive the traces and write
// run-manifest.json (tool versions, candidate commit, environment, command, counts, hashes). Exit 1 on any problem, so a
// green exit code of the test tool alone is never the evidence.
//   finalize.mjs [report-dir] [--min-tests N] [--command "..."]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { archiveDir } from './archive.mjs';
import { assertJunitGreen } from './junit.mjs';
import { runMeta, toolVersion } from './run-meta.mjs';

// Playwright binary: QA_PLAYWRIGHT_BIN, else the one installed with the staff portal's dependencies.
function playwrightVersion(env, cwd) {
  const root = toolVersion('git', ['rev-parse', '--show-toplevel']) ?? cwd;
  const bin = env.QA_PLAYWRIGHT_BIN ?? join(root, 'apps/staff/node_modules/.bin/playwright');
  const v = existsSync(bin) ? toolVersion(bin) : null;
  if (!v)
    throw new Error(
      `cannot determine the Playwright version (looked for ${bin}); set QA_PLAYWRIGHT_BIN`,
    );
  return v;
}

export function finalize({
  reportDir,
  minTests = 1,
  command = 'playwright test',
  env = process.env,
}) {
  const junitFile = join(reportDir, 'junit.xml');
  if (!existsSync(junitFile)) throw new Error(`no JUnit report at ${junitFile}`);
  const xml = readFileSync(junitFile, 'utf8');
  const counts = assertJunitGreen(xml, { minTests });
  const meta = runMeta({
    environment: env.QA_ENVIRONMENT,
    command,
    tools: { playwright: playwrightVersion(env, process.cwd()) },
    env,
  });
  const trace = archiveDir(join(reportDir, 'traces'), join(reportDir, 'traces.tar.gz'));
  const manifest = {
    ...meta,
    finishedAt: new Date().toISOString(),
    counts,
    junit: { file: 'junit.xml', sha256: createHash('sha256').update(xml).digest('hex') },
    traces: trace,
  };
  writeFileSync(join(reportDir, 'run-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const opt = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  const dir = a.find((x, i) => !x.startsWith('--') && !(a[i - 1] ?? '').startsWith('--'));
  try {
    const m = finalize({
      reportDir: resolve(dir ?? 'reports/qa-e2e'),
      minTests: Number(opt('--min-tests') ?? 1),
      command: opt('--command'),
    });
    console.log(
      `ok: ${m.counts.tests} test(s), environment ${m.environment}, candidate ${m.candidateCommit}`,
    );
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
