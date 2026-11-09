#!/usr/bin/env node
// Fetch the task's PHI-free result document, validate it strictly, and write the summary (10.3 steps 3 and 5). A missing,
// malformed or unexpected document fails the run: a skipped check is never a pass.
//   fetch-result.mjs --bucket <name> --run-id <id> --out <dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { aws } from './lib/aws.mjs';
import { args, isMain, main } from '../deploy/lib/cli.mjs';
import { summarise, validateResult } from './lib/result.mjs';

if (isMain(import.meta.url))
  main(() => {
    const a = args(process.argv.slice(2), { bucket: 'required', 'run-id': 'required', out: 'required' });
    mkdirSync(a.out, { recursive: true });
    const key = `restore-test/results/${a['run-id']}.json`;
    const file = `${a.out}/result.json`;
    aws(['s3api', 'get-object', '--bucket', a.bucket, '--key', key, file], { json: false });
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const errs = validateResult(doc);
    if (errs.length) {
      // The invalid file is removed so it can never be uploaded as an artifact.
      writeFileSync(file, '{}\n');
      throw new Error(`result document refused:\n- ${errs.join('\n- ')}`);
    }
    if (doc.run_id !== a['run-id']) throw new Error('result document is for a different run');
    writeFileSync(`${a.out}/summary.md`, `${summarise(doc)}\n`);
    console.log(summarise(doc));
    if (doc.overall !== 'pass') throw new Error(`restore test result is ${doc.overall}: a tracked finding is opened; two consecutive failures stop releases (10.3 step 6)`);
  });
