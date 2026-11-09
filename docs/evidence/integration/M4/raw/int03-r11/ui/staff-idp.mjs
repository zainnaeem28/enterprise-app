// Fixture staff IdP with a control port: POST http://127.0.0.1:<port+1>/next?sub=..&email=.. switches who the NEXT sign-in is (hd=example.com is always set).
import { LocalIdp } from '../../../../../../../apps/api/dist/src/modules/identity/idp.fixture.js';
import { createServer } from 'node:http';
const port = Number(process.argv[2]);
const idp = new LocalIdp();
idp.nextLogin = { sub: process.argv[3], email: process.argv[4], email_verified: true, hd: 'example.com' };
await idp.start(port);
createServer((req, res) => { const u = new URL(req.url, 'http://x'); idp.nextLogin = { sub: u.searchParams.get('sub'), email: u.searchParams.get('email'), email_verified: true, hd: 'example.com' }; res.end('ok'); }).listen(port + 1, '127.0.0.1');
process.stdout.write(`${JSON.stringify({ ...idp.endpoints, clientId: idp.clientId })}\n`);
process.once('SIGTERM', () => void idp.stop().then(() => process.exit(0)));
