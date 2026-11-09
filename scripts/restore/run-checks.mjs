#!/usr/bin/env node
// Run the pinned in-VPC task (10.3 step 3) and wait for it. The task definition is pinned by ARN; there are no overrides,
// so the task finds the target by tag. Exit code and timestamps come from ECS; the result document is fetched separately.
//   run-checks.mjs --cluster <name> --task-definition <arn> --subnets a,b --security-group <sg-id>
import { aws } from './lib/aws.mjs';
import { taskStopped } from './lib/wait.mjs';
import { args, isMain, main, setOutput } from '../deploy/lib/cli.mjs';

/** Exit 0 means the task wrote a valid result document (even a failing one); fetch-result.mjs reads the verdict. */
export function taskVerdict(task) {
  const c = task?.containers?.[0];
  if (!task || task.containers?.length !== 1) return { ok: false, why: 'task did not report exactly one container' };
  if (c.exitCode !== 0) return { ok: false, why: `container exited with ${c.exitCode ?? 'no exit code'}` };
  return { ok: true, why: 'exit 0' };
}

if (isMain(import.meta.url))
  main(async () => {
    const a = args(process.argv.slice(2), { cluster: 'required', 'task-definition': 'required', subnets: 'required', 'security-group': 'required' });
    const run = aws([
      'ecs', 'run-task', '--cluster', a.cluster, '--task-definition', a['task-definition'], '--launch-type', 'FARGATE', '--count', '1',
      '--network-configuration', `awsvpcConfiguration={subnets=[${a.subnets}],securityGroups=[${a['security-group']}],assignPublicIp=DISABLED}`,
    ]);
    if (run.failures?.length || run.tasks?.length !== 1) throw new Error('RunTask did not start exactly one task');
    const arn = run.tasks[0].taskArn;
    const task = await taskStopped(() => aws(['ecs', 'describe-tasks', '--cluster', a.cluster, '--tasks', arn]), { timeoutSeconds: 90 * 60 });
    const v = taskVerdict(task);
    setOutput('task_seconds', Math.round((Date.parse(task.stoppedAt) - Date.parse(task.startedAt)) / 1000));
    if (!v.ok) throw new Error(`restore check task failed: ${v.why}`);
  });
