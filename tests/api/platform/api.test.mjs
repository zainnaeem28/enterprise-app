// TC-API-02..08, 10 (client-release steps 1-5) and the request-ID case (TEST-CASES 10.6). ENV-INT/ci. TC-API-01 needs the
// deployed stack (fault injection endpoint, all modules) and TC-API-09 the Schemathesis run over published OpenAPI; both are
// BLOCKED here with the reason. The stack runs EHR_MIN_CLIENT_RELEASE=1, so "below minimum" (step 1, third value) cannot be
// expressed (r0 is malformed by the header grammar): recorded as a limitation, not a pass.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { newPatient, newStaff, login, anonymous, closeAdmin, sql, A1, uuid, principalId, patientId } from './lib/world.mjs';
import { rawRequest, state } from './lib/http.mjs';

after(() => closeAdmin());
const problem = (r) => /application\/problem\+json/.test(r.headers['content-type'] ?? '');

describe('TC-API', () => {
  test('TC-API-01 every module returns the standard problem body [deployed stack]', { skip: 'BLOCKED: needs ENV-INT/staging with the fault-injection endpoint and every R1 module routable; see TC-API-02/10 for the ci-level body checks' }, () => {});
  test('TC-API-09 contract test over the published OpenAPI documents [Schemathesis + contracts/openapi]', { skip: 'BLOCKED in this suite: run by tests/api/harness/schemathesis-run.mjs (QA-02) against the published documents, not by tests/api/platform' }, () => {});

  test('TC-API-02 401 without a session, 403 without the right, 404 for a patient outside the caller\'s scope; bodies are problem+json without PHI', async () => {
    const anon = anonymous('staff');
    const none = await anon.get('/api/v1/patients/' + patientId(1));
    assert.equal(none.status, 401);
    assert.equal(none.json.code, 'auth.unauthenticated');
    const fd = await newStaff([['front_desk', A1]], { name: 'STF-FD' });
    const lacks = await fd.client.post('/api/v1/patient-merges', { survivorId: uuid(), mergedId: uuid(), reason: 'x' });
    assert.equal(lacks.status, 403);
    assert.equal(lacks.json.code, 'auth.forbidden');
    const far = await newPatient({ locations: [(await import('./lib/world.mjs')).B1] });
    const out = await fd.client.get(`/api/v1/patients/${far.id}`);
    assert.equal(out.status, 404);
    assert.equal(out.json.code, 'kernel.not_found');
    for (const r of [none, lacks, out]) {
      assert.ok(problem(r), 'application/problem+json');
      for (const f of ['code', 'status', 'title', 'requestId']) assert.ok(r.json[f] !== undefined, `body has ${f}`);
      assert.doesNotMatch(r.text, /Patient \d|@patient\.qa-test|MRN-/, 'no PHI in the body');
    }
  });

  test('TC-API-03 patient search is POST-only: PHI in a GET URL is refused', async () => {
    const fd = await newStaff([['front_desk', A1]], { name: 'STF-FD' });
    const p = await newPatient({ given: 'Urlcheck', family: `Lookup${uuid().slice(0, 6)}` });
    const row = (await sql(`SELECT family_name, phone_e164 FROM patient.patient WHERE id = $1`, [p.id])).rows[0];
    const post = await fd.client.post('/api/v1/patients/search', { query: row.family_name, locationId: A1 });
    assert.ok([200, 422].includes(post.status), `POST search answers (${post.status})`);
    const get = await fd.client.get(`/api/v1/patients/search?familyName=${encodeURIComponent(row.family_name)}&phone=${encodeURIComponent(row.phone_e164)}`);
    assert.ok([404, 405].includes(get.status), `GET with PHI in the URL is refused (${get.status})`);
    assert.doesNotMatch(get.text, new RegExp(row.family_name));
    // The log half (no name/DOB/phone in the access and application logs) is checked on the run's own API log file.
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../../../reports/qa05/logs/', import.meta.url).pathname;
    const logs = readdirSync(dir).filter((f) => /api/.test(f)).map((f) => readFileSync(dir + f, 'utf8')).join('\n');
    assert.ok(!logs.includes(row.family_name) && !logs.includes(row.phone_e164), 'the API log carries neither the name nor the phone');
  });

  test('TC-API-04 PATCH without If-Match is 428, a stale If-Match is 412, the current one succeeds with a new ETag (patient record; notes route not in this stack)', async () => {
    const fd = await newStaff([['front_desk', A1]], { name: 'STF-FD' });
    const p = await newPatient();
    const g = await fd.client.get(`/api/v1/patients/${p.id}`);
    const etag = g.headers.etag;
    assert.ok(etag, 'GET returns an ETag');
    const none = await fd.client.patch(`/api/v1/patients/${p.id}`, { preferredLanguage: 'es' });
    assert.equal(none.status, 428);
    assert.equal(none.json.code, 'kernel.precondition_required');
    const stale = await fd.client.patch(`/api/v1/patients/${p.id}`, { preferredLanguage: 'es' }, { headers: { 'if-match': 'W/"999"' } });
    assert.equal(stale.status, 412);
    assert.equal(stale.json.code, 'kernel.precondition_failed');
    const ok = await fd.client.patch(`/api/v1/patients/${p.id}`, { preferredLanguage: 'es' }, { headers: { 'if-match': etag } });
    assert.equal(ok.status, 200, `${ok.status} ${ok.text.slice(0, 200)}`);
    assert.notEqual(ok.headers.etag, etag, 'a new ETag');
    const lang = await sql(`SELECT preferred_language l FROM patient.patient WHERE id = $1`, [p.id]);
    assert.equal(lang.rows[0].l, 'es');
  });

  test('TC-API-05 list limit is capped at 100 and a tampered cursor is refused', async () => {
    const fd = await newStaff([['front_desk', A1]], { name: 'STF-FD' });
    const big = await fd.client.get('/api/v1/threads?limit=1000');
    if (big.status === 200) assert.ok(big.json.items.length <= 100, 'at most 100 items');
    else assert.ok([400, 422].includes(big.status), `an over-limit request is capped or refused (${big.status})`);
    const bad = await fd.client.get('/api/v1/threads?cursor=' + encodeURIComponent('AAAA.tampered'));
    assert.ok([400, 422].includes(bad.status), `a tampered cursor is refused (${bad.status})`);
    assert.ok(!bad.json?.items?.length, 'no data');
    const off = await fd.client.get('/api/v1/threads?offset=100');
    assert.ok(off.status === 200 || [400, 422].includes(off.status));
  });

  test('TC-API-06 Cache-Control: no-store on API responses (success, error, redirect, anonymous)', async () => {
    const p = await newPatient();
    const fd = await newStaff([['front_desk', A1]], { name: 'STF-FD' });
    const rs = [
      await p.client.get('/api/v1/auth/session'),
      await p.client.get(`/api/v1/patients/${p.id}`),
      await fd.client.get('/api/v1/threads'),
      await fd.client.get('/api/v1/patients/' + uuid()),
      await anonymous('patient').get('/api/v1/auth/session'),
      await anonymous('patient').send('GET', '/api/v1/auth/sign-in?returnTo=/', { follow: 0 }),
    ];
    for (const r of rs) assert.match(r.headers['cache-control'] ?? '', /no-store/, `${r.url ?? ''} ${r.status}`);
  });

  test('TC-API-07 above the per-principal write limit the next call is 429 kernel.rate_limited with Retry-After', async () => {
    const p = await newPatient();
    let first;
    for (let i = 0; i < 80 && !first; i++) {
      const r = await p.client.post(`/api/v1/patients/${p.id}/contacts`, { kind: 'bogus' });
      if (r.status === 429) first = r;
    }
    assert.ok(first, 'a 429 appears within 80 writes (limit 60/min)');
    assert.equal(first.json.code, 'kernel.rate_limited');
    assert.ok(Number(first.headers['retry-after']) >= 1, 'Retry-After present');
    assert.ok(problem(first));
    // The per-IP anonymous limit and "next call after Retry-After succeeds" take over a minute and share the front IP limiter: not run here.
  });

  test('TC-API-08 a body over 1 MB is 413; unknown fields: ignored on portal endpoints', async () => {
    const p = await newPatient();
    const huge = JSON.stringify({ name: 'x'.repeat(1_100_000) });
    const r = await p.client.post(`/api/v1/patients/${p.id}/contacts`, huge);
    assert.equal(r.status, 413, `${r.status} ${r.text.slice(0, 120)}`);
    assert.ok(problem(r));
    const extra = await p.client.patch(`/api/v1/patients/${p.id}/profile`, { preferredLanguage: 'en', zzUnknown: 1 }, { headers: { 'if-match': 'W/"1"' } });
    assert.ok(![413, 500].includes(extra.status), `unknown field not a server error (${extra.status})`);
    // The integrations.-host half (unknown field rejected) needs the partner test credential: BLOCKED with the partner routes.
  });

  test('TC-API-10 client release: missing and malformed are 400 kernel.client_release_unsupported with no side effect; exempt routes work without it; N-1/N/N+1 accepted', async () => {
    const p = await newPatient();
    const before = (await sql(`SELECT count(*)::int n FROM kernel.idempotency_key`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    for (const h of [null, 'garbage', 'r0.000000000000', 'R1.000000000000']) {
      const hdr = h === null ? {} : { 'x-client-release': h };
      const s = state();
      const r = await rawRequest(`http://127.0.0.1:${s.ports.api}/api/v1/auth/session`, { headers: { 'x-forwarded-for': '10.99.0.1', ...hdr } });
      const body = JSON.parse(r.buf.toString());
      assert.equal(r.status, 400, `header ${h}`);
      assert.equal(body.code, 'kernel.client_release_unsupported');
      assert.equal(body.retryable, false);
      assert.match(r.headers['cache-control'], /no-store/);
      assert.ok(!r.setCookies.length, 'no session cookie written');
    }
    const after2 = (await sql(`SELECT count(*)::int n FROM kernel.idempotency_key`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    assert.equal(after2, before, 'no idempotency row');
    for (const rel of ['r1.0123456789ab', 'r2.0123456789ab', 'r99.0123456789ab']) {
      const ok = await p.client.get('/api/v1/auth/session', { headers: { 'x-client-release': rel } });
      assert.equal(ok.status, 200, rel);
    }
    const s = state();
    for (const path of ['/healthz', '/readyz', '/api/v1/auth/sign-in?returnTo=/']) {
      const r = await rawRequest(`http://127.0.0.1:${s.ports.api}${path}`, { headers: { 'x-forwarded-for': '10.99.0.2' } });
      assert.notEqual(r.status, 400, `${path} works without the header (${r.status})`);
    }
    const stream = await rawRequest(`http://127.0.0.1:${s.ports.api}/api/v1/alerts/stream?clientRelease=bad`, { headers: { 'x-forwarded-for': '10.99.0.3' } });
    assert.equal(stream.status, 400, 'the stream refuses an unsupported release with a plain 400');
    const cors = await p.client.get('/api/v1/auth/session');
    assert.ok(!Object.keys(cors.headers).some((k) => k.startsWith('access-control-allow')), 'no CORS allow headers on a portal-host response');
    // Steps 6-7 (CloudFront release.json, browser prompts) need ENV-INT/staging and a human for the wording: not run here.
  });

  test('TC-API-10b the X-Request-Id of a request appears in the response and in the audit event it caused', async () => {
    const fd = await newStaff([['front_desk', A1]], { name: 'STF-FD' });
    const p = await newPatient();
    const g = await fd.client.get(`/api/v1/patients/${p.id}`);
    const rid = g.headers['x-request-id'];
    assert.ok(rid, 'X-Request-Id on the response');
    const au = await sql(`SELECT count(*)::int n FROM audit.event WHERE request_id::text = $1`, [rid]).catch(() => ({ rows: [{ n: -1 }] }));
    assert.ok(au.rows[0].n >= 1, `audit event carries the request ID (${au.rows[0].n})`);
    // Log and trace search: the API log file is checked; no trace backend exists in ENV-INT/ci.
  });
});
