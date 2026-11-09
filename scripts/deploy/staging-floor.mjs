#!/usr/bin/env node
// Decide staging's min_client_release (DPR-33) from the deployed-state parameters. Read-only on AWS.
//   staging-floor.mjs --manifest m.json [--rollback-rehearsal]
import { readFileSync } from 'node:fs';
import { aws } from './lib/aws.mjs';
import { args, isMain, main, setOutput } from './lib/cli.mjs';
import { stagingMinClient } from './lib/staging.mjs';

const read = (name) => {
  try {
    const v = aws(['ssm', 'get-parameter', '--name', name]).Parameter.Value;
    return Number(v);
  } catch (e) {
    if (/ParameterNotFound/.test(String(e.stderr ?? e.message))) return null;
    throw e;
  }
};

if (isMain(import.meta.url))
  main(() => {
    const a = args(process.argv.slice(2), { manifest: 'required', 'rollback-rehearsal': 'flag' });
    const n = JSON.parse(readFileSync(a.manifest, 'utf8')).release_number;
    const deployed = read('/deployed/release_number');
    const r = stagingMinClient({
      manifestNumber: n,
      deployedNumber: deployed,
      storedForManifest: read(`/deployed/min_client_release/${n}`),
      rollbackRehearsal: a['rollback-rehearsal'] === true,
    });
    console.log(`min_client_release ${r.value}: ${r.reason}`);
    setOutput('min_client_release', r.value);
  });
