import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from './logger.js';

function capture(): { lines: string[]; log: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  return {
    lines,
    log: createLogger({ sink: (l) => lines.push(l), level: 'debug', now: () => new Date(0) }),
  };
}

const CANARY = 'CANARY-PHI-7f3a-JaneDoe';

test('synthetic-PHI canary never appears in any output shape', () => {
  const { lines, log } = capture();
  const err = Object.assign(new Error(`failed for ${CANARY}`), { code: 'PM001', detail: CANARY });
  log.info(`handling ${CANARY}`, {
    patientName: CANARY,
    nested: {
      dob: '1980-02-29',
      ssn: '123-45-6789',
      list: [CANARY, { email: `${CANARY}@example.com` }],
    },
    err,
    requestId: `req-${CANARY}`,
    route: `/patients/${CANARY}`,
    note: `call me on +1 415 555 0100 or jane@example.com`,
  });
  log.child({ patientEmail: 'jane@example.com' }).error('boom', { cause: err });
  const all = lines.join('\n');
  for (const needle of [
    'CANARY',
    'Jane',
    '1980-02-29',
    '123-45-6789',
    'jane@example.com',
    '555 0100',
  ]) {
    assert.ok(!all.includes(needle), `${needle} leaked: ${all}`);
  }
});

test('operational fields survive', () => {
  const { lines, log } = capture();
  log.warn('slow request', {
    requestId: '0192abc',
    status: 504,
    durationMs: 15012,
    route: '/appointments/{id}/confirm',
  });
  const rec = JSON.parse(lines[0]!);
  assert.deepEqual(
    [rec.level, rec.requestId, rec.status, rec.durationMs, rec.route],
    ['warn', '0192abc', 504, 15012, '/appointments/{id}/confirm'],
  );
});

test('level filter, and callers cannot overwrite level/time/msg', () => {
  const { lines, log } = capture();
  const quiet = createLogger({ sink: (l) => lines.push(l), level: 'error' });
  quiet.info('x');
  assert.equal(lines.length, 0);
  log.info('real', { level: 'fake', msg: 'fake', time: 'fake' });
  const rec = JSON.parse(lines[0]!);
  assert.deepEqual([rec.level, rec.msg, rec.time], ['info', 'real', '1970-01-01T00:00:00.000Z']);
});

test('bearer tokens and JWTs are scrubbed from messages', () => {
  const { lines, log } = capture();
  log.info('auth Bearer abc.def-123 and eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4');
  assert.ok(!/abc\.def|eyJhb/.test(lines[0]!));
});
