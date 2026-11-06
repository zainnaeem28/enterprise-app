import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CALENDAR_SYNC_JOBS, CALENDAR_SYNC_CRONTAB } from './jobs.js';
import { channelToken, CHANNEL_LIFETIME_MS } from './watch.js';
import { parsePush } from './push-handler.js';

const body = (o: unknown): Buffer => Buffer.from(JSON.stringify(o));

test('the push payload must be exactly {channelId, resourceId, resourceState}: anything else is ignored (DF-3)', () => {
  assert.deepEqual(
    parsePush(body({ channelId: 'c-1', resourceId: 'r_1', resourceState: 'exists' })),
    { channelId: 'c-1', resourceId: 'r_1', state: 'exists' },
  );
  assert.ok(parsePush(body({ channelId: 'c', resourceId: 'r', resourceState: 'not_exists' })));
  assert.ok(parsePush(body({ channelId: 'c', resourceId: 'r', resourceState: 'sync' })));
  for (const bad of [
    Buffer.alloc(0),
    Buffer.from('not json'),
    Buffer.from('[]'),
    Buffer.from('null'),
    body({}),
    body({ channelId: 'c', resourceId: 'r' }),
    body({ channelId: 'c', resourceId: 'r', resourceState: 'bogus' }),
    body({ channelId: 'c', resourceId: 'r', resourceState: 'exists', extra: 1 }),
    body({ channelId: 'has space', resourceId: 'r', resourceState: 'exists' }),
    body({ channelId: 'c', resourceId: 'r'.repeat(256), resourceState: 'exists' }),
    body({ channelId: 7, resourceId: 'r', resourceState: 'exists' }),
    Buffer.alloc(2048, 65),
  ])
    assert.equal(parsePush(bad), undefined);
});

test("the channel token format of 29.5, under the 256-character limit, with a lifetime inside the verifier's 7-day ceiling", () => {
  const key = { version: 'k2', key: Buffer.from('0123456789abcdef0123456789abcdef') };
  const t = channelToken(key, '0192abcd-1234-4abc-8def-0123456789ab', 1_900_000_000);
  assert.match(t, /^v\.k2\.1900000000\.[A-Za-z0-9_-]{43}$/);
  assert.ok(t.length < 256);
  assert.equal(t, channelToken(key, '0192abcd-1234-4abc-8def-0123456789ab', 1_900_000_000));
  assert.notEqual(t, channelToken(key, 'other', 1_900_000_000));
  assert.notEqual(t, channelToken(key, '0192abcd-1234-4abc-8def-0123456789ab', 1_900_000_001));
  assert.notEqual(
    t,
    channelToken(
      { ...key, key: Buffer.from('another-key-another-key-another-k') },
      '0192abcd-1234-4abc-8def-0123456789ab',
      1_900_000_000,
    ),
  );
  assert.ok(CHANNEL_LIFETIME_MS < 7 * 24 * 3_600_000);
});

test('job types: patient-carrying handlers declare on_merged; everything else is organisation scope with no patient ID', () => {
  for (const j of CALENDAR_SYNC_JOBS) {
    if (j.carriesPatientIds) assert.equal(j.onMerged, 'resolve', j.name);
    else assert.equal(j.onMerged, 'none', j.name);
    assert.equal(j.jobScope, j.carriesPatientIds ? 'patients' : 'org', j.name);
    assert.ok(j.maxAttempts >= 5 && j.maxAttempts <= 8);
  }
  assert.equal(
    CALENDAR_SYNC_JOBS.find((j) => j.name === 'calendar_sync.full_resync')?.maxAttempts,
    8,
    '33.1 vendor-job policy: 8 attempts',
  );
  assert.equal(CALENDAR_SYNC_CRONTAB.split('\n').length, 2);
});
