#!/usr/bin/env node
// TC-PERF-04 (NFR-13): every chart view sent (k6 summary counter chart_views_sent) is recorded in audit.event for the run window, and
// nothing in the window is still unanchored after the 2-minute anchoring watermark. Read-only SQL (lib/psql.mjs).
// audit.event.anchor_id is never populated (db/migrations/0200_audit_event.sql); anchoring identifies rows by the half-open time
// range [from_ts, to_ts) of audit.anchor. Watermark is therefore judged as: rows in the window older than 120 s whose occurred_at is
// at or after the latest anchor's to_ts (no anchor yet covers them). audit.event has no commit timestamp, so occurred_at stands in
// for it; that approximation is stated in the report. Not verified here: Merkle root / chain correctness.
// usage: node check-audit.mjs --summary reports/TC-PERF-04.summary.json --from ISO --to ISO [--action view --resource-type ...]
import fs from 'node:fs';
import { query } from './lib/psql.mjs';
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const sent = JSON.parse(fs.readFileSync(arg('summary'), 'utf8')).metrics.chart_views_sent.values
  .count;
for (const k of ['from', 'to'])
  if (Number.isNaN(Date.parse(arg(k)))) throw new Error(`--${k} must be an ISO time`);
const action = arg('action', 'view');
if (!/^[a-z_]+$/.test(action)) throw new Error('bad --action');
const rt = arg('resource-type', '');
if (rt && !/^[A-Za-z_.]+$/.test(rt)) throw new Error('bad --resource-type');
const where = `occurred_at >= '${arg('from')}'::timestamptz and occurred_at < '${arg('to')}'::timestamptz and action = '${action}' and outcome = 'allowed'${rt ? ` and resource_type = '${rt}'` : ''}`;
const t0 = Date.now();
const [[recorded]] = query(`select count(*) from audit.event where ${where}`);
const queryMs = Date.now() - t0;
const [[late]] = query(
  `select count(*) from audit.event where ${where} and occurred_at < now() - interval '120 seconds' and occurred_at >= coalesce((select max(to_ts) from audit.anchor), '-infinity'::timestamptz)`,
);
const findings = [];
if (Number(recorded) < sent) findings.push(`audit loss: ${sent} views sent, ${recorded} recorded`);
if (Number(late) > 0)
  findings.push(
    `${late} rows older than the 120 s anchoring watermark are not covered by any audit.anchor range (run this check at least 3 minutes after the load ends)`,
  );
if (queryMs >= 500) findings.push(`audit count query took ${queryMs} ms (budget p95 < 500 ms)`);
const out = {
  sent,
  recorded: Number(recorded),
  unanchoredPastWatermark: Number(late),
  queryMs,
  findings,
  pass: findings.length === 0,
};
fs.writeFileSync(arg('out', 'audit-reconciliation.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
process.exit(out.pass ? 0 : 1);
