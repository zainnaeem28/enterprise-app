// TC-CL-08b / RA-R1-24 / QA661-F01: through the REAL production composition (`buildComposition` -> `createApp`) the chart summary carries
// the encounter history and the documents list as arrays, never `null` for a caller with chart access. Real database; synthetic data only.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/test/chart-summary.dbtest.js
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createLogger } from '@ehr/kernel';
import { buildComposition } from '../src/composition.js';
import { loadIdentityEnv } from '../src/identity-env.js';
import {
  call,
  CSRF_KEY,
  id,
  ORG,
  PATIENT_HOST,
  registerViaApi,
  saWrite,
  setup,
  standardFixtures,
  staffMember,
  STAFF_HOST,
} from '../src/modules/patient/testkit.js';
import type { Kit } from '../src/modules/patient/testkit.js';
import { createApp } from '../src/platform/app.js';

const A1 = id(101);
const K = 'd'.repeat(48);
let k: Kit;
let app: Awaited<ReturnType<typeof createApp>>;
let base = '';

before(async () => {
  k = await setup({ name: 'chartsum', fixtures: standardFixtures });
  const dead = 'https://idp.invalid';
  const env = loadIdentityEnv({
    EHR_ORGANISATION_ID: ORG,
    EHR_STAFF_HOST: STAFF_HOST,
    EHR_PATIENT_HOST: PATIENT_HOST,
    EHR_ALLOWED_ORIGINS: `https://${STAFF_HOST},https://${PATIENT_HOST}`,
    EHR_OIDC_STATE_KEY: K,
    EHR_CSRF_KEY: CSRF_KEY,
    EHR_RATE_KEY: K + '2',
    EHR_MATCH_CHECK_KEY: K + '3',
    EHR_CHECKIN_QR_KEY: K + '4',
    EHR_STAFF_OIDC_ISSUER: dead,
    EHR_STAFF_OIDC_AUTHORIZATION_ENDPOINT: `${dead}/a`,
    EHR_STAFF_OIDC_TOKEN_ENDPOINT: `${dead}/t`,
    EHR_STAFF_OIDC_JWKS_URI: `${dead}/k`,
    EHR_STAFF_OIDC_CLIENT_ID: 'x',
    EHR_STAFF_OIDC_CLIENT_SECRET: 'x'.repeat(24),
    EHR_STAFF_OIDC_REDIRECT_URI: `https://${STAFF_HOST}/api/v1/auth/callback`,
    EHR_STAFF_WORKSPACE_DOMAIN: 'example.com',
    EHR_PATIENT_OIDC_ISSUER: dead,
    EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT: `${dead}/a`,
    EHR_PATIENT_OIDC_TOKEN_ENDPOINT: `${dead}/t`,
    EHR_PATIENT_OIDC_JWKS_URI: `${dead}/k`,
    EHR_PATIENT_OIDC_CLIENT_ID: 'x',
    EHR_PATIENT_OIDC_REDIRECT_URI: `https://${PATIENT_HOST}/api/v1/auth/callback`,
  });
  const c = buildComposition({
    db: k.db,
    logger: createLogger({ sink: () => undefined }),
    identity: env,
  });
  app = await createApp({
    config: {
      minClientRelease: 141,
      instanceCount: 1,
      integrationsHost: undefined,
      port: 0,
      requestTimeoutMs: 15_000,
    },
    logger: createLogger({ sink: () => undefined }),
    readiness: { missingRelations: () => Promise.resolve([]) },
    policy: c.policy,
    controllers: c.controllers,
  });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});
after(async () => {
  await app?.close();
  await k?.close();
});

describe('chart summary history and documents in the production composition', () => {
  test('encounters and documents are arrays (empty, then filled), not null', async () => {
    const desk = await staffMember(k, 'front_desk', A1, 'Desk A1');
    const doctor = await staffMember(k, 'doctor', A1, 'Doctor A1');
    const pid = await registerViaApi(k, desk, A1, {
      givenName: 'Summary',
      familyName: 'Lists',
      dateOfBirth: '1980-05-17',
      phone: '+12125551701',
      email: 'summary.lists@example.test',
    });
    await saWrite(
      k,
      `INSERT INTO patient.care_team_member (id, organisation_id, patient_id, principal_id, role) VALUES (gen_random_uuid(), $1, $2, $3, 'clinician')`,
      [ORG, pid, doctor.seeded.principalId],
    );
    const get = (): ReturnType<typeof call> =>
      call(base, 'GET', `/api/v1/patients/${pid}/chart-summary`, {
        host: STAFF_HOST,
        cookie: doctor.cookie,
      });
    const empty = await get();
    assert.equal(empty.status, 200, empty.body);
    assert.deepEqual(empty.json()['encounters'], []);
    assert.deepEqual(empty.json()['documents'], []);

    await saWrite(
      k,
      `INSERT INTO clinical.encounter (id, organisation_id, patient_id, location_id, clinician_principal_id, mode, status, started_at, created_by)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'in_person', 'in_consultation', now(), $4)`,
      [ORG, pid, A1, doctor.seeded.principalId],
    );
    const filled = await get();
    assert.equal(filled.status, 200, filled.body);
    const enc = filled.json()['encounters'] as Record<string, unknown>[];
    assert.equal(enc.length, 1);
    assert.equal(enc[0]?.['patientId'], pid);
    assert.deepEqual(filled.json()['documents'], []);
  });
});
