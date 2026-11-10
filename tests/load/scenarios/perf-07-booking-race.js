// TC-PERF-07 (RA-R1-03): TC-BK-13..15 (100 parallel confirmations of one slot) while the PERF-01 background load runs.
// Run together with perf-01-mixed.js (separate k6 process, same window, see run-load.sh `perf-07`).
// Each round is its OWN scenario (100 VUs x 1 iteration) started at startTime = round * ROUND_GAP_S, so a round's 100 requests
// leave together and rounds cannot overlap or be consumed by a fast VU. Prove concurrency from the raw `--out json` points
// (100 requests per `round` tag whose timestamps lie within a few hundred ms of each other).
// Thresholds: race_wins{round:N} must equal exactly 1 (one confirmed winner per non-overbookable slot) and no 5xx.
// IMPORTANT: k6 exit 0 here is NOT proof of exactness. The database-side count in check-exactly-one.mjs is the authority.
import { Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { sessions, headers, BASE_URL, idem, ids, summaryWithMeta, guard } from '../lib/common.js';

guard();
const wins = new Counter('race_wins');
const ROUNDS = Number(__ENV.RACE_ROUNDS || 20);
const ROUND_GAP_S = 30;
const scenarios = {};
const thresholds = { checks: ['rate==1'] };
for (let r = 0; r < ROUNDS; r++) {
  scenarios[`round_${r}`] = { executor: 'per-vu-iterations', vus: 100, iterations: 1, startTime: `${r * ROUND_GAP_S}s`, maxDuration: `${ROUND_GAP_S - 5}s` };
  thresholds[`race_wins{round:${r}}`] = ['count==1'];
}
export const options = { scenarios, thresholds };
// One non-overbookable slot per round (ids.raceSlots[round]); mode via RACE_MODE: same (one patient) | distinct (default)
const mode = __ENV.RACE_MODE || 'distinct';
const patients = new SharedArray('racePatients', () => sessions.filter((s) => s.audience === 'patient'));
export default function () {
  const round = Number(exec.scenario.name.replace('round_', ''));
  const slot = ids.raceSlots[round];
  const s = mode === 'same' ? patients[0] : patients[(__VU - 1) % patients.length];
  const res = http.post(`${BASE_URL}/api/v1/holds`, JSON.stringify({ patientId: s.patientId, ...slot }), {
    headers: headers(s, idem()),
    tags: { class: 'api', name: '/api/v1/holds', round: String(round) },
    responseCallback: http.expectedStatuses(201, 409),
  });
  if (res.status === 201) {
    const c = http.post(`${BASE_URL}/api/v1/appointments/${res.json('reservationId')}/confirm`, '{}', {
      headers: headers(s, idem()),
      tags: { round: String(round) },
      responseCallback: http.expectedStatuses(200, 409),
    });
    if (c.status === 200) wins.add(1, { round: String(round) });
  }
  check(res, { 'hold answered 201 or 409 (never 5xx)': (r) => r.status === 201 || r.status === 409 });
  if (res.status === 409) check(res, { '409 carries alternatives': (r) => Array.isArray(r.json('alternatives')) });
}
export const handleSummary = (d) => summaryWithMeta('TC-PERF-07', d);
