// TC-REC-04 (release with a migration under load, then roll back) and TC-REC-07 (primary DB stopped during load):
// the AUTO part. A steady mixed read/write load runs while DevOps performs the disruption (OPS part, run by the person who owns
// ENV-LOAD/ENV-DR; this script never touches infrastructure). Every acknowledged write is recorded with its idempotency key so
// check-ledger.mjs can prove "no committed data lost", and the error window is measured: errors may only be brief.
//   REC_CASE=TC-REC-04  -> zero downtime: not one failed request in the whole run (threshold count==0)
//   REC_CASE=TC-REC-07  -> brief errors only: window length and recovery are judged by check-recovery.mjs (MAX_ERROR_WINDOW_S,
//                          default 120 s), which reads the raw `--out json` points; k6 itself only requires acknowledged writes.
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { check } from 'k6';
import { guard, pick, headers, BASE_URL, idem, ids, noteRequest, summaryWithMeta, PEAK_RPS } from '../lib/common.js';

guard();
const CASE = __ENV.REC_CASE;
if (CASE !== 'TC-REC-04' && CASE !== 'TC-REC-07') throw new Error('REC_CASE must be TC-REC-04 or TC-REC-07.');
const failed = new Counter('rec_failed_requests');
const acked = new Counter('rec_acked_writes');
const DURATION_S = Number(__ENV.REC_DURATION_S || (__ENV.FIXTURE_SELFTEST === '1' ? 20 : 3600)); // the disruption happens inside this window

export const options = {
  scenarios: {
    load: { executor: 'constant-arrival-rate', rate: PEAK_RPS.staff + PEAK_RPS.patient, timeUnit: '1s', duration: `${DURATION_S}s`, preAllocatedVUs: 500, maxVUs: 3000 },
  },
  thresholds: {
    // TC-REC-07: VUs stuck on a dead primary may exhaust maxVUs and drop iterations during the outage; recovery is judged by
    // check-recovery.mjs, so this threshold applies to TC-REC-04 only.
    ...(CASE === 'TC-REC-04' ? { dropped_iterations: ['count==0'] } : {}),
    rec_failed_requests: CASE === 'TC-REC-04' ? ['count==0'] : ['count>=0'],
    rec_acked_writes: ['count>0'],
  },
};

export default function () {
  const write = Math.random() < 0.02;
  const s = pick(write ? 'staff' : Math.random() < 0.6 ? 'patient' : 'staff');
  const key = idem();
  let res;
  if (write) {
    // write path whose effect is countable later: an encounter note carrying a unique marker (idempotent by key)
    const enc = ids.encounters[Math.floor(Math.random() * ids.encounters.length)];
    const marker = `rec-${CASE}-${key['Idempotency-Key']}`;
    res = http.post(`${BASE_URL}/api/v1/encounters/${enc}/notes`, JSON.stringify(noteRequest(marker)), { headers: headers(s, key), tags: { name: 'note-write' }, responseCallback: http.expectedStatuses({ min: 200, max: 499 }) });
    if (res.status === 200 || res.status === 201) { acked.add(1); console.log(`ACK ${enc} ${marker}`); }
  } else {
    res = http.get(`${BASE_URL}/api/v1/auth/session`, { headers: headers(s), tags: { name: 'session' }, responseCallback: http.expectedStatuses({ min: 200, max: 499 }) });
  }
  // outage = transport error or 5xx; 4xx business answers are not an outage. Windows are computed after the run by
  // check-recovery.mjs from the raw `--out json` points (a VU-local view would be wrong).
  if (res.status === 0 || res.status >= 500) failed.add(1);
  check(res, { 'not a server error': (r) => r.status > 0 && r.status < 500 });
}
export const handleSummary = (d) => summaryWithMeta(CASE, d);
