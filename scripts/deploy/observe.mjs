#!/usr/bin/env node
// Observation window (DEVOPS-PLAN 9.2). READ-ONLY by construction: DEPLOY_READ_ONLY=1 is set below so lib/aws.mjs
// refuses any aws verb that is not describe-/list-/get-, and the job runs as gh-observe-production, whose policy has
// reads only (7.2, DPR-22). It never rolls back: a breach exits non-zero and the (separate, approved) recovery job or
// a person decides. Samples one per minute: ALB 5xx rate, p95 target response time, unhealthy hosts, alarms in ALARM.
//   observe.mjs --minutes 30 --lb app/x/y --tg targetgroup/x/y --alarm-prefix ehr-production- [--interval-seconds 60]
process.env.DEPLOY_READ_ONLY = '1';
const { aws } = await import('./lib/aws.mjs');
const { args, isMain, main } = await import('./lib/cli.mjs');
const { observationVerdict, DEFAULT_THRESHOLDS } = await import('./lib/rollout.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function metricQueries(lb, tg) {
  const dims = [{ Name: 'LoadBalancer', Value: lb }];
  const q = (id, name, stat, extra = []) => ({
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/ApplicationELB',
        MetricName: name,
        Dimensions: [...dims, ...extra],
      },
      Period: 60,
      Stat: stat,
    },
  });
  return [
    q('req', 'RequestCount', 'Sum'),
    q('e5', 'HTTPCode_Target_5XX_Count', 'Sum'),
    q('p95', 'TargetResponseTime', 'p95'),
    q('unh', 'UnHealthyHostCount', 'Maximum', [{ Name: 'TargetGroup', Value: tg }]),
  ];
}

/** Turn get-metric-data results (latest datapoint of each id) into one sample. */
export function toSample(results, alarms) {
  const last = (id) => {
    const r = results.find((x) => x.Id === id);
    return r && r.Values?.length ? r.Values[0] : 0; // get-metric-data is newest-first by default
  };
  const req = last('req');
  return {
    errorRatePct: req > 0 ? (last('e5') / req) * 100 : 0,
    p95LatencySeconds: last('p95'),
    unhealthyHosts: last('unh'),
    alarmsInAlarm: alarms,
  };
}

if (isMain(import.meta.url))
  main(async () => {
    const a = args(process.argv.slice(2), {
      minutes: 'required',
      lb: 'required',
      tg: 'required',
      'alarm-prefix': 'required',
      'interval-seconds': 'optional',
    });
    const interval = Number(a['interval-seconds'] ?? 60);
    const total = Math.ceil((Number(a.minutes) * 60) / interval);
    const samples = [];
    for (let i = 0; i < total; i++) {
      const end = new Date();
      const start = new Date(end.getTime() - 5 * 60_000);
      const data = aws([
        'cloudwatch',
        'get-metric-data',
        '--start-time',
        start.toISOString(),
        '--end-time',
        end.toISOString(),
        '--metric-data-queries',
        JSON.stringify(metricQueries(a.lb, a.tg)),
      ]);
      const alarms = aws([
        'cloudwatch',
        'describe-alarms',
        '--alarm-name-prefix',
        a['alarm-prefix'],
        '--state-value',
        'ALARM',
      ]).MetricAlarms.map((x) => x.AlarmName);
      samples.push(toSample(data.MetricDataResults, alarms));
      const v = observationVerdict(samples, DEFAULT_THRESHOLDS);
      console.log(`minute ${i + 1}/${total}: ${JSON.stringify(samples.at(-1))}`);
      if (v.abort)
        throw new Error(
          `abort threshold reached: ${v.reasons.join('; ')}. Start the approved recovery (9.3); this job changed nothing.`,
        );
      if (i < total - 1) await sleep(interval * 1000);
    }
    console.log('observation window completed without reaching an abort threshold');
  });
