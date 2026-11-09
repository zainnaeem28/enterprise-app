import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConfigError } from '@ehr/kernel';
import { loadAdminEnv } from './admin-env.js';

const IDENT = { rateKey: 'r'.repeat(40), csrfKey: 'c'.repeat(40) };
// Syntactically a PEM block; the loader does not parse the certificate (the WebAuthn library does, at the first attestation).
export const PEM =
  '-----BEGIN CERTIFICATE-----\nQUJDREVGR0hJSktMTU5PUA==\n-----END CERTIFICATE-----';
const ok = {
  EHR_ADMIN_ATTESTATION_ROOTS_PEM: `${PEM}\n${PEM}`,
  EHR_ADMIN_ALLOWED_AAGUIDS:
    '2FC0579F-8113-47EA-B116-BB5A8DB9202A, ee882879-721c-4913-9775-3dfcce97072a',
  EHR_ADMIN_DECOY_KEY: 'd'.repeat(40),
};
const problems = (env: Record<string, string>): string[] => {
  try {
    loadAdminEnv(env, IDENT);
  } catch (e) {
    if (e instanceof ConfigError) return [...e.problems];
    throw e;
  }
  return [];
};

describe('admin realm configuration is fail-closed (INT04-F01, SEC02-F01)', () => {
  test('a complete configuration is accepted; AAGUIDs are lower-cased and roots split', () => {
    const c = loadAdminEnv(ok, IDENT);
    assert.equal(c.attestationRootsPem.length, 2);
    assert.deepEqual(c.allowedAaguids, [
      '2fc0579f-8113-47ea-b116-bb5a8db9202a',
      'ee882879-721c-4913-9775-3dfcce97072a',
    ]);
    assert.equal(c.rpName, 'EHR admin');
  });
  test('an empty environment names every missing variable and starts nothing', () => {
    assert.deepEqual(problems({}), [
      'EHR_ADMIN_ATTESTATION_ROOTS_PEM is required',
      'EHR_ADMIN_ALLOWED_AAGUIDS is required',
      'EHR_ADMIN_DECOY_KEY is required',
    ]);
  });
  for (const name of Object.keys(ok))
    test(`${name} missing is refused by name`, () => {
      const env: Record<string, string> = { ...ok };
      delete env[name];
      assert.deepEqual(problems(env), [`${name} is required`]);
    });
  test('roots that are not PEM certificates are refused (no value in the message)', () => {
    const p = problems({ ...ok, EHR_ADMIN_ATTESTATION_ROOTS_PEM: 'not a certificate' });
    assert.deepEqual(p, ['EHR_ADMIN_ATTESTATION_ROOTS_PEM must hold at least one PEM certificate']);
    assert.deepEqual(problems({ ...ok, EHR_ADMIN_ATTESTATION_ROOTS_PEM: `${PEM}\njunk` }), [
      'EHR_ADMIN_ATTESTATION_ROOTS_PEM must hold only PEM certificates',
    ]);
  });
  test('malformed and all-zero AAGUIDs are refused', () => {
    for (const a of ['nope', '00000000-0000-0000-0000-000000000000', `${'1'.repeat(8)}-bad`])
      assert.deepEqual(problems({ ...ok, EHR_ADMIN_ALLOWED_AAGUIDS: a }), [
        'EHR_ADMIN_ALLOWED_AAGUIDS must be a list of non-zero AAGUIDs',
      ]);
  });
  test('the decoy key is long and distinct from the rate and CSRF keys', () => {
    assert.deepEqual(problems({ ...ok, EHR_ADMIN_DECOY_KEY: 'short' }), [
      'EHR_ADMIN_DECOY_KEY must be at least 32 characters',
    ]);
    assert.deepEqual(problems({ ...ok, EHR_ADMIN_DECOY_KEY: IDENT.rateKey }), [
      'EHR_ADMIN_DECOY_KEY must differ from EHR_RATE_KEY and EHR_CSRF_KEY',
    ]);
  });
});
