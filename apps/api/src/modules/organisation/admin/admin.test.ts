// Unit tests of the admin request parsing and error translation (no database): strict bodies, If-Match, paging, the
// `patient_messaging` rule table and the mapping of domain and database failures to the standard error body.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiError } from '../../../platform/errors.js';
import {
  NeutralNameRequiredError,
  OrganisationValidationError,
  SettingNotConfiguredError,
} from '../errors.js';
import { FLAG_RULES } from './flag-rules.js';
import {
  asObject,
  cursorFor,
  etag,
  ifMatchVersion,
  parseFields,
  parsePage,
  parseValue,
} from './fields.js';
import type { FieldDef } from './fields.js';
import { translate } from './service.js';

const DEFS: FieldDef[] = [
  { n: 'name', c: 'name', k: 'text', req: true, max: 10 },
  { n: 'weekday', c: 'weekday', k: 'int', min: 0, max: 6 },
  { n: 'locationId', c: 'location_id', k: 'uuid', fixed: true, nullable: true },
  { n: 'kind', c: 'kind', k: 'enum', values: ['a', 'b'] },
];

const rejects = (
  fn: () => unknown,
): { status: number; errors: { path: string; code: string }[] } => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, 'kernel.validation_failed');
    return { status: e.status, errors: e.extras.errors ?? [] };
  }
  return assert.fail('expected a validation error');
};

describe('parseFields', () => {
  test('create needs the required fields and refuses unknown keys, naming the path and never the value', () => {
    const r = rejects(() => parseFields(DEFS, { weekday: 9, nope: 'secret-value' }, 'create'));
    assert.equal(r.status, 400);
    assert.deepEqual(r.errors.map((e) => `${e.path}:${e.code}`).sort(), [
      '/name:kernel.required',
      '/nope:kernel.unknown_field',
      '/weekday:kernel.invalid_format',
    ]);
    assert.ok(!JSON.stringify(r).includes('secret-value'));
  });
  test('patch refuses a fixed field, null for a non-nullable field, and trims text', () => {
    const r = rejects(() => parseFields(DEFS, { locationId: null, name: null }, 'patch'));
    assert.deepEqual(r.errors.map((e) => `${e.path}:${e.code}`).sort(), [
      '/locationId:kernel.immutable',
      '/name:kernel.invalid_format',
    ]);
    assert.deepEqual(parseFields(DEFS, { name: '  x  ' }, 'patch'), { name: 'x' });
    assert.deepEqual(parseFields(DEFS, { name: 'ok', locationId: null }, 'create'), {
      name: 'ok',
      locationId: null,
    });
  });
  test('value kinds', () => {
    const f = (k: FieldDef['k'], o: Partial<FieldDef> = {}): FieldDef => ({
      n: 'v',
      c: 'v',
      k,
      ...o,
    });
    assert.equal(parseValue(f('date'), '2027-02-31'), undefined);
    assert.equal(parseValue(f('date'), '2028-02-29'), '2028-02-29');
    assert.equal(parseValue(f('time'), '24:00'), undefined);
    assert.equal(parseValue(f('time'), '08:05'), '08:05');
    assert.equal(parseValue(f('ts'), '2030-01-01T10:00:00+02:00'), '2030-01-01T08:00:00.000Z');
    assert.equal(parseValue(f('ts'), 'tomorrow'), undefined);
    assert.equal(parseValue(f('tz'), 'Mars/Base'), undefined);
    assert.equal(parseValue(f('tz'), 'America/New_York'), 'America/New_York');
    assert.equal(parseValue(f('state'), 'ny'), undefined);
    assert.equal(parseValue(f('currency'), 'USD'), 'USD');
    assert.equal(parseValue(f('text'), 'a\u0000b'), undefined, 'control characters are refused');
    assert.equal(parseValue(f('json', { max: 10 }), { a: 'x'.repeat(20) }), undefined);
    assert.equal(parseValue(f('json'), [1]), undefined);
    assert.equal(parseValue(f('int'), 1.5), undefined);
    assert.equal(
      parseValue(f('uuid'), '00000000-0000-7000-8000-000000000001'),
      '00000000-0000-7000-8000-000000000001',
    );
    assert.equal(parseValue(f('uuid'), '00000000-0000-7000-8000-00000000000G'), undefined);
  });
  test('the body must be an object', () => {
    rejects(() => asObject(['x']));
    rejects(() => asObject(null));
  });
});

describe('If-Match and paging', () => {
  test('If-Match: absent is 428, unreadable is 412, weak and strong tags carry the version', () => {
    assert.throws(
      () => ifMatchVersion(undefined),
      (e: ApiError) => e.status === 428 && e.code === 'kernel.precondition_required',
    );
    assert.throws(
      () => ifMatchVersion('*'),
      (e: ApiError) => e.status === 412 && e.code === 'kernel.precondition_failed',
    );
    assert.equal(ifMatchVersion('W/"7"'), 7);
    assert.equal(ifMatchVersion('"12"'), 12);
    assert.equal(ifMatchVersion(etag(3)), 3);
  });
  test('limit is 1..100 (default 25) and the cursor must be one this API issued', () => {
    assert.deepEqual(parsePage({}), { limit: 25, offset: 0 });
    assert.deepEqual(parsePage({ limit: '100', cursor: cursorFor(75) }), {
      limit: 100,
      offset: 75,
    });
    for (const q of [
      { limit: '0' },
      { limit: '101' },
      { limit: 'x' },
      { cursor: 'AAAA' },
      { cursor: 5 },
      { cursor: 'x'.repeat(50) },
    ])
      rejects(() => parsePage(q));
  });
});

describe('flag rules and error translation', () => {
  test('patient_messaging may not be enabled in R1; other flags have no rule', () => {
    assert.equal(FLAG_RULES['patient_messaging']?.enabledAllowed, false);
    assert.equal(FLAG_RULES['self_check_in'], undefined);
  });
  test('domain and database failures become registry errors carrying codes only', () => {
    const n = translate(new NeutralNameRequiredError()) as ApiError;
    assert.deepEqual([n.status, n.code], [422, 'organisation.neutral_name_required']);
    const v = translate(new OrganisationValidationError(['value'])) as ApiError;
    assert.deepEqual(
      [v.status, v.code, v.extras.errors],
      [400, 'kernel.validation_failed', [{ path: '/value', code: 'kernel.invalid_format' }]],
    );
    const s = translate(new SettingNotConfiguredError('hold_minutes')) as ApiError;
    assert.deepEqual([s.status, s.code, s.retryable], [503, 'kernel.unavailable', true]);
    const fk = translate(
      Object.assign(
        new Error('insert or update on table "room" violates foreign key (secret detail)'),
        { code: '23503', constraint: 'room_location_id_fkey' },
      ),
    ) as ApiError;
    assert.deepEqual(fk.extras.errors, [{ path: '/locationId', code: 'kernel.unknown_reference' }]);
    const dup = translate(
      Object.assign(new Error('dup'), { code: '23505', constraint: 'room_location_name_uq' }),
    ) as ApiError;
    assert.deepEqual(dup.extras.errors, [{ path: '/', code: 'kernel.duplicate' }]);
    assert.ok(!JSON.stringify(fk).includes('secret detail'));
    const other = new Error('boom');
    assert.equal(translate(other), other, 'anything else is left to the platform filter');
    const api = new ApiError(404, 'kernel.not_found');
    assert.equal(translate(api), api);
  });
});
