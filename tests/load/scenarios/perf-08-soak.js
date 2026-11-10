// TC-PERF-08 (NFR-9): soak for several hours at 1x and a burst at 3x. Leaks and queue growth need the environment's own metrics,
// which NO script reads yet (series source undefined, see README). This k6 part only holds the load for 4 h and fails on p95 latency,
// error rate and dropped iterations over the soak and burst phases; it does NOT detect hour-to-hour drift, leaks or queue growth.
// A k6 exit 0 here is NOT a TC-PERF-08 PASS.
import { guard, latencyThresholds, PEAK_RPS, pick, get, slotSearch, summaryWithMeta } from '../lib/common.js';

guard();
const HOURS = __ENV.FIXTURE_SELFTEST === '1' ? 0 : 4; // "several hours": 4 h minimum, not configurable downwards
const soakS = HOURS ? HOURS * 3600 : 20;
const burstS = HOURS ? 300 : 5;
export const options = {
  scenarios: {
    soak_1x_staff: { executor: 'constant-arrival-rate', exec: 'staff', rate: PEAK_RPS.staff, timeUnit: '1s', duration: `${soakS}s`, preAllocatedVUs: 400, maxVUs: 1500, tags: { phase: 'soak' } },
    soak_1x_patient: { executor: 'constant-arrival-rate', exec: 'patient', rate: PEAK_RPS.patient, timeUnit: '1s', duration: `${soakS}s`, preAllocatedVUs: 600, maxVUs: 2000, tags: { phase: 'soak' } },
    soak_1x_search: { executor: 'constant-arrival-rate', exec: 'search', rate: PEAK_RPS.slot_search, timeUnit: '1s', duration: `${soakS}s`, preAllocatedVUs: 40, maxVUs: 400, tags: { phase: 'soak' } },
    burst_3x_staff: { executor: 'constant-arrival-rate', exec: 'staff', rate: PEAK_RPS.staff * 3, timeUnit: '1s', duration: `${burstS}s`, startTime: `${soakS}s`, preAllocatedVUs: 1000, maxVUs: 3000, tags: { phase: 'burst_3x' } },
    burst_3x_patient: { executor: 'constant-arrival-rate', exec: 'patient', rate: PEAK_RPS.patient * 3, timeUnit: '1s', duration: `${burstS}s`, startTime: `${soakS}s`, preAllocatedVUs: 1500, maxVUs: 4000, tags: { phase: 'burst_3x' } },
  },
  thresholds: {
    dropped_iterations: ['count==0'],
    checks: ['rate>0.999'],
    'http_req_duration{class:api,phase:soak}': ['p(95)<500'],
    'http_req_duration{class:api,phase:burst_3x}': ['p(95)<500'],
    'http_req_duration{class:slot_search,phase:soak}': ['p(95)<1000'],
    'http_req_failed{phase:soak}': ['rate<0.001'],
    'http_req_failed{phase:burst_3x}': ['rate<0.001'],
  },
};
void latencyThresholds;
export function staff() { get(pick('staff'), '/api/v1/auth/session'); }
export function patient() { get(pick('patient'), '/api/v1/clinicians'); }
export function search() { slotSearch(pick('patient')); }
export const handleSummary = (d) => summaryWithMeta('TC-PERF-08', d);
