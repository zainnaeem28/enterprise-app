// The worker's mirror of the privacy job types (apps/api/src/modules/privacy/jobs.ts keeps the same list; the API's database test pins
// it from its side). No database needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobRegistry } from '@ehr/kernel';
import { PRIVACY_CRONTAB, PRIVACY_JOBS } from './jobs.js';
import { definePrivacyJobs } from './index.js';

test('privacy job types: names, merge policy and scope', () => {
  assert.deepEqual(
    PRIVACY_JOBS.map((j) => [j.name, j.onMerged, j.jobScope, j.carriesPatientIds]),
    [
      ['privacy.assemble_export', 'resolve', 'patients', true],
      ['privacy.check_legal_holds', 'resolve', 'patients', true],
      ['privacy.expire_packages', 'none', 'org', false],
    ],
  );
  assert.equal(PRIVACY_CRONTAB, '50 3 * * * privacy.expire_packages');
});

test('every job that carries patient IDs declares on_merged, and the types register', () => {
  for (const j of PRIVACY_JOBS) if (j.carriesPatientIds) assert.equal(j.onMerged, 'resolve');
  const reg = new JobRegistry();
  definePrivacyJobs(reg);
  assert.equal(reg.list().length, 3);
  // The API tier may enqueue the two patient jobs; the daily expiry is a system job it can never enqueue.
  const byName = Object.fromEntries(reg.list().map((x) => [x.name, x.apiEnqueue]));
  assert.deepEqual(byName, {
    'privacy.assemble_export': true,
    'privacy.check_legal_holds': true,
    'privacy.expire_packages': false,
  });
});
