#!/usr/bin/env node
// The final step of bootstrap.yml (16.2 step 3; decision log 4 step 6): wait until the expiry the task returned, force-delete the
// token secrets, check that they are gone. The secret is deleted at expiry, not on use, so it lives at most 30 minutes.
//   cleanup.mjs --env <env> --result <result.json> [--results-missing]
// With no usable result (the task failed or its output was refused) the two slot secrets are deleted at once, since nothing
// issued from them may be read: the database call either did not commit or its result cannot be trusted.
// Exit 1 names every secret that could not be deleted so the platform-admin break-glass role can delete it (16.2).
import { existsSync, readFileSync } from 'node:fs';
import { args, isMain, main } from '../deploy/lib/cli.mjs';
import { aws } from './lib/aws.mjs';
import { secretName } from './lib/result.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const DEFAULT_SLOTS = ['slot-1', 'slot-2'];
const notFound = (e) => /ResourceNotFoundException/.test(String(e.stderr ?? e.message));
const gone = (call, scope, name) => {
  try {
    // A force-deleted secret no longer exists: DescribeSecret must refuse. Any answer, even one with a DeletedDate, is "not gone".
    call(['secretsmanager', 'describe-secret', '--secret-id', name], scope);
    return false;
  } catch (e) {
    if (notFound(e)) return true;
    throw e;
  }
};

export async function cleanup({ env, names, waitUntil, now = Date.now, wait = sleep, call = aws }) {
  const scope = { env, record: `bootstrap-${env}` };
  if (waitUntil)
    for (let ms = waitUntil - now(); ms > 0; ms = waitUntil - now())
      await wait(Math.min(ms, 60_000));
  const failed = [];
  for (const name of names) {
    try {
      call(
        ['secretsmanager', 'delete-secret', '--secret-id', name, '--force-delete-without-recovery'],
        scope,
      );
    } catch (e) {
      if (!notFound(e)) {
        failed.push(name);
        continue;
      }
    }
    try {
      if (!gone(call, scope, name)) failed.push(name);
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

if (isMain(import.meta.url))
  main(async () => {
    const a = args(process.argv.slice(2), {
      env: 'required',
      result: 'required',
      'results-missing': 'flag',
    });
    let names = DEFAULT_SLOTS.map((s) => `bootstrap/${a.env}/token/${s}`);
    let waitUntil = 0;
    if (!a['results-missing'] && existsSync(a.result)) {
      const r = JSON.parse(readFileSync(a.result, 'utf8'));
      names = r.enrollees.filter((e) => e.secretArn).map((e) => secretName(e.secretArn));
      waitUntil = Date.parse(r.expires) + 15_000; // 15 s margin so the token is expired server-side before its secret goes
    }
    console.log(
      `deleting ${names.length} token secret(s)${waitUntil ? ` after ${new Date(waitUntil).toISOString()}` : ' now'}`,
    );
    const failed = await cleanup({ env: a.env, names, waitUntil });
    if (failed.length)
      throw new Error(
        `could not delete or confirm deletion of: ${failed.join(', ')}. Delete them with the platform-admin break-glass role now (16.2).`,
      );
    console.log('token secrets are gone');
  });
