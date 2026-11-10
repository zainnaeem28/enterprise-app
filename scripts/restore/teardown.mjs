#!/usr/bin/env node
// Destroy restore targets (10.3 steps 2 and 5): the run's own target, or with --stale every restore-test target older than
// 24 h. Only identifiers starting `rt-` and tagged purpose=restore-test are ever deleted (lib/aws.mjs refuses anything else).
//   teardown.mjs --target <id>      |      teardown.mjs --stale [--max-age-hours 24]
import { aws, TARGET_PREFIX } from './lib/aws.mjs';
import { args, isMain, main } from '../deploy/lib/cli.mjs';
import { staleTargets } from './lib/plan.mjs';
import { dbGone } from './lib/wait.mjs';

export function deleteArgs(id) {
  return [
    'rds',
    'delete-db-instance',
    '--db-instance-identifier',
    id,
    '--skip-final-snapshot',
    '--delete-automated-backups',
  ];
}

if (isMain(import.meta.url))
  main(async () => {
    const a = args(process.argv.slice(2), {
      target: 'optional',
      stale: 'flag',
      'max-age-hours': 'optional',
      'wait-seconds': 'optional',
    });
    if (!a.target === !a.stale) throw new Error('give exactly one of --target and --stale');
    let ids;
    if (a.target) {
      if (!a.target.startsWith(TARGET_PREFIX))
        throw new Error(`"${a.target}" is not a restore-test target`);
      ids = [a.target];
    } else {
      const { DBInstances } = aws(['rds', 'describe-db-instances']);
      ids = staleTargets(DBInstances, { maxAgeHours: Number(a['max-age-hours'] ?? 24) });
    }
    const failed = [];
    for (const id of ids) {
      try {
        aws(deleteArgs(id));
        console.log(`deleting ${id}`);
      } catch (e) {
        // A target that is already gone is the goal; anything else is reported and fails the step after the others ran.
        if (/DBInstanceNotFound/.test(String(e.stderr ?? e.message)))
          console.log(`${id} is already gone`);
        else failed.push(id);
      }
    }
    if (failed.length) throw new Error(`could not delete: ${failed.join(', ')}`);
    // Deletion is asynchronous. The next matrix leg finds its target by tag, so wait until every target is really gone
    // (deadline of our own, named failure) instead of leaving one in `deleting` still carrying the tag.
    for (const id of ids)
      await dbGone(
        async () => aws(['rds', 'describe-db-instances', '--db-instance-identifier', id]),
        { timeoutSeconds: Number(a['wait-seconds'] ?? 1800), intervalSeconds: 20 },
      ).catch((e) => {
        throw new Error(`${id} is still not deleted: ${e.message}`);
      });
    console.log(
      ids.length
        ? `teardown requested for ${ids.length} target(s)`
        : 'no restore targets to tear down',
    );
  });
