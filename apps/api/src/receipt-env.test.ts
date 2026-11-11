import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError } from '@ehr/kernel';
import { loadReceiptEnv } from './receipt-env.js';

const ARN = 'arn:aws:sns:eu-west-2:123456789012:ehr-ses-events';
const ARN2 = 'arn:aws:sns:eu-west-2:123456789012:ehr-sms-events';
const GOOD = {
  EHR_SNS_RECEIPT_REGION: 'eu-west-2',
  EHR_SNS_RECEIPT_TOPICS: `${ARN}=email, ${ARN2}=sms`,
};

test('no variable set: the route is not configured', () => {
  assert.equal(loadReceiptEnv({}), undefined);
});

test('a complete set parses to the topic map', () => {
  const p = loadReceiptEnv({ ...GOOD, EHR_SNS_RECEIPT_MAX_AGE_SECONDS: '600' });
  assert.equal(p?.region, 'eu-west-2');
  assert.deepEqual(
    [...(p?.topics ?? [])],
    [
      [ARN, 'email'],
      [ARN2, 'sms'],
    ],
  );
  assert.equal(p?.maxAgeSeconds, 600);
});

test('a partial or bad set stops the start with the variable name', () => {
  const bad: Record<string, string>[] = [
    { EHR_SNS_RECEIPT_REGION: 'eu-west-2' },
    { EHR_SNS_RECEIPT_TOPICS: `${ARN}=email` },
    { ...GOOD, EHR_SNS_RECEIPT_REGION: 'nowhere' },
    { ...GOOD, EHR_SNS_RECEIPT_TOPICS: `${ARN}=fax` },
    { ...GOOD, EHR_SNS_RECEIPT_TOPICS: `${ARN}=email,${ARN}=sms` },
    { ...GOOD, EHR_SNS_RECEIPT_TOPICS: 'arn:aws:sns:x=email' },
    { ...GOOD, EHR_SNS_TRUST_ANCHORS_PEM: 'not a pem' },
    { ...GOOD, EHR_SNS_RECEIPT_MAX_AGE_SECONDS: '5' },
  ];
  for (const env of bad)
    assert.throws(
      () => loadReceiptEnv(env),
      (e: unknown) => e instanceof ConfigError && /EHR_SNS_/.test(e.problems.join(' ')),
      JSON.stringify(env),
    );
});
