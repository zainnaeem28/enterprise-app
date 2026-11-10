// Shared pieces of the QA-07 k6 scenarios (TEST-CASES 11.2, 11.3). Plain k6 JavaScript, no extensions (decision D-2).
// Results are valid only on ENV-LOAD (`loadtest`); see ../README.md. There is deliberately NO knob that scales the load or
// the durations down: a run that cannot reach the stated rates is invalid (dropped_iterations threshold), never a pass.
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

// RFC 4122 v4 from Math.random: enough for idempotency keys; no remote import, so a run needs no internet access.
export function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---- environment guard -------------------------------------------------------------------------------------------------
const SELFTEST = __ENV.FIXTURE_SELFTEST === '1';
export const BASE_URL = (__ENV.BASE_URL || '').replace(/\/$/, '');
const host = BASE_URL.replace(/^https?:\/\//, '').split(/[/:]/)[0];

export function guard() {
  if (!BASE_URL) throw new Error('BASE_URL is required (the loadtest API origin).');
  if (SELFTEST) {
    if (!/^(127\.0\.0\.1|localhost)$/.test(host))
      throw new Error('FIXTURE_SELFTEST=1 is allowed against localhost only.');
    return;
  }
  if (__ENV.ENV_NAME !== 'loadtest')
    throw new Error('ENV_NAME must be "loadtest": load cases run on ENV-LOAD only (C-17).');
  if (!BASE_URL.startsWith('https://')) throw new Error('BASE_URL must be https on loadtest.');
  const allowed = (__ENV.LOADTEST_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.includes(host))
    throw new Error(
      `host ${host} is not in LOADTEST_HOSTS (explicit allow-list of loadtest origins).`,
    );
  if (!__ENV.CANDIDATE_COMMIT)
    throw new Error('CANDIDATE_COMMIT is required: it is recorded with the run.');
}
guard();

// ---- fixed profile (ARCHITECTURE 9.1: 450 req/s design point; 2x sustained 30 min; 3x burst 5 min) -----------------------
const T = SELFTEST ? Number(__ENV.SELFTEST_STAGE_S || 10) : null;
export const PEAK_RPS = { staff: 160, patient: 250, slot_search: 8, booking: 0.4, video: 5 };
export const PHASES = [
  { name: 'peak_1x', factor: 1, seconds: T || 600 },
  { name: 'sustained_2x', factor: 2, seconds: T || 1800 },
  { name: 'burst_3x', factor: 3, seconds: T || 300 },
];
export const ERROR_BUDGET = Number(__ENV.ERROR_BUDGET || 0.001); // ASSUMPTION: 0.1 %; the "agreed budget" is not fixed in the PRD.

/** One constant-arrival-rate scenario per phase, sequenced with startTime, so thresholds can be tagged per phase. */
export function phased(exec, prefix, peakRps, extra = {}) {
  const out = {};
  let start = 0;
  for (const p of PHASES) {
    const perTenS = Math.round(peakRps * p.factor * 10); // exact fractional rates via a 10 s time unit (booking 0.4/s = 4 per 10 s)
    const rate = perTenS / 10;
    out[`${prefix}_${p.name}`] = {
      executor: 'constant-arrival-rate',
      exec,
      rate: perTenS,
      timeUnit: '10s',
      duration: `${p.seconds}s`,
      startTime: `${start}s`,
      preAllocatedVUs: Math.ceil(rate * 2) + 20,
      maxVUs: Math.ceil(rate * 10) + 100,
      tags: { phase: p.name },
      ...extra,
    };
    start += p.seconds;
  }
  return out;
}

/** Audit loss is NOT judged in k6 (it cannot see the database): check-audit.mjs reconciles it after the run.
 * Thresholds shared by every latency scenario; `dropped_iterations` makes an under-driven run fail, not pass. */
export function latencyThresholds({ apiP95 = 500, slotP95 = 1000 } = {}) {
  const t = {
    dropped_iterations: ['count==0'],
    checks: ['rate>0.999'],
  };
  for (const p of PHASES.map((x) => x.name)) {
    t[`http_req_duration{class:api,phase:${p}}`] = [`p(95)<${apiP95}`];
    t[`http_req_duration{class:slot_search,phase:${p}}`] = [`p(95)<${slotP95}`];
    t[`http_req_failed{phase:${p}}`] = [`rate<${ERROR_BUDGET}`];
  }
  return t;
}

// ---- inputs supplied by the environment (never by this repository; no credential is committed) -------------------------
// SESSIONS_FILE: JSON array of {key, audience:'staff'|'patient', cookie, csrf, patientId?, clinicianId?, locationId?}
//   minted by the loadtest seeder task (harness/seed.sh) from the synthetic accounts. IDS_FILE: JSON {serviceId, locationIds[],
//   clinicianIds[], slots[], windowFrom, windowTo, ...}. Both are read in the init context.
export const sessions = new SharedArray('sessions', () =>
  JSON.parse(open(__ENV.SESSIONS_FILE || '../selftest/sessions.json')),
);
export const ids = JSON.parse(open(__ENV.IDS_FILE || '../selftest/ids.json'));
export const RELEASE = __ENV.CLIENT_RELEASE || 'r1.000000000000';

export function pick(audience) {
  const pool = sessions.filter((s) => s.audience === audience);
  return pool[Math.floor(Math.random() * pool.length)];
}
export function headers(s, extra = {}) {
  return {
    'X-Client-Release': RELEASE,
    'Content-Type': 'application/json',
    Cookie: `__Host-sid=${s.cookie}`,
    'X-CSRF-Token': s.csrf,
    Origin: BASE_URL,
    ...extra,
  };
}
export function get(s, path, cls = 'api', name) {
  const res = http.get(`${BASE_URL}${path}`, {
    headers: headers(s),
    tags: { class: cls, name: name || path.replace(/[0-9a-f-]{36}/g, ':id') },
  });
  check(res, {
    [`GET ${name || path.split('?')[0]} 2xx`]: (r) => r.status >= 200 && r.status < 300,
  });
  return res;
}
export function post(s, path, body, cls = 'api', extra = {}, okStatuses = [200, 201], name) {
  const res = http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: headers(s, extra),
    tags: { class: cls, name: name || path.replace(/[0-9a-f-]{36}/g, ':id') },
    responseCallback: http.expectedStatuses(...okStatuses),
  });
  check(res, { [`POST ${name || path} expected`]: (r) => okStatuses.includes(r.status) });
  return res;
}
export const idem = () => ({ 'Idempotency-Key': uuidv4() });

export function slotSearch(s) {
  const loc = ids.locationIds;
  return post(
    s,
    '/api/v1/availability/search',
    {
      serviceId: ids.serviceId,
      // all locations when ALL_LOCATIONS=1 (TC-PERF-02: "across all locations"); otherwise a single location
      ...(__ENV.ALL_LOCATIONS === '1'
        ? {}
        : { locationId: loc[Math.floor(Math.random() * loc.length)] }),
      mode: 'in_person',
      from: ids.windowFrom,
      to: ids.windowTo,
    },
    'slot_search',
    {},
    [200],
    '/api/v1/availability/search',
  );
}

/** Machine-readable evidence next to the console summary: run identity + thresholds, so a report is never anonymous. */
export function summaryWithMeta(id, data) {
  const meta = {
    case: id,
    candidateCommit: __ENV.CANDIDATE_COMMIT || null,
    envName: SELFTEST ? 'FIXTURE_SELFTEST (not evidence)' : __ENV.ENV_NAME,
    notEvidence: SELFTEST,
    baseUrlHost: host,
    k6Version: __ENV.K6_VERSION || null,
    scriptRevision: __ENV.SCRIPT_REVISION || null,
    infrastructure: __ENV.INFRA_SIZING_NOTE || null,
    startedAt: new Date().toISOString(),
  };
  const out = {};
  out[`${__ENV.REPORT_DIR || 'reports'}/${id}.summary.json`] = JSON.stringify(
    { meta, metrics: data.metrics, root_group: undefined },
    null,
    2,
  );
  const lines = [
    `${id} ${meta.notEvidence ? '[FIXTURE SELFTEST - NOT EVIDENCE]' : ''} candidate=${meta.candidateCommit}`,
  ];
  for (const [name, m] of Object.entries(data.metrics)) {
    for (const [expr, t] of Object.entries(m.thresholds || {}))
      lines.push(`${t.ok ? 'PASS' : 'FAIL'}  ${name}  ${expr}`);
  }
  out.stdout = lines.join('\n') + '\n';
  return out;
}

/** Note request body from ids.noteRequest (template supplied by the seeder), with the marker placed in every "__MARKER__" string. */
export function noteRequest(marker) {
  return JSON.parse(JSON.stringify(ids.noteRequest).replace(/__MARKER__/g, marker));
}
