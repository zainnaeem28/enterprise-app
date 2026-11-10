// QA fixture IdPs for the journeys (ENV-INT/ci): one staff and one patient LocalIdp (the identity slice's own conformance IdP)
// with a loopback control port, so one process can sign in any seeded persona. POST <port+1>/next?sub=&email= selects who the
// NEXT sign-in is. usage: node idp-control.mjs <kind staff|patient> <port> <repoRoot>
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const [kind, portArg, root] = process.argv.slice(2);
const port = Number(portArg);
const { LocalIdp } = await import(
  pathToFileURL(`${root}/apps/api/dist/src/modules/identity/idp.fixture.js`).href
);
const idp = new LocalIdp();
const claims = (sub, email) =>
  kind === 'staff'
    ? { sub, email, email_verified: true, hd: 'example.com' }
    : { sub, email, email_verified: true };
idp.nextLogin = claims('sub-none', 'none@example.com');
await idp.start(port);
createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  idp.nextLogin = claims(u.searchParams.get('sub'), u.searchParams.get('email'));
  res.end('ok');
}).listen(port + 1, '127.0.0.1');
process.stdout.write(`${JSON.stringify({ ...idp.endpoints, clientId: idp.clientId })}\n`);
process.once('SIGTERM', () => void idp.stop().then(() => process.exit(0)));
