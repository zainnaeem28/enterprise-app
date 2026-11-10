#!/usr/bin/env node
// Rotate <env>/db/app-bootstrap after every run, success or failure (decision log 4.1 item 1), so no human, agent or log holds a
// usable value between runs. Secrets Manager managed rotation: this only starts it; the value never passes through here.
//   rotate-credential.mjs --env <env>
import { args, isMain, main } from '../deploy/lib/cli.mjs';
import { aws } from './lib/aws.mjs';

if (isMain(import.meta.url))
  main(() => {
    const a = args(process.argv.slice(2), { env: 'required' });
    aws(['secretsmanager', 'rotate-secret', '--secret-id', `${a.env}/db/app-bootstrap`], {
      env: a.env,
      record: `bootstrap-${a.env}`,
    });
    console.log(`rotation of ${a.env}/db/app-bootstrap requested`);
  });
