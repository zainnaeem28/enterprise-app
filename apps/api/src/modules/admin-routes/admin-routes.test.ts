// No-database tests of the BE-24 request parsing and error translation.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiError } from '../../platform/errors.js';
import { AuditEnvelopeError, ExportTooLargeError, SelfReviewError } from '../audit/index.js';
import { SelfApprovalError } from '../integration-core/index.js';
import { cursorFor, exactBody, ifMatchVersion, parsePage, reqInstant, translate } from './http.js';

const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as ApiError).code;
  }
  return 'none';
};

describe('request parsing', () => {
  test('a body is an exact object', () => {
    assert.equal(
      code(() => exactBody(null, ['a'])),
      'kernel.validation_failed',
    );
    assert.equal(
      code(() => exactBody([], ['a'])),
      'kernel.validation_failed',
    );
    assert.equal(
      code(() => exactBody({ b: 1 }, ['a'])),
      'kernel.validation_failed',
    );
    assert.deepEqual(exactBody({ a: 1 }, ['a']), { a: 1 });
  });
  test('instants need an offset', () => {
    assert.equal(
      reqInstant({ t: '2026-11-09T10:00:00Z' }, 't').toISOString(),
      '2026-11-09T10:00:00.000Z',
    );
    assert.equal(
      code(() => reqInstant({ t: '2026-11-09' }, 't')),
      'kernel.validation_failed',
    );
    assert.equal(
      code(() => reqInstant({}, 't')),
      'kernel.validation_failed',
    );
  });
  test('If-Match and paging', () => {
    assert.equal(ifMatchVersion('W/"4"'), 4);
    assert.equal(
      code(() => ifMatchVersion(undefined)),
      'kernel.precondition_required',
    );
    assert.equal(
      code(() => ifMatchVersion('x')),
      'kernel.precondition_failed',
    );
    assert.deepEqual(parsePage({}), { limit: 25, offset: 0 });
    assert.deepEqual(parsePage({ limit: '5', cursor: cursorFor(10) }), { limit: 5, offset: 10 });
    assert.equal(
      code(() => parsePage({ limit: '101' })),
      'kernel.validation_failed',
    );
    assert.equal(
      code(() => parsePage({ cursor: 'zz' })),
      'kernel.validation_failed',
    );
  });
});

describe('error translation carries codes only', () => {
  test('domain errors keep their registry code and status', () => {
    const t = (e: unknown): ApiError => translate(e) as ApiError;
    assert.deepEqual(
      [t(new ExportTooLargeError()).status, t(new ExportTooLargeError()).code],
      [422, 'audit.export_too_large'],
    );
    assert.equal(t(new SelfReviewError()).code, 'audit.self_review');
    assert.equal(t(new SelfApprovalError()).status, 403);
    const v = t(new AuditEnvelopeError(['reason']));
    assert.equal(v.status, 400);
    assert.deepEqual(v.extras.errors, [{ path: '/reason', code: 'kernel.invalid_format' }]);
    const boom = new Error('SECRET-TEST-1 driver text');
    assert.equal(
      translate(boom),
      boom,
      'unknown errors are left to the platform, which answers kernel.internal',
    );
  });
});
