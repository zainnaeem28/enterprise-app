import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkArchiveRecord, checkBootstrapRecord } from '../lib/record.mjs';
import { NOW, goodArchive, goodBootstrap } from './helpers.mjs';

const b = (o, env = 'staging') =>
  checkBootstrapRecord(JSON.stringify(goodBootstrap(o)), { environment: env, now: NOW });
const a = (o, partition = 'audit.event_2025_01') =>
  checkArchiveRecord(JSON.stringify(goodArchive(o)), { partition, now: NOW });
const has = (errs, re) =>
  assert.ok(
    errs.some((e) => re.test(e)),
    `${re} in ${JSON.stringify(errs)}`,
  );

test('a complete bootstrap record permits the run', () => assert.deepEqual(b({}), []));
test('wrong environment, empty state, malformed JSON are refused', () => {
  has(b({}, 'production'), /environment/);
  has(b({ state: 'empty' }), /not "approved"/);
  assert.match(
    checkBootstrapRecord('x', { environment: 'staging', now: NOW })[0],
    /not valid JSON/,
  );
});
test('one approval, a repeated approver, or none is not dual control', () => {
  has(b({ approvals: ['custodian-a'] }), /two distinct/);
  has(b({ approvals: ['custodian-a', 'custodian-a'] }), /two distinct/);
  has(b({ approvals: [] }), /two distinct/);
});
test('expired, not yet valid and over-long windows are refused', () => {
  has(b({ expires: '2026-06-01T11:00:00Z' }), /expired/);
  has(b({ not_before: '2026-06-01T13:00:00Z' }), /not valid before/);
  has(b({ expires: '2026-06-05T08:00:00Z' }), /exceeds one day/);
});
test('the action must be bootstrap', () =>
  has(b({ permitted_actions: ['restore-test'] }), /action "bootstrap"/));
test('two distinct custodians and two distinct enrollees are required', () => {
  const g = goodBootstrap();
  has(b({ custodians: [g.custodians[0]] }), /two named custodians/);
  has(
    b({ custodians: [g.custodians[0], g.custodians[0]] }),
    /distinct IAM Identity Center user IDs/,
  );
  has(b({ enrollees: [g.enrollees[0], g.enrollees[0]] }), /distinct handles/);
});
test('custodian i is never enrollee i (DPR-23); crossed custodians are allowed', () => {
  const g = goodBootstrap();
  const same = [{ ...g.enrollees[0], identity_center_user_id: 'u-1' }, g.enrollees[1]];
  has(b({ enrollees: same }), /custodian 1 is enrollee 1/);
  const crossed = [
    { ...g.enrollees[0], identity_center_user_id: 'u-2' },
    { ...g.enrollees[1], identity_center_user_id: 'u-1' },
  ];
  assert.deepEqual(b({ enrollees: crossed }), []);
});
test('the security-contact test must be recorded and at most 72 hours old', () => {
  has(b({ security_contact_verified_at: '2026-05-28T11:59:00Z' }), /older than 72 hours/);
  has(b({ security_contact_verified_at: undefined }), /security_contact_verified_at/);
  has(b({ security_contact_test_ref: '' }), /security_contact_test_ref/);
  has(b({ security_contact_verified_at: '2026-06-02T12:00:00Z' }), /future/);
});
test('an audit-archive record names exactly the dispatched partition and two approvals', () => {
  assert.deepEqual(a({}), []);
  has(a({ approvals: ['x'] }), /two distinct/);
  has(a({}, 'audit.event_2025_02'), /not the record's/);
  has(a({ permitted_actions: ['audit-archive'] }), /exactly one/);
  has(
    a({
      permitted_actions: [
        'audit-archive',
        'archive:audit.event_2025_01',
        'archive:audit.event_2025_02',
      ],
    }),
    /exactly one/,
  );
  has(a({ environment: 'staging' }), /environment/);
  has(a({}, 'audit.event_2025_13; drop'), /not audit.event_YYYY_MM/);
});
