#!/usr/bin/env node
// DEVOPS-PLAN 8.2 steps 2-3 (production): backup freshness, the named pre-migration restore point, and, when the
// release contains a migration, a manual snapshot named with the release SHA that must be `available` before any
// migration runs. Subcommands: check | snapshot.
//   backup-gate.mjs check    --db ID --max-age-minutes 30 [--now ISO]
//   backup-gate.mjs snapshot --db ID --sha SHA --timeout-minutes 45
// Needs rds:DescribeDBInstances/DescribeDBSnapshots (+ rds:CreateDBSnapshot for `snapshot`), which gh-deploy-production
// does not hold today (see README "Permissions this workflow needs").
import { aws } from './lib/aws.mjs';
import { args, isMain, main, setOutput } from './lib/cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freshnessErrors(instance, maxAgeMinutes, now = new Date()) {
  if (!instance) return ['database instance not found'];
  const t = Date.parse(instance.LatestRestorableTime);
  if (Number.isNaN(t)) return ['no LatestRestorableTime: point-in-time restore is not available'];
  const age = (now.getTime() - t) / 60_000;
  return age > maxAgeMinutes
    ? [`latest restorable time is ${Math.round(age)} min old (limit ${maxAgeMinutes})`]
    : [];
}

export const snapshotName = (sha) => `release-${sha.slice(0, 12)}-pre-migration`;

if (isMain(import.meta.url))
  main(async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd === 'check') {
      const a = args(rest, { db: 'required', 'max-age-minutes': 'required', now: 'optional' });
      const inst = aws(['rds', 'describe-db-instances', '--db-instance-identifier', a.db])
        .DBInstances?.[0];
      const errs = freshnessErrors(
        inst,
        Number(a['max-age-minutes']),
        a.now ? new Date(a.now) : new Date(),
      );
      if (errs.length) throw new Error(`backup freshness check failed: ${errs.join('; ')}`);
      setOutput('restore_point', inst.LatestRestorableTime);
    } else if (cmd === 'snapshot') {
      const a = args(rest, { db: 'required', sha: 'required', 'timeout-minutes': 'required' });
      const name = snapshotName(a.sha);
      aws([
        'rds',
        'create-db-snapshot',
        '--db-instance-identifier',
        a.db,
        '--db-snapshot-identifier',
        name,
      ]);
      const deadline = Date.now() + Number(a['timeout-minutes']) * 60_000;
      for (;;) {
        const s = aws(['rds', 'describe-db-snapshots', '--db-snapshot-identifier', name])
          .DBSnapshots?.[0];
        if (s?.Status === 'available') return setOutput('snapshot', name);
        if (['failed', 'incompatible-restore'].includes(s?.Status))
          throw new Error(`snapshot ${name} is ${s.Status}; no migration runs`);
        if (Date.now() > deadline)
          throw new Error(
            `snapshot ${name} not available by the timeout; abort before migration (8.2 step 3)`,
          );
        await sleep(30_000);
      }
    } else throw new Error('usage: backup-gate.mjs check|snapshot ...');
  });
