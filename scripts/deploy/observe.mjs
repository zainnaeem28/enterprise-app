#!/usr/bin/env node
// Observation window (DEVOPS-PLAN 9.2). READ-ONLY by construction: DEPLOY_READ_ONLY=1 is set below so lib/aws.mjs
// refuses any aws verb that is not describe-/list-/get-, and the job runs as gh-observe-production, whose policy has
// reads only (7.2, DPR-22). It never rolls back: a breach exits non-zero and the (separate, approved) recovery job or
// a person decides. Samples one per minute: ALB 5xx rate, p95 target response time, unhealthy hosts, alarms in ALARM.
//   observe.mjs --minutes 30 --lb app/x/y --tg targetgroup/x/y --alarm-prefix ehr-production- [--interval-seconds 60]
process.env.DEPLOY_READ_ONLY = '1';
const { aws } = await import('./lib/aws.mjs');
const { args, isMain, setOutput } = await import('./lib/cli.mjs');
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

/** Longest window the 18000 s role session (workflow) can cover, with margin for the API calls themselves. */
export const MAX_OBSERVE_MINUTES = 270;

/**
 * Turn get-metric-data results into ONE sample at ONE minute. Count/Max metrics publish no datapoint in a minute with
 * none, so the newest datapoint of each series can be minutes apart: the sample is taken at the newest timestamp seen in
 * any series, a series without a point at that minute is 0, and when that minute is older than `maxAgeSeconds` the
 * sample is all zeros (an old burst is never reported as current).
 */
export function toSample(results, alarms, now = new Date(), maxAgeSeconds = 180) {
  const series = results.map((r) => ({
    id: r.Id,
    pts: new Map((r.Timestamps ?? []).map((t, i) => [new Date(t).getTime(), r.Values?.[i] ?? 0])),
  }));
  const stamps = series.flatMap((x) => [...x.pts.keys()]);
  const at = stamps.length ? Math.max(...stamps) : null;
  const fresh = at !== null && now.getTime() - at <= maxAgeSeconds * 1000;
  const val = (id) => {
    if (!fresh) return 0;
    return series.find((x) => x.id === id)?.pts.get(at) ?? 0;
  };
  const req = val('req');
  return {
    errorRatePct: req > 0 ? (val('e5') / req) * 100 : 0,
    p95LatencySeconds: val('p95'),
    unhealthyHosts: val('unh'),
    alarmsInAlarm: alarms,
  };
}

if (isMain(import.meta.url))
  (async () => {
    const a = args(process.argv.slice(2), {
      minutes: 'required',
      lb: 'required',
      tg: 'required',
      'alarm-prefix': 'required',
      'interval-seconds': 'optional',
    });
    const minutes = Number(a.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_OBSERVE_MINUTES)
      throw new Error(
        `--minutes must be 1..${MAX_OBSERVE_MINUTES} (the observation role session is 18000 s)`,
      );
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
      if (v.abort) {
        // exit 2 + breach=true is the ONLY signal that may start the approved recovery; any other failure
        // (credentials, transport, bad arguments) exits 1 and is left to a person.
        setOutput('breach', 'true');
        console.error(
          `::error::abort threshold reached: ${v.reasons.join('; ')}. Start the approved recovery (9.3); this job changed nothing.`,
        );
        process.exit(2);
      }
      if (i < total - 1) await sleep(interval * 1000);
    }
    console.log('observation window completed without reaching an abort threshold');
  })().catch((e) => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
