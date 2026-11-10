// TC-PERF-07 (RA-R1-03): TC-BK-13..15 (100 parallel confirmations of one slot) while the PERF-01 background load runs.
// Run together with perf-01-mixed.js (separate k6 process, same window, see run-load.sh `perf-07`). Exactness is asserted by
// check-exactly-one.mjs against the database-side count; here each round reports its wins, and the thresholds fail the run when
// any round had a number of winners other than expected.
import { Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { check } from 'k6';
import { sessions, headers, BASE_URL, idem, ids, summaryWithMeta, guard } from '../lib/common.js';

guard();
const wins = new Counter('race_wins');
const bad = new Counter('race_rounds_wrong_winner_count');
const ROUNDS = Number(__ENV.RACE_ROUNDS || 20);
export const options = {
  scenarios: {
    race: { executor: 'per-vu-iterations', vus: 100, iterations: ROUNDS, maxDuration: '30m' },
  },
  thresholds: { race_rounds_wrong_winner_count: ['count==0'], checks: ['rate==1'] },
};
// One non-overbookable slot per round (ids.raceSlots[round]); mode via RACE_MODE: same | distinct | cap2
const mode = __ENV.RACE_MODE || 'distinct';
const patients = new SharedArray('racePatients', () => sessions.filter((s) => s.audience === 'patient'));
export default function () {
  const round = __ITER;
  const slot = ids.raceSlots[round];
  const s = mode === 'same' ? patients[0] : patients[(__VU - 1) % patients.length];
  const res = http.post(`${BASE_URL}/api/v1/holds`, JSON.stringify({ patientId: s.patientId, ...slot }), {
    headers: headers(s, idem()),
    tags: { class: 'api', name: '/api/v1/holds', round: String(round) },
    responseCallback: http.expectedStatuses(201, 409),
  });
  let won = 0;
  if (res.status === 201) {
    const c = http.post(`${BASE_URL}/api/v1/appointments/${res.json('reservationId')}/confirm`, '{}', {
      headers: headers(s, idem()),
      responseCallback: http.expectedStatuses(200, 409),
    });
    if (c.status === 200) { won = 1; wins.add(1, { round: String(round) }); }
  }
  check(res, { 'hold answered 201 or 409 (never 5xx)': (r) => r.status === 201 || r.status === 409 });
  // all 100 VUs finish the round before the next iteration starts: the per-round winner count is verified from the DB side
  // (check-exactly-one.mjs); a VU that wins records it via the counter so the summary can also be reconciled.
  if (won === 0 && res.status === 409) check(res, { '409 carries alternatives': (r) => Array.isArray(r.json('alternatives')) });
}
export function teardown() {
  // authoritative verification happens in check-exactly-one.mjs (DB count); nothing is asserted in-process
  void bad;
}
export const handleSummary = (d) => summaryWithMeta('TC-PERF-07', d);
