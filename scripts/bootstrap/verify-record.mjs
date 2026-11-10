#!/usr/bin/env node
// Refuse unless the bootstrap-<env> record permits this run (16.2 step 1, 7.4, 15.3). Reads the record file the workflow fetched.
//   verify-record.mjs --env <env> --record <file> [--now <iso>]
import { readFileSync } from 'node:fs';
import { args, isMain, main } from '../deploy/lib/cli.mjs';
import { checkBootstrapRecord } from './lib/record.mjs';

if (isMain(import.meta.url))
  main(() => {
    const a = args(process.argv.slice(2), { env: 'required', record: 'required', now: 'optional' });
    const errs = checkBootstrapRecord(readFileSync(a.record, 'utf8'), {
      environment: a.env,
      now: a.now ? new Date(a.now) : new Date(),
    });
    if (errs.length)
      throw new Error(`bootstrap-${a.env} record refuses this run:\n- ${errs.join('\n- ')}`);
    console.log(`bootstrap-${a.env} record permits this run`);
  });
