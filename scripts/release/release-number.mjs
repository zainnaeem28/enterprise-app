#!/usr/bin/env node
// Print the release number for a commit and (in Actions) export it. Usage: release-number.mjs [git_sha]
import { appendFileSync } from 'node:fs';
import { computeReleaseNumber, formatClientRelease } from './lib/release-number.mjs';

const sha = process.argv[2] ?? process.env.GITHUB_SHA;
const r = computeReleaseNumber(sha);
const out = {
  release_number: r.releaseNumber,
  git_sha: r.gitSha,
  git_sha12: r.gitSha12,
  git_tree_hash: r.gitTreeHash,
  client_release: formatClientRelease(r.releaseNumber, r.gitSha),
};
console.log(JSON.stringify(out, null, 2));
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(out)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
  );
}
