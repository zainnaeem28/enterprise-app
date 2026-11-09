// The only way the restore scripts call the AWS CLI (DEVOPS-PLAN 7.2, 10.3, DPR-17). gh-restore-test is bound in AWS;
// this is the second control: an allow-list of exactly the calls the monthly test makes, checked before a process starts.
//   - RunTask never carries --overrides (IAM cannot restrict them, DPR-28); the task finds its target by tag.
//   - A restore must be private, non-IAM-authenticated, in the pinned subnet group and tagged purpose=restore-test.
//   - A delete may only name an instance whose identifier starts with `rt-` (the prefix start-restore.mjs creates).
//   - Nothing registers a task definition, opens a shell, writes IAM, or reads restored data.
import { execFileSync } from 'node:child_process';

export const TARGET_PREFIX = 'rt-';
export const PURPOSE_TAG = 'purpose=restore-test';

const ALLOWED = new Map([
  ['rds', new Set(['restore-db-instance-to-point-in-time', 'describe-db-instances', 'delete-db-instance', 'describe-db-snapshots'])],
  ['ecs', new Set(['run-task', 'describe-tasks', 'stop-task'])],
  ['backup', new Set(['list-recovery-points-by-resource', 'describe-recovery-point', 'list-backup-jobs'])],
  ['ssm', new Set(['get-parameter'])],
  ['s3api', new Set(['get-object', 'head-object'])],
  ['sts', new Set(['get-caller-identity'])],
]);

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

/** Throws unless this exact call is one the restore test is meant to make. */
export function assertAllowed(args) {
  const [service, verb] = args;
  if (!service || !verb) throw new Error('aws: service and verb required');
  const verbs = ALLOWED.get(service);
  if (!verbs || !verbs.has(verb)) throw new Error(`restore scripts never run "aws ${service} ${verb}"`);
  if (args.includes('--overrides'))
    throw new Error('RunTask overrides are not used: the restore task finds its target by tag (DPR-28)');
  if (service === 'rds' && verb === 'restore-db-instance-to-point-in-time') {
    const id = flag(args, '--target-db-instance-identifier');
    if (!id?.startsWith(TARGET_PREFIX)) throw new Error(`restore target must start with "${TARGET_PREFIX}"`);
    if (!args.includes('--no-publicly-accessible')) throw new Error('restore target must be --no-publicly-accessible');
    if (!args.includes('--no-enable-iam-database-authentication'))
      throw new Error('restore target must not enable IAM database authentication');
    if (!flag(args, '--db-subnet-group-name')) throw new Error('restore target needs the pinned --db-subnet-group-name');
    if (!flag(args, '--vpc-security-group-ids')) throw new Error('restore target needs the pinned --vpc-security-group-ids');
    if (!(args.includes('--tags') && args.some((a) => a === `Key=purpose,Value=restore-test`)))
      throw new Error('restore target must be tagged purpose=restore-test');
    if (args.includes('--copy-tags-to-snapshot')) throw new Error('restore target must not copy tags to snapshots');
  }
  if (service === 'rds' && verb === 'delete-db-instance') {
    const id = flag(args, '--db-instance-identifier');
    if (!id?.startsWith(TARGET_PREFIX)) throw new Error(`refusing to delete "${id}": not a restore-test target`);
    if (!args.includes('--skip-final-snapshot')) throw new Error('a restore target is deleted without a final snapshot');
    if (!args.includes('--delete-automated-backups')) throw new Error('a restore target is deleted with its automated backups');
  }
  if (service === 's3api') {
    const key = flag(args, '--key') ?? '';
    if (!/^restore-test\/results\/[a-z0-9][a-z0-9/-]*\.json$/.test(key))
      throw new Error('only the PHI-free result documents under restore-test/results/ are read');
  }
  if (service === 'ssm' && flag(args, '--name') !== '/approved/restore-test')
    throw new Error('only /approved/restore-test is read');
}

export function aws(args, { json = true, runner = execFileSync } = {}) {
  assertAllowed(args);
  const out = runner('aws', [...args, ...(json ? ['--output', 'json'] : [])], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return json ? JSON.parse(out || 'null') : out;
}
