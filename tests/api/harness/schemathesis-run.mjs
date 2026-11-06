#!/usr/bin/env node
// Schemathesis wrapper for the API contract and negative cases (TC-API-09; DEVOPS-PLAN 5.1, 5.3, 14). It
//  - refuses a target the environment does not allow (never production; `ENV-INT/ci` only loopback or CI services),
//  - applies a request-rate cap and a fixed seed, runs one worker,
//  - takes the bearer token from QA_API_BEARER (environment, never a file) and redacts it everywhere it records,
//  - requires the JUnit report to show executed cases and no failure or skip, and writes run-manifest.json.
// It is a contract and negative test, not an authorised active security assessment.
//   schemathesis-run.mjs --schema <openapi file|url> --url <base-url> --out <dir> [--min-tests N] [--max-examples N]
//                        [--rate-limit 5/s] [--seed S] [--operations N]
// Environment: QA_ENVIRONMENT (required), QA_CANDIDATE_COMMIT, QA_API_BEARER (optional), SCHEMATHESIS_BIN (default schemathesis).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertJunitGreen } from '../../e2e/harness/junit.mjs';
import { assertTargetAllowed, runMeta } from '../../e2e/harness/run-meta.mjs';

const CHECKS =
  'not_a_server_error,status_code_conformance,content_type_conformance,response_headers_conformance,response_schema_conformance';

export function buildArgs({
  schema,
  url,
  outDir,
  maxExamples = 25,
  rateLimit = '5/s',
  seed = '20261106',
  bearer,
  clientRelease = 'r1.000000000000',
}) {
  const args = ['run', schema, '--url', url, '--header', `X-Client-Release: ${clientRelease}`];
  if (bearer) args.push('--header', `Authorization: Bearer ${bearer}`);
  args.push(
    '--checks',
    CHECKS,
    '--max-examples',
    String(maxExamples),
    '--rate-limit',
    rateLimit,
    '--seed',
    String(seed),
    '--workers',
    '1',
  );
  args.push('--report', 'junit,har', '--report-dir', outDir);
  return args;
}

export const redact = (text, secret) => (secret ? text.split(secret).join('«redacted»') : text);

export function run({
  schema,
  url,
  out,
  minTests = 1,
  maxExamples,
  rateLimit,
  seed,
  env = process.env,
  cwd = process.cwd(),
}) {
  const environment = env.QA_ENVIRONMENT;
  assertTargetAllowed(environment, url, env);
  const bin = env.SCHEMATHESIS_BIN ?? 'schemathesis';
  const ver = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (ver.error || ver.status !== 0)
    throw new Error(`schemathesis not available (${bin}); install the pinned version first`);
  const outDir = resolve(out);
  mkdirSync(outDir, { recursive: true });
  const bearer = env.QA_API_BEARER || undefined;
  const args = buildArgs({
    schema,
    url,
    outDir: join(outDir, 'schemathesis'),
    maxExamples,
    rateLimit,
    seed,
    bearer,
  });
  const res = spawnSync(bin, args, { encoding: 'utf8', env, cwd, maxBuffer: 256 * 1024 * 1024 });
  const log = redact(`${res.stdout ?? ''}${res.stderr ?? ''}`, bearer);
  writeFileSync(join(outDir, 'schemathesis.log'), log);
  if (res.status !== 0) throw new Error(`schemathesis exited ${res.status} (see schemathesis.log)`);
  const dir = join(outDir, 'schemathesis');
  const xmlName = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.xml')) : undefined;
  if (!xmlName) throw new Error('no JUnit report from Schemathesis (an empty run fails)');
  const xml = readFileSync(join(dir, xmlName), 'utf8');
  const counts = assertJunitGreen(xml, { minTests });
  const command = `${bin} ${redact(args.join(' '), bearer)}`;
  const manifest = {
    ...runMeta({ environment, command, tools: { schemathesis: ver.stdout.trim() }, env, cwd }),
    finishedAt: new Date().toISOString(),
    target: url,
    schema,
    counts,
    junit: {
      file: `schemathesis/${xmlName}`,
      sha256: createHash('sha256').update(xml).digest('hex'),
    },
    log: { file: 'schemathesis.log', sha256: createHash('sha256').update(log).digest('hex') },
  };
  writeFileSync(join(outDir, 'run-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const opt = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  try {
    if (!opt('--schema') || !opt('--url') || !opt('--out'))
      throw new Error('usage: --schema <file|url> --url <base-url> --out <dir>');
    const m = run({
      schema: opt('--schema'),
      url: opt('--url'),
      out: opt('--out'),
      minTests: Number(opt('--min-tests') ?? 1),
      maxExamples: opt('--max-examples'),
      rateLimit: opt('--rate-limit'),
      seed: opt('--seed'),
    });
    console.log(
      `ok: ${m.counts.tests} case(s), environment ${m.environment}, candidate ${m.candidateCommit}, ${m.tools.schemathesis}`,
    );
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
