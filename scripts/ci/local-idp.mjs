// CI fixture IdP: the identity module's local OIDC conformance IdP as a separate process, so the REAL API process (`main.js`) can be
// configured against it through EHR_STAFF_OIDC_* / EHR_PATIENT_OIDC_* (no test-only composition). Build first (`pnpm build`).
//   node scripts/ci/local-idp.mjs [port=9099] [sub=sub-ci-patient] [email=patient@example.org]
// It prints the endpoint URLs as JSON on stdout and signs in whoever opens /authorize as the given identity. Synthetic, no credentials.
import { LocalIdp } from '../../apps/api/dist/src/modules/identity/idp.fixture.js';

const port = Number(process.argv[2] ?? 9099);
const idp = new LocalIdp();
idp.nextLogin = {
  sub: process.argv[3] ?? 'sub-ci-patient',
  email: process.argv[4] ?? 'patient@example.org',
  email_verified: true,
};
await idp.start(port);
process.stdout.write(`${JSON.stringify({ ...idp.endpoints, clientId: idp.clientId })}\n`);
process.once('SIGTERM', () => void idp.stop().then(() => process.exit(0)));
process.once('SIGINT', () => void idp.stop().then(() => process.exit(0)));
