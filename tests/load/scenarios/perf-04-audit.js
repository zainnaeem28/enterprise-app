// TC-PERF-04 (NFR-13): ~2 million chart-view audit events/day equivalent (~23/s average; peak-hour factor 2 => ~46/s of chart views).
// Every chart view writes one audit row. After the run, `check-audit.mjs` reconciles the number of views sent against audit.event
// rows (all recorded) and the commit lag against the 2-minute anchoring watermark; this script only generates the views and
// records them in a counter. Audit search latency is exercised in the same run so "queries stay in budget" is measured.
import { Counter } from 'k6/metrics';
import { phased, latencyThresholds, pick, get, ids, summaryWithMeta } from '../lib/common.js';

const views = new Counter('chart_views_sent');
export const options = {
  scenarios: phased('chartView', 'chart', 46),
  thresholds: { ...latencyThresholds(), chart_views_sent: ['count>0'] },
};
export function chartView() {
  const s = pick('staff');
  const pid = ids.patientIds[Math.floor(Math.random() * ids.patientIds.length)];
  const r = get(s, ids.chartViewPath.replace('{patientId}', pid), 'api', 'chart-view');
  if (r.status >= 200 && r.status < 300) views.add(1);
}
export const handleSummary = (d) => summaryWithMeta('TC-PERF-04', d);
