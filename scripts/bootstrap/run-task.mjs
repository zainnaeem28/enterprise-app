#!/usr/bin/env node
// Run the pinned bootstrap-admins task once and read its result (16.2 steps 2-3; decision log 4).
//   run-task.mjs --env <env> --out <result.json>
// Environment (repository/environment variables, no secrets): BOOTSTRAP_CLUSTER, BOOTSTRAP_TASK_DEFINITION_ARN,
// BOOTSTRAP_SUBNETS (comma list), BOOTSTRAP_SECURITY_GROUP, BOOTSTRAP_LOG_GROUP, BOOTSTRAP_LOG_STREAM_PREFIX, BOOTSTRAP_CONTAINER;
// GITHUB_RUN_ID is the run reference the task is told about only through the approved record, never through an argument.
//
// The task definition has a fixed entryPoint and takes no arguments; RunTask is called with NO overrides (an override would
// page the security contact, and aws.mjs refuses it before a process starts). Nothing is printed except the validated,
// token-free result. A non-zero exit leaves the secrets for cleanup.mjs, which always runs.
import { writeFileSync } from 'node:fs';
import { args, isMain, main, setOutput } from '../deploy/lib/cli.mjs';
import { aws } from './lib/aws.mjs';
import { parseTaskResult } from './lib/result.mjs';

const need = (n) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set`);
  return v;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function runTaskArgs(cfg) {
  return [
    'ecs',
    'run-task',
    '--cluster',
    cfg.cluster,
    '--task-definition',
    cfg.taskDefinitionArn,
    '--launch-type',
    'FARGATE',
    '--count',
    '1',
    '--started-by',
    `${cfg.startedByPrefix ?? 'gh-bootstrap'}-${cfg.runId}`.slice(0, 36),
    '--no-enable-execute-command',
    '--network-configuration',
    `awsvpcConfiguration={subnets=[${cfg.subnets.join(',')}],securityGroups=[${cfg.securityGroup}],assignPublicIp=DISABLED}`,
  ];
}

export async function runOnce(
  cfg,
  { call = aws, wait = sleep, timeoutSeconds = 900, startedByPrefix } = {},
) {
  const scope = { env: cfg.env, record: `bootstrap-${cfg.env}` };
  const started = call(runTaskArgs({ ...cfg, startedByPrefix }), scope);
  if (started.failures?.length)
    throw new Error(`RunTask failed: ${started.failures.map((f) => f.reason).join(', ')}`);
  const arn = started.tasks?.[0]?.taskArn;
  if (!arn) throw new Error('RunTask returned no task');
  const taskId = arn.split('/').pop();
  for (let waited = 0; ; waited += 10) {
    const d = call(['ecs', 'describe-tasks', '--cluster', cfg.cluster, '--tasks', arn], scope);
    const t = d.tasks?.[0];
    if (t?.lastStatus === 'STOPPED') {
      const c = t.containers?.find((x) => x.name === cfg.container) ?? t.containers?.[0];
      return { taskId, exitCode: c?.exitCode ?? null, stoppedReason: t.stoppedReason ?? '' };
    }
    if (waited >= timeoutSeconds)
      throw new Error(`task ${taskId} did not stop within ${timeoutSeconds} s`);
    await wait(10_000);
  }
}

export function readLines(cfg, taskId, { call = aws } = {}) {
  const scope = { env: cfg.env, record: `bootstrap-${cfg.env}` };
  const base = [
    'logs',
    'get-log-events',
    '--log-group-name',
    cfg.logGroup,
    '--log-stream-name',
    `${cfg.logStreamPrefix}/${cfg.container}/${taskId}`,
    '--start-from-head',
  ];
  const lines = [];
  let token;
  for (let page = 0; page < 200; page++) {
    const r = call(token ? [...base, '--next-token', token] : base, scope);
    lines.push(...(r.events ?? []).map((e) => e.message));
    if (!r.nextForwardToken || r.nextForwardToken === token) return lines;
    token = r.nextForwardToken;
  }
  throw new Error('task log has more than 200 pages');
}

if (isMain(import.meta.url))
  main(async () => {
    const a = args(process.argv.slice(2), { env: 'required', out: 'required' });
    const cfg = {
      env: a.env,
      runId: need('GITHUB_RUN_ID'),
      cluster: need('BOOTSTRAP_CLUSTER'),
      taskDefinitionArn: need('BOOTSTRAP_TASK_DEFINITION_ARN'),
      subnets: need('BOOTSTRAP_SUBNETS').split(','),
      securityGroup: need('BOOTSTRAP_SECURITY_GROUP'),
      logGroup: need('BOOTSTRAP_LOG_GROUP'),
      logStreamPrefix: need('BOOTSTRAP_LOG_STREAM_PREFIX'),
      container: process.env.BOOTSTRAP_CONTAINER || 'bootstrap',
    };
    const { taskId, exitCode, stoppedReason } = await runOnce(cfg);
    setOutput('task_id', taskId);
    if (exitCode !== 0) {
      // The reason is ECS's, not the task's output: no log line is echoed on failure.
      throw new Error(
        `bootstrap task ${taskId} exited with ${exitCode}${stoppedReason ? ` (${stoppedReason})` : ''}; secrets are deleted by the cleanup step; inspect the database before any retry (16.2 step 7)`,
      );
    }
    const result = parseTaskResult(readLines(cfg, taskId), { env: a.env, runRef: cfg.runId });
    writeFileSync(a.out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    setOutput('mode', result.mode);
    setOutput('expires', result.expires);
    for (const e of result.enrollees)
      console.log(`slot ${e.slot}: ${e.result}${e.secretArn ? ` ${e.secretArn}` : ''}`);
  });
