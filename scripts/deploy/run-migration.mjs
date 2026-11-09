#!/usr/bin/env node
// Run the migration as ONE one-off ECS task from the pinned task definition (DEVOPS-PLAN 8.1 rule 3, 8.2 step 4).
// No `--overrides` (the fixed entry point and argument-free runner are the control, DPR-28; lib/aws.mjs refuses the
// flag). Aborts on a non-zero exit, a stop without exit code, or a timeout, and records the task ARN and exit code.
//   run-migration.mjs --cluster C --taskdef ARN --subnets a,b --security-groups sg-1 [--timeout-minutes 30]
import { aws } from './lib/aws.mjs';
import { args, isMain, main, setOutput } from './lib/cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decide from a describe-tasks result. Returns { done, ok, reason }. */
export function taskOutcome(task) {
  if (!task) return { done: true, ok: false, reason: 'task not found' };
  if (task.lastStatus !== 'STOPPED') return { done: false };
  const c = (task.containers ?? [])[0];
  if (!c || c.exitCode === undefined || c.exitCode === null)
    return {
      done: true,
      ok: false,
      reason: `task stopped without an exit code (${task.stoppedReason ?? 'no reason'})`,
    };
  return c.exitCode === 0
    ? { done: true, ok: true }
    : { done: true, ok: false, reason: `migration container exited ${c.exitCode}` };
}

if (isMain(import.meta.url))
  main(async () => {
    const a = args(process.argv.slice(2), {
      cluster: 'required',
      taskdef: 'required',
      subnets: 'required',
      'security-groups': 'required',
      'timeout-minutes': 'optional',
    });
    if (!/^arn:aws:ecs:[^:]+:\d{12}:task-definition\/[^:]+:\d+$/.test(a.taskdef))
      throw new Error(
        '--taskdef must be a task-definition ARN with a revision (pinned, never a family or "latest")',
      );
    const run = aws([
      'ecs',
      'run-task',
      '--cluster',
      a.cluster,
      '--task-definition',
      a.taskdef,
      '--launch-type',
      'FARGATE',
      '--count',
      '1',
      '--network-configuration',
      `awsvpcConfiguration={subnets=[${a.subnets}],securityGroups=[${a['security-groups']}],assignPublicIp=DISABLED}`,
    ]);
    if ((run.failures ?? []).length > 0)
      throw new Error(`run-task failed: ${JSON.stringify(run.failures)}`);
    const arn = run.tasks?.[0]?.taskArn;
    if (!arn) throw new Error('run-task returned no task');
    setOutput('migration_task_arn', arn);
    const deadline = Date.now() + Number(a['timeout-minutes'] ?? 30) * 60_000;
    for (;;) {
      const t = aws(['ecs', 'describe-tasks', '--cluster', a.cluster, '--tasks', arn]).tasks?.[0];
      const o = taskOutcome(t);
      if (o.done) {
        setOutput('migration_exit', t?.containers?.[0]?.exitCode ?? 'none');
        if (!o.ok)
          throw new Error(
            `migration failed: ${o.reason}. Schema state is NOT assumed; run catalogue-diff and stop (8.1 rule 6).`,
          );
        return;
      }
      if (Date.now() > deadline)
        throw new Error(
          `migration task ${arn} did not stop in time; it is left running for a person to inspect`,
        );
      await sleep(15_000);
    }
  });
