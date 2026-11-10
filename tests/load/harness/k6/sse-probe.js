// Capability probe: can UNMODIFIED k6 (no xk6 extension) hold and measure SSE streams?
// Uses only built-in http. Run with K6_BINARY_PROVISIONING=false (see install-k6.sh).
import http from 'k6/http';
import { Trend, Counter } from 'k6/metrics';
import { check } from 'k6';

const base = __ENV.BASE_URL || 'http://127.0.0.1:8099';
const streamMs = Number(__ENV.STREAM_MS || 6000);
const ttfb = new Trend('sse_first_byte_ms', true);
const bodyEvents = new Counter('sse_events_seen_in_body');

export const options = {
  scenarios: { sse: { executor: 'constant-vus', vus: Number(__ENV.VUS || 20), duration: __ENV.DURATION || '15s' } },
  thresholds: { checks: ['rate>0.99'] },
};

export default function () {
  // Client-side timeout is the only way for built-in http to end an open stream.
  const res = http.get(`${base}/events`, { headers: { Accept: 'text/event-stream' }, timeout: `${streamMs}ms` });
  ttfb.add(res.timings.waiting);
  const body = typeof res.body === 'string' ? res.body : '';
  bodyEvents.add((body.match(/^data:/gm) || []).length);
  check(res, {
    'status 200': (r) => r.status === 200,
    'got a complete response without error': (r) => !r.error,
    'event bodies readable after the stream ended': () => body.length > 0,
  });
}
