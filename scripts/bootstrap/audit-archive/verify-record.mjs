#!/usr/bin/env node
// Refuse unless the audit-archive record permits archiving this partition (ARCHITECTURE 6, DEVOPS-PLAN 4.1 A2, 7.4).
//   verify-record.mjs --partition audit.event_YYYY_MM --record <file> [--now <iso>]
import { readFileSync } from 'node:fs';
import { args, isMain, main } from '../../deploy/lib/cli.mjs';
import { checkArchiveRecord } from '../lib/record.mjs';

if (isMain(import.meta.url))
  main(() => {
    const a = args(process.argv.slice(2), {
      partition: 'required',
      record: 'required',
      now: 'optional',
    });
    const errs = checkArchiveRecord(readFileSync(a.record, 'utf8'), {
      partition: a.partition,
      now: a.now ? new Date(a.now) : new Date(),
    });
    if (errs.length)
      throw new Error(`audit-archive record refuses this run:\n- ${errs.join('\n- ')}`);
    console.log(`audit-archive record permits archiving ${a.partition}`);
  });
