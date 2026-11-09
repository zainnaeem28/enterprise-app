#!/usr/bin/env node
// Start the restore of the source instance into a fresh private instance in the pinned restore-test network
// (DEVOPS-PLAN 10.3 steps 1-2). It makes API calls only; no data passes through the runner.
//   start-restore.mjs --source <db-instance-id> --mode latest|pitr --subnet-group <name> --security-group <sg-id>
//                     --kms-key <arn> --instance-class <class> --run-id <id> [--attempt n] [--dry-run]
import { aws } from './lib/aws.mjs';
import { args, isMain, main, setOutput } from '../deploy/lib/cli.mjs';
import { choosePitrTime, targetIdentifier } from './lib/plan.mjs';
import { dbAvailable } from './lib/wait.mjs';

export function restoreArgs({ source, target, mode, time, subnetGroup, securityGroup, kmsKey, instanceClass, runId, ageSeconds, requestedEpoch }) {
  const a = [
    'rds', 'restore-db-instance-to-point-in-time',
    '--source-db-instance-identifier', source,
    '--target-db-instance-identifier', target,
    '--db-instance-class', instanceClass,
    '--db-subnet-group-name', subnetGroup,
    '--vpc-security-group-ids', securityGroup,
    '--no-publicly-accessible',
    '--no-multi-az',
    '--no-enable-iam-database-authentication',
    '--no-auto-minor-version-upgrade',
    '--kms-key-id', kmsKey,
    '--tags', 'Key=purpose,Value=restore-test', `Key=restore-run,Value=${runId}`, `Key=restore-mode,Value=${mode}`,
    `Key=restore-age-seconds,Value=${ageSeconds}`, `Key=restore-requested-epoch,Value=${requestedEpoch}`,
  ];
  if (mode === 'latest') a.push('--use-latest-restorable-time');
  else a.push('--restore-time', time.toISOString());
  return a;
}

export function planRestore({ instance, mode, now = new Date(), rand }) {
  const latest = instance.LatestRestorableTime;
  const when = mode === 'latest' ? new Date(latest) : choosePitrTime({ latestRestorable: latest, now, rand });
  if (Number.isNaN(when.getTime())) throw new Error('no LatestRestorableTime: point-in-time restore is not available');
  return { restorePoint: when, ageSeconds: Math.max(0, Math.round((now.getTime() - when.getTime()) / 1000)) };
}

if (isMain(import.meta.url))
  main(async () => {
    const a = args(process.argv.slice(2), {
      source: 'required', mode: 'required', 'subnet-group': 'required', 'security-group': 'required', 'kms-key': 'required',
      'instance-class': 'required', 'run-id': 'required', attempt: 'optional', 'dry-run': 'flag',
    });
    if (!['latest', 'pitr'].includes(a.mode)) throw new Error('--mode must be latest or pitr');
    const now = new Date();
    const { DBInstances } = aws(['rds', 'describe-db-instances', '--db-instance-identifier', a.source]);
    const plan = planRestore({ instance: DBInstances[0], mode: a.mode, now });
    const target = targetIdentifier({ now, runId: a['run-id'], attempt: a.attempt ?? '1' });
    const call = restoreArgs({
      source: a.source, target, mode: a.mode, time: plan.restorePoint, subnetGroup: a['subnet-group'],
      securityGroup: a['security-group'], kmsKey: a['kms-key'], instanceClass: a['instance-class'], runId: a['run-id'],
      ageSeconds: plan.ageSeconds, requestedEpoch: Math.floor(now.getTime() / 1000),
    });
    setOutput('target', target);
    setOutput('restore_point_age_seconds', plan.ageSeconds);
    if (a['dry-run']) return console.log(`dry run: aws ${call.join(' ')}`);
    const started = Date.now();
    aws(call);
    await dbAvailable(() => aws(['rds', 'describe-db-instances', '--db-instance-identifier', target]), { timeoutSeconds: 100 * 60 });
    setOutput('restore_seconds', Math.round((Date.now() - started) / 1000));
  });
