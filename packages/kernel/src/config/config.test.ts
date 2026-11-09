import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, describeDatabase, loadConfig } from './config.js';

const ok = {
  EHR_ENV: 'ci',
  EHR_DEPLOYABLE: 'api',
  EHR_DATABASE_URL: 'postgres://app_api:s3cret@db.internal:5432/ehr',
};

test('valid configuration with defaults', () => {
  const c = loadConfig(ok);
  assert.deepEqual(
    [c.queueSchema, c.logLevel, c.poolMax, c.organisationId],
    ['queue', 'info', 10, undefined],
  );
});

test('the worker requires the organisation for dequeue scope', () => {
  assert.throws(
    () => loadConfig({ ...ok, EHR_DEPLOYABLE: 'worker' }),
    /EHR_ORGANISATION_ID is required/,
  );
  const c = loadConfig({
    ...ok,
    EHR_DEPLOYABLE: 'worker',
    EHR_ORGANISATION_ID: '0192e0a0-0000-7000-8000-000000000001',
  });
  assert.equal(c.deployable, 'worker');
});

test('errors name variables, never values', () => {
  try {
    loadConfig({
      EHR_ENV: 'prod-secret-value',
      EHR_DEPLOYABLE: 'api',
      EHR_DATABASE_URL: 'mysql://u:hunter2@h/x',
      EHR_POOL_MAX: '0',
    });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.equal(e.problems.length, 3);
    assert.ok(!e.message.includes('hunter2') && !e.message.includes('prod-secret-value'));
  }
});

test('describeDatabase drops credentials', () => {
  assert.equal(describeDatabase(loadConfig(ok)), 'postgres://db.internal:5432/ehr');
});
