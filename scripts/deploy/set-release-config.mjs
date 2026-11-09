#!/usr/bin/env node
// Record the deploy's environment configuration by NAME AND VERSION in the evidence, never by value of secrets
// (DEVOPS-PLAN 6.2). Writes the non-secret integer parameters the API reads: min_client_release (6.2) and, in staging,
// /deployed/release_number after smoke passes (DPR-33). Parameter names are inputs; values are integers only.
//   set-release-config.mjs --param /production/config/min_client_release --value 22
import { aws } from './lib/aws.mjs';
import { args, isMain, main, setOutput } from './lib/cli.mjs';

if (isMain(import.meta.url))
  main(() => {
    const a = args(process.argv.slice(2), { param: 'required', value: 'required' });
    if (!/^\/[A-Za-z0-9_./-]+$/.test(a.param) || a.param.startsWith('/approved/'))
      throw new Error('parameter name refused (never /approved/*)');
    if (!/^[1-9][0-9]{0,9}$/.test(a.value)) throw new Error('value must be a positive integer');
    const r = aws([
      'ssm',
      'put-parameter',
      '--name',
      a.param,
      '--type',
      'String',
      '--value',
      a.value,
      '--overwrite',
    ]);
    setOutput('parameter_version', r.Version);
  });
