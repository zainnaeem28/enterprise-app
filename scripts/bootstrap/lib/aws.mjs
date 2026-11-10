// The only way the dual-control scripts (bootstrap and audit archive) call the AWS CLI (DEVOPS-PLAN 7.2, 7.4, 16.2).
// gh-bootstrap-<env> and gh-audit-archive are bound in AWS; this is the second control: an allow-list of exactly the calls
// these workflows make, checked before a process starts.
//   - RunTask never carries --overrides (IAM cannot restrict them, DPR-28); the pinned task takes no arguments.
//   - Nothing registers a task definition, opens a shell, writes IAM or reads a secret value.
//   - A secret is deleted only if its name is bootstrap/<env>/token/<slot> and only with force (no recovery window).
//   - Only the record of this workflow is read.
import { execFileSync } from 'node:child_process';

const ALLOWED = new Map([
  ['ecs', new Set(['run-task', 'describe-tasks'])],
  ['ssm', new Set(['get-parameter'])],
  ['logs', new Set(['get-log-events'])],
  ['secretsmanager', new Set(['delete-secret', 'describe-secret', 'rotate-secret'])],
  ['sts', new Set(['get-caller-identity'])],
]);
export const TOKEN_SECRET = (env) => new RegExp(`^bootstrap/${env}/token/[a-z0-9-]{1,40}$`);
const ENV = /^[a-z][a-z0-9-]{1,30}$/;

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

/** Throws unless this exact call is one the dual-control workflows are meant to make. `scope` = { env?, record } */
export function assertAllowed(args, scope) {
  const [service, verb] = args;
  if (!service || !verb) throw new Error('aws: service and verb required');
  const verbs = ALLOWED.get(service);
  if (!verbs || !verbs.has(verb))
    throw new Error(`these scripts never run "aws ${service} ${verb}"`);
  if (args.includes('--overrides'))
    throw new Error('RunTask overrides are not used: the pinned task takes no arguments (DPR-28)');
  if (args.includes('--container-overrides')) throw new Error('container overrides are never used');
  if (service === 'ssm' && flag(args, '--name') !== `/approved/${scope.record}`)
    throw new Error(`only /approved/${scope.record} is read`);
  if (service === 'secretsmanager') {
    if (!scope.env || !ENV.test(scope.env))
      throw new Error('secret calls need a valid environment');
    const id = flag(args, '--secret-id') ?? '';
    if (verb === 'rotate-secret') {
      if (id !== `${scope.env}/db/app-bootstrap`)
        throw new Error('only <env>/db/app-bootstrap is rotated');
    } else if (!TOKEN_SECRET(scope.env).test(id)) {
      throw new Error(
        `refusing "${verb}" on "${id}": not a bootstrap/${scope.env}/token/<slot> secret`,
      );
    }
    if (verb === 'delete-secret' && !args.includes('--force-delete-without-recovery'))
      throw new Error('a token secret is deleted with --force-delete-without-recovery');
  }
}

export function aws(args, scope, { json = true, runner = execFileSync } = {}) {
  assertAllowed(args, scope);
  const out = runner('aws', [...args, ...(json ? ['--output', 'json'] : [])], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return json ? JSON.parse(out || 'null') : out;
}
