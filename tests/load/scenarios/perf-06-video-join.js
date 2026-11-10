// TC-PERF-06 (RA-R1-10, NFR-9): 250 concurrent video visits at headroom - join and signalling at peak. Needs the video vendor
// SANDBOX (not provisioned): without VENDOR_SANDBOX=1 the script refuses to run, and the case is recorded Blocked with the
// vendor named. Our API handles only join-token calls (media goes to the vendor): join success rate and latency are measured here.
import { Counter } from 'k6/metrics';
import { guard, sessions, headers, BASE_URL, idem, ids, summaryWithMeta } from '../lib/common.js';
import http from 'k6/http';
import { check, sleep } from 'k6';

guard();
if (__ENV.VENDOR_SANDBOX !== '1' && __ENV.FIXTURE_SELFTEST !== '1')
  throw new Error(
    'TC-PERF-06 is Blocked: VENDOR_SANDBOX=1 (named vendor sandbox with known limits) is required.',
  );
const joined = new Counter('video_joined');
const VUS = 250 * 2; // 250 concurrent visits at peak x 2 (NFR-9 sustained factor) = 500 VUs
export const options = {
  scenarios: {
    video: {
      executor: 'constant-vus',
      vus: VUS,
      duration: __ENV.FIXTURE_SELFTEST === '1' ? '10s' : '30m',
    },
  },
  thresholds: {
    'http_req_duration{name:join}': ['p(95)<500'],
    'http_req_failed{name:join}': ['rate<0.001'],
    video_joined: ['count>0'],
    checks: ['rate>0.99'], // TC-PERF-06 "join success meets target": target to be set by the Product Manager; 99% is the placeholder
  },
};
export default function () {
  const s = sessions.filter((x) => x.audience === 'patient')[
    (__VU - 1) % sessions.filter((x) => x.audience === 'patient').length
  ];
  const rid = ids.videoReservations[(__VU - 1) % ids.videoReservations.length];
  const r = http.post(`${BASE_URL}/api/v1/appointments/${rid}/video-session/join`, '{}', {
    headers: headers(s, idem()),
    tags: { name: 'join', class: 'api' },
  });
  const ok = check(r, {
    'join 200 with attendeeToken': (x) => x.status === 200 && !!x.json('attendeeToken'),
  });
  if (ok) joined.add(1);
  sleep(30 + Math.random() * 30);
}
export const handleSummary = (d) => summaryWithMeta('TC-PERF-06', d);
