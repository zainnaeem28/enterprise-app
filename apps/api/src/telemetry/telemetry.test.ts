import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  ALLOWED_ATTRIBUTE_KEYS,
  loadTelemetryConfig,
  normaliseRoute,
  resourceAttributes,
  scrubAttributes,
  scrubSpan,
  scrubSpanName,
  startTelemetry,
  TelemetryConfigError,
  wrapSpanExporter,
} from './index.js';
import type { SdkOptions, SpanLike } from './index.js';

const ALLOWLIST_FILE = 'infra/modules/observability/adot/allowed-attributes.json';
const CANARIES_FILE = 'infra/modules/observability/tests/phi-canaries.json';

function fromRepoRoot(rel: string): string {
  for (let dir = resolve(process.cwd()); ; dir = dirname(dir)) {
    const p = join(dir, rel);
    if (existsSync(p)) return p;
    if (dirname(dir) === dir) throw new Error(`${rel} not found above ${process.cwd()}`);
  }
}
const canaries: string[] = (JSON.parse(readFileSync(fromRepoRoot(CANARIES_FILE), 'utf8')) as { values: string[] }).values;

describe('allowlist', () => {
  test('matches the collector allowlist in infra', () => {
    const infra = (JSON.parse(readFileSync(fromRepoRoot(ALLOWLIST_FILE), 'utf8')) as { allowed_keys: string[] }).allowed_keys;
    assert.deepEqual([...ALLOWED_ATTRIBUTE_KEYS].sort(), [...infra].sort());
  });
});

describe('scrubAttributes', () => {
  test('drops keys that are not on the allowlist, without returning their names', () => {
    const r = scrubAttributes({ 'http.route': '/api/v1/appointments', 'patient.name': 'x', 'db.statement': 'select 1', 'http.url': 'https://x/?a=1' });
    assert.deepEqual(r.attributes, { 'http.route': '/api/v1/appointments' });
    assert.equal(r.dropped, 3);
  });
  test('redacts every canary even under an allowed key', () => {
    for (const c of canaries) {
      const r = scrubAttributes({ 'ehr.job_type': `prefix ${c} suffix`, 'error.type': c });
      assert.ok(!JSON.stringify(r).includes(c), `canary survived: ${c}`);
    }
  });
  test('drops objects and keeps scalar arrays scrubbed', () => {
    const r = scrubAttributes({ 'ehr.queue': { nested: 1 }, 'ehr.audience': ['staff', canaries[0] ?? ''] });
    assert.deepEqual(r.attributes, { 'ehr.audience': ['staff', '[redacted]'] });
  });
  test('over-long values are redacted', () => {
    assert.equal(scrubAttributes({ 'error.type': 'x'.repeat(300) }).attributes['error.type'], '[redacted]');
  });
  test('benign values pass unchanged', () => {
    const a = { 'http.response.status_code': 200, 'ehr.request_id': '3f9a1c2b7d10', 'db.system': 'postgresql', 'ehr.release_number': 142 };
    assert.deepEqual(scrubAttributes(a).attributes, a);
  });
});

describe('route and span name', () => {
  test('identifiers and query strings never survive in a route', () => {
    assert.equal(normaliseRoute('/api/v1/patients/3f9a1c2b-7d10-4e5f-8a9b-0123456789ab/chart?x=1'), '/api/v1/patients/:id/chart');
    assert.equal(normaliseRoute('/api/v1/slots/1234567'), '/api/v1/slots/:id');
    assert.equal(scrubAttributes({ 'http.route': '/api/v1/patients/123456789/chart' }).attributes['http.route'], '/api/v1/patients/:id/chart');
  });
  test('span names keep method and templated path only', () => {
    assert.equal(scrubSpanName('GET /api/v1/patients/123456789?name=Ann'), 'GET /api/v1/patients/:id');
    for (const c of canaries) assert.ok(!scrubSpanName(`GET /x/${c}`).includes(c));
  });
});

describe('exporter wrapper', () => {
  const dirty = (c: string): SpanLike => ({
    name: `POST /api/v1/patients/123456789 ${c}`,
    attributes: { 'http.route': '/api/v1/patients/123456789', 'enduser.id': c, 'http.url': `https://x/?q=${c}`, 'ehr.job_type': c },
    events: [{ name: `exception ${c}`, attributes: { 'exception.message': c, 'exception.stacktrace': c, 'exception.type': 'Error' } }],
    links: [{ attributes: { 'ehr.queue': c } }],
    resource: { attributes: { 'service.name': 'ehr-api', 'host.name': c } },
    status: { code: 2, message: c },
  });

  test('no canary is present in the exported spans', () => {
    for (const c of canaries) {
      const out: SpanLike[][] = [];
      const exporter = wrapSpanExporter({
        export: (spans, cb) => {
          out.push(spans);
          cb({ code: 0 });
        },
        shutdown: () => Promise.resolve(),
      });
      exporter.export([dirty(c)], () => undefined);
      assert.ok(!JSON.stringify(out).includes(c), `canary survived export: ${c}`);
      const s = out[0]?.[0];
      assert.equal(s?.status?.message, undefined);
      assert.equal(s?.resource?.attributes['host.name'], undefined);
      assert.equal(s?.events?.[0]?.attributes?.['exception.type'], 'Error');
    }
  });
  test('prototype and untouched fields of the original span survive', () => {
    class Span {
      readonly kind = 1;
      name = 'GET /x';
      attributes: Record<string, unknown> = { 'http.route': '/x', secret: 's' };
      get duration(): number {
        return 5;
      }
    }
    const copy = scrubSpan(new Span());
    assert.equal(copy.duration, 5);
    assert.equal(copy.kind, 1);
    assert.deepEqual(copy.attributes, { 'http.route': '/x' });
  });
  test('forceFlush is only exposed when the inner exporter has it', async () => {
    const base = { export: (_: SpanLike[], cb: (r: { code: number }) => void) => cb({ code: 0 }), shutdown: () => Promise.resolve() };
    assert.equal(wrapSpanExporter(base).forceFlush, undefined);
    let flushed = false;
    const w = wrapSpanExporter({ ...base, forceFlush: () => ((flushed = true), Promise.resolve()) });
    await w.forceFlush?.();
    assert.ok(flushed);
  });
});

describe('config', () => {
  test('defaults are off and loopback', () => {
    const c = loadTelemetryConfig({});
    assert.equal(c.enabled, false);
    assert.equal(c.endpoint, 'http://127.0.0.1:4318');
  });
  test('a non-loopback endpoint is refused and the value is not echoed', () => {
    assert.throws(
      () => loadTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.vendor.example:4318' }),
      (e: unknown) => e instanceof TelemetryConfigError && e.problems.length === 1 && !e.message.includes('vendor.example'),
    );
  });
  test('bad release number and mode are named', () => {
    assert.throws(() => loadTelemetryConfig({ EHR_RELEASE_NUMBER: '0', EHR_TELEMETRY: 'maybe' }), (e: unknown) => e instanceof TelemetryConfigError && e.problems.length === 2);
  });
  test('resource attributes are all on the allowlist', () => {
    const r = resourceAttributes(loadTelemetryConfig({ EHR_TELEMETRY: 'on', EHR_RELEASE_NUMBER: '142', EHR_ENVIRONMENT: 'staging' }));
    for (const k of Object.keys(r)) assert.ok(ALLOWED_ATTRIBUTE_KEYS.has(k), k);
  });
  test('startTelemetry builds the SDK only when on', async () => {
    let built = 0;
    let started = 0;
    const make = (o: SdkOptions) => {
      built += 1;
      assert.equal(o.resource['service.name'], 'ehr-api');
      return { start: () => void (started += 1), shutdown: () => Promise.resolve() };
    };
    const off = startTelemetry({}, make);
    assert.equal(off.enabled, false);
    assert.equal(built, 0);
    const on = startTelemetry({ EHR_TELEMETRY: 'on' }, make);
    assert.equal(on.enabled, true);
    assert.deepEqual([built, started], [1, 1]);
    await on.shutdown();
  });
});
