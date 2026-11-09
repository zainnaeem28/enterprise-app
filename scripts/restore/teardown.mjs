#!/usr/bin/env node
// Destroy restore targets (10.3 steps 2 and 5): the run's own target, or with --stale every restore-test target older than
// 24 h. Only identifiers starting `rt-` and tagged purpose=restore-test are ever deleted (lib/aws.mjs refuses anything else).
//   teardown.mjs --target <id>      |      teardown.mjs --stale [--max-age-hours 24]
import { aws, TARGET_PREFIX } from './lib/aws.mjs';
import { args, isMain, main } from '../deploy/lib/cli.mjs';
import { staleTargets } from './lib/plan.mjs';

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
  main(() => {
    const a = args(process.argv.slice(2), {
      target: 'optional',
      stale: 'flag',
      'max-age-hours': 'optional',
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
    console.log(
      ids.length
        ? `teardown requested for ${ids.length} target(s)`
        : 'no restore targets to tear down',
    );
  });
