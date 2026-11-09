// The only way deploy scripts call the AWS CLI. With DEPLOY_READ_ONLY=1 (the observation job) any verb that is not a
// read (describe-/list-/get-) is refused before a process is started, so "the observation job is read-only" does not
// depend on the role alone (the role is the real control; this is the second one).
import { execFileSync } from 'node:child_process';

export const READ_VERB = /^(describe|list|get)-[a-z0-9-]+$/;

export function assertAllowed(args, readOnly = process.env.DEPLOY_READ_ONLY === '1') {
  const [service, verb] = args;
  if (!service || !verb) throw new Error('aws: service and verb required');
  if (readOnly && !READ_VERB.test(verb))
    throw new Error(`read-only mode: refusing "aws ${service} ${verb}"`);
  if (service === 'ecs' && verb === 'register-task-definition')
    throw new Error('register-task-definition is never run from a workflow (7.5)');
  if (service === 'ecs' && verb === 'execute-command')
    throw new Error('execute-command is never run from a workflow (7.2)');
  if (service === 'iam') throw new Error('no IAM call is ever made by a deploy workflow (7.5)');
  if (args.includes('--overrides'))
    throw new Error(
      'RunTask overrides are not used: the migration task has a fixed entry point (7.5, DPR-28)',
    );
}

export function aws(args, { json = true, runner = execFileSync } = {}) {
  assertAllowed(args);
  const out = runner('aws', [...args, ...(json ? ['--output', 'json'] : [])], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return json ? JSON.parse(out || 'null') : out;
}
