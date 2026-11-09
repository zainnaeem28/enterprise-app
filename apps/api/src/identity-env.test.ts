import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConfigError } from '@ehr/kernel';
import { loadIdentityEnv } from './identity-env.js';

const K = 'k'.repeat(40);
const base = (over: Record<string, string>): Record<string, string> => ({
  EHR_ORGANISATION_ID: '00000000-0000-7000-8000-0000000000a1',
  EHR_STAFF_HOST: 'staff.example.test',
  EHR_PATIENT_HOST: 'my.example.test',
  EHR_ALLOWED_ORIGINS: 'https://staff.example.test,https://my.example.test',
  EHR_OIDC_STATE_KEY: K,
  EHR_CSRF_KEY: K,
  EHR_RATE_KEY: K,
  EHR_MATCH_CHECK_KEY: K,
  EHR_CHECKIN_QR_KEY: K,
  EHR_STAFF_OIDC_CLIENT_ID: 'c',
  EHR_STAFF_OIDC_CLIENT_SECRET: 's',
  EHR_STAFF_OIDC_REDIRECT_URI: 'https://staff.example.test/cb',
  EHR_STAFF_WORKSPACE_DOMAIN: 'example.com',
  EHR_PATIENT_OIDC_ISSUER: 'https://idp.example.test',
  EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT: 'https://idp.example.test/a',
  EHR_PATIENT_OIDC_TOKEN_ENDPOINT: 'https://idp.example.test/t',
  EHR_PATIENT_OIDC_JWKS_URI: 'https://idp.example.test/j',
  EHR_PATIENT_OIDC_CLIENT_ID: 'c',
  EHR_PATIENT_OIDC_REDIRECT_URI: 'https://my.example.test/cb',
  ...over,
});

describe('host variables (INT02-R7-N1)', () => {
  test('bare host names are accepted', () => {
    assert.equal(loadIdentityEnv(base({})).patientHost, 'my.example.test');
  });
  for (const patient of ['staff.example.test', 'STAFF.example.test'])
    test(`equal staff and patient hosts are refused (${patient})`, () => {
      assert.throws(
        () => loadIdentityEnv(base({ EHR_PATIENT_HOST: patient })),
        (e: unknown) =>
          e instanceof ConfigError &&
          e.problems.includes('EHR_STAFF_HOST and EHR_PATIENT_HOST must differ'),
      );
    });
  for (const name of ['EHR_STAFF_HOST', 'EHR_PATIENT_HOST'])
    test(`${name} with a port is refused by name (hostOf strips the port, so it could never match)`, () => {
      assert.throws(
        () => loadIdentityEnv(base({ [name]: '127.0.0.1:4174' })),
        (e: unknown) =>
          e instanceof ConfigError &&
          e.problems.some((p) => p.startsWith(`${name} must be a host name`)),
      );
    });
});
