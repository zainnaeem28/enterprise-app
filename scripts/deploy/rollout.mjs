#!/usr/bin/env node
// Roll the worker, then the api, to the named task-definition ARNs and wait for steady state (DEVOPS-PLAN 9.1). ECS
// rolling update, min healthy 100 %, max 150 %, circuit breaker with rollback ON are properties of the SERVICE (IaC,
// DO-03); this script refuses to start if the start gate (api <= 6, worker <= 3) fails and never changes them.
//   rollout.mjs --cluster C --service worker=<name>:<taskdef-arn> --service api=<name>:<taskdef-arn> [--rollback]
import { aws } from './lib/aws.mjs';
import { args, isMain, main, setOutput } from './lib/cli.mjs';
import { startGate } from './lib/rollout.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Order is part of the contract: worker before api (9.1: migrate -> worker -> api -> portals). */
export const ROLLOUT_ORDER = ['worker', 'api'];

export function parseServices(list) {
  const out = {};
  for (const s of list) {
    const m = /^(worker|api)=([^:]+):(arn:aws:ecs:.+:task-definition\/[^:]+:\d+)$/.exec(s);
    if (!m)
      throw new Error(
        `--service must be worker|api=<service>:<task-definition ARN with revision>, got ${s}`,
      );
    out[m[1]] = { service: m[2], taskdef: m[3] };
  }
  for (const k of ROLLOUT_ORDER) if (!out[k]) throw new Error(`--service ${k}=... missing`);
  return out;
}

if (isMain(import.meta.url))
  main(async () => {
    const argv = process.argv.slice(2);
    const services = [];
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--service') services.push(argv[++i]);
      else rest.push(argv[i]);
    }
    const a = args(rest, { cluster: 'required', rollback: 'flag', 'timeout-minutes': 'optional' });
    const svc = parseServices(services);
    const desired = Object.fromEntries(
      ROLLOUT_ORDER.map((k) => [
        k,
        aws(['ecs', 'describe-services', '--cluster', a.cluster, '--services', svc[k].service])
          .services?.[0]?.desiredCount,
      ]),
    );
    const gate = startGate({
      api: desired.api,
      worker: desired.worker,
      isRollback: a.rollback === true,
    });
    if (gate.length) throw new Error(gate.join('; '));
    for (const k of ROLLOUT_ORDER) {
      aws([
        'ecs',
        'update-service',
        '--cluster',
        a.cluster,
        '--service',
        svc[k].service,
        '--task-definition',
        svc[k].taskdef,
      ]);
      const deadline = Date.now() + Number(a['timeout-minutes'] ?? 30) * 60_000;
      for (;;) {
        const s = aws([
          'ecs',
          'describe-services',
          '--cluster',
          a.cluster,
          '--services',
          svc[k].service,
        ]).services?.[0];
        const d = (s?.deployments ?? []).find((x) => x.status === 'PRIMARY');
        if (d?.rolloutState === 'FAILED')
          throw new Error(
            `${k}: deployment FAILED (circuit breaker); ECS is rolling back to the previous revision. The release is not complete.`,
          );
        if (
          d?.taskDefinition === svc[k].taskdef &&
          d.rolloutState === 'COMPLETED' &&
          s.deployments.length === 1
        )
          break;
        if (Date.now() > deadline)
          throw new Error(`${k}: rollout did not reach steady state in time`);
        await sleep(20_000);
      }
      setOutput(`${k}_rolled_out`, svc[k].taskdef);
    }
  });
