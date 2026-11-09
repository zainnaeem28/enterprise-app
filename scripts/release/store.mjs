#!/usr/bin/env node
// Release store operations through the AWS CLI (gh-build role, DEVOPS-PLAN 7.2).
//   store.mjs decide --number n --sha s --bucket b   -> prints action=publish|reuse; exit 1 with code release_number when refused
//   store.mjs put-bundles --sha s --bucket b --dir <out>/bundles
//   store.mjs put-manifest --sha s --number n --bucket b --file release-manifest.json   (the commit point; refuses to overwrite)
//   store.mjs get-manifest --sha s --number n --bucket b --out file                      (re-run reuse)
// No credentials are read here: the CLI uses the environment set by aws-login.sh.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { decideAgainstStore } from './lib/release-number.mjs';
import { bundlePrefix, numberKey, parseKeys, shaKey } from './lib/store.mjs';

const aws = (...args) =>
  execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const [cmd, ...rest] = process.argv.slice(2);
const { values: v } = parseArgs({
  args: rest,
  options: {
    number: { type: 'string' },
    sha: { type: 'string' },
    bucket: { type: 'string' },
    dir: { type: 'string' },
    file: { type: 'string' },
    out: { type: 'string' },
  },
});
if (!v.bucket) {
  console.error('--bucket is required');
  process.exit(2);
}

if (cmd === 'decide') {
  const keys =
    JSON.parse(
      aws(
        's3api',
        'list-objects-v2',
        '--bucket',
        v.bucket,
        '--prefix',
        'manifests/by-number/',
        '--query',
        'Contents[].Key',
        '--output',
        'json',
      ) || 'null',
    ) ?? [];
  try {
    const d = decideAgainstStore(Number(v.number), v.sha, parseKeys(keys));
    console.log(
      `store holds ${keys.length} manifest(s); action=${d.action}${d.action === 'reuse' ? ` (number ${d.releaseNumber} already assigned to this commit)` : ''}`,
    );
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `store_action=${d.action}\n`);
  } catch (e) {
    console.error(`::error title=release_number::${e.message}`);
    process.exit(1);
  }
} else if (cmd === 'put-bundles') {
  for (const portal of readdirSync(v.dir)) {
    aws(
      's3',
      'cp',
      '--recursive',
      '--only-show-errors',
      join(v.dir, portal),
      `s3://${v.bucket}/${bundlePrefix(v.sha, portal)}`,
    );
    console.log(`uploaded bundle ${portal} to ${bundlePrefix(v.sha, portal)}`);
  }
} else if (cmd === 'put-manifest') {
  // --if-none-match '*': a second writer for the same key fails instead of replacing the manifest of a release.
  for (const key of [shaKey(v.sha), numberKey(Number(v.number), v.sha)]) {
    aws(
      's3api',
      'put-object',
      '--bucket',
      v.bucket,
      '--key',
      key,
      '--body',
      v.file,
      '--content-type',
      'application/json',
      '--if-none-match',
      '*',
    );
    console.log(`stored ${key}`);
  }
  aws(
    's3api',
    'put-object',
    '--bucket',
    v.bucket,
    '--key',
    `${shaKey(v.sha)}.sha256`,
    '--body',
    `${v.file}.sha256`,
    '--if-none-match',
    '*',
  );
} else if (cmd === 'get-manifest') {
  aws('s3api', 'get-object', '--bucket', v.bucket, '--key', shaKey(v.sha), v.out);
  aws(
    's3api',
    'get-object',
    '--bucket',
    v.bucket,
    '--key',
    `${shaKey(v.sha)}.sha256`,
    `${v.out}.sha256`,
  );
} else {
  console.error('usage: store.mjs decide|put-bundles|put-manifest|get-manifest ...');
  process.exit(2);
}
