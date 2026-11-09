#!/usr/bin/env node
// Refuse unless the restore-test record permits this run (15.3). Reads the record file the workflow fetched.
//   verify-record.mjs --record <file> [--now <iso>]
import { readFileSync } from 'node:fs';
import { args, isMain, main } from '../deploy/lib/cli.mjs';
import { checkRestoreRecord } from './lib/record.mjs';

if (isMain(import.meta.url))
  main(() => {
    const a = args(process.argv.slice(2), { record: 'required', now: 'optional' });
    const errs = checkRestoreRecord(readFileSync(a.record, 'utf8'), {
      now: a.now ? new Date(a.now) : new Date(),
    });
    if (errs.length)
      throw new Error(`restore-test record refuses this run:\n- ${errs.join('\n- ')}`);
    console.log('restore-test record permits this run');
  });
