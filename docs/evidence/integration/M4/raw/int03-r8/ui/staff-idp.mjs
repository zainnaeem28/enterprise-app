// Fixture staff IdP: like scripts/ci/local-idp.mjs but the ID token carries hd=example.com (the staff realm refuses a token without `hd`).
import { LocalIdp } from '../../../../../../../apps/api/dist/src/modules/identity/idp.fixture.js';
const port = Number(process.argv[2]);
const idp = new LocalIdp();
idp.nextLogin = { sub: process.argv[3], email: process.argv[4], email_verified: true, hd: 'example.com' };
await idp.start(port);
process.stdout.write(`${JSON.stringify({ ...idp.endpoints, clientId: idp.clientId })}\n`);
process.once('SIGTERM', () => void idp.stop().then(() => process.exit(0)));
