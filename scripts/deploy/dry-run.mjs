#!/usr/bin/env node
// Dry run of the production verification chain against a LOCAL stub of the release manifest and the approved-release
// record. No AWS call, no network: it exercises exactly what the first job of deploy-production.yml runs
// (verify-release.mjs) plus the rollout start gate and the staging floor, and prints the plan the job would follow.
//   dry-run.mjs --manifest m.json --record r.json [--previous-manifest p.json] [--now ISO] [--api-desired 4 --worker-desired 2]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { args, main } from './lib/cli.mjs';
import { sha256 } from '../release/lib/hash.mjs';
import { startGate } from './lib/rollout.mjs';

main(() => {
  const a = args(process.argv.slice(2), {
    manifest: 'required',
    record: 'required',
    'previous-manifest': 'optional',
    now: 'optional',
    'api-desired': 'optional',
    'worker-desired': 'optional',
  });
  const hash = sha256(readFileSync(a.manifest));
  const verify = [
    '--manifest',
    a.manifest,
    '--manifest-hash',
    hash,
    '--record',
    a.record,
    '--environment',
    'production',
    '--actions',
    'rollout,smoke,portal-switch',
  ];
  if (a['previous-manifest']) verify.push('--previous-manifest', a['previous-manifest']);
  if (a.now) verify.push('--now', a.now);
  const out = execFileSync('node', [join(import.meta.dirname, 'verify-release.mjs'), ...verify], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: '' },
  });
  process.stdout.write(out);
  const gate = startGate({
    api: Number(a['api-desired'] ?? 4),
    worker: Number(a['worker-desired'] ?? 2),
  });
  if (gate.length) throw new Error(gate.join('; '));
  console.log(
    'plan: snapshot (if new migrations) -> migrate -> worker -> api -> portal switch -> smoke -> observe (read-only)',
  );
  console.log('dry-run complete: nothing was contacted, nothing was changed');
});
