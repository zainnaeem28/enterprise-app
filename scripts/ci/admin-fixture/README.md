# Admin WebAuthn CI fixture (INT04-F21)

Purpose: let headless Chromium complete the real admin-realm enrolment and sign-in against the real API, database and built staff app, so admin configuration, audit viewer and break-the-glass can be run end to end and screenshotted.

## Trust design

- The API is **unchanged**: it still verifies packed attestation with the exact-pinned `@simplewebauthn/server` in `chain` mode against `EHR_ADMIN_ATTESTATION_ROOTS_PEM`, and checks `EHR_ADMIN_ALLOWED_AAGUIDS`. No default, no test mode, no allow-list change.
- A **fresh synthetic root + leaf is created per run, in memory** (`apps/api/src/ci-fixture/attestation-ca.ts`). Only the public root certificate and the fixture AAGUID go into the API environment. The leaf key signs attestations inside the driver process; no private key is written to disk, logged, put in an environment variable or uploaded. The root key is discarded right after the leaf is signed.
- **Inert unless enabled, rejected elsewhere.** `loadAdminEnv` (`apps/api/src/admin-env.ts`) stops the API start if it sees a fixture root (subject CN `EHR CI FIXTURE ROOT - NOT FOR PRODUCTION`) or the fixture AAGUID unless `EHR_ENV=ci` **and** `EHR_ADMIN_CI_FIXTURE=1`. The driver (`index.mjs`) also refuses unless `CI=true` and `EHR_ADMIN_CI_FIXTURE=1`. Tests: `apps/api/src/admin-env.test.ts` (production, staging, dev, unset, ci without the flag, flag without ci, root hidden among others), `apps/api/src/ci-fixture/attestation-ca.test.ts` (the production verifier accepts the fixture chain only with this run's root; self-attestation is still refused in chain mode).
- Deployment config (`infra/`, deploy workflows) never sets `EHR_ADMIN_CI_FIXTURE`; do not add it there.

## Use from a CI browser driver

```js
import { createAdminFixture } from './scripts/ci/admin-fixture/index.mjs';
const fx = createAdminFixture(); // CI=true EHR_ADMIN_CI_FIXTURE=1
// start the API with { ...baseEnv, ...fx.adminFixtureEnv() }, EHR_STAFF_HOST/EHR_ALLOWED_ORIGINS = the staff origin
await fx.installAuthenticator(context, { origin: STAFF_ORIGIN, rpId: STAFF_HOST });
// the staff UI's navigator.credentials.get now signs with a key enrolled through fx (UI enrolment or fx.createKeyAttestation over HTTP)
```

Browser-half self-test without a database: `CI=true EHR_ADMIN_CI_FIXTURE=1 node scripts/ci/admin-fixture/selftest.mjs`.
