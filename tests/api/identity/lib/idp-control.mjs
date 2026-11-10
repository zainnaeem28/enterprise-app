// QA-03 variant of the QA-05 fixture IdP control (ENV-INT/ci). Same LocalIdp (the identity slice's conformance IdP); the control
// port additionally lets a test choose the claims of the NEXT sign-in that the real callback has to refuse or accept:
//   GET <port+1>/next?sub=&email=[&hd=<domain>|none][&ev=true|false][&auth_time=<unix seconds>|none][&groups=a,b][&defect=<LocalIdp defect>]
// usage: node idp-control.mjs <kind staff|patient> <port> <repoRoot>
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const [kind, portArg, root] = process.argv.slice(2);
const port = Number(portArg);
const { LocalIdp } = await import(pathToFileURL(`${root}/apps/api/dist/src/modules/identity/idp.fixture.js`).href);
const idp = new LocalIdp();
const claims = (q) => {
  const c = { sub: q.get('sub'), email: q.get('email'), email_verified: q.get('ev') === null ? true : q.get('ev') === 'true' };
  if (kind === 'staff') {
    const hd = q.get('hd') ?? 'example.com';
    if (hd !== 'none') c.hd = hd;
  }
  if (q.get('groups') !== null) c.extra = { groups: q.get('groups').split(',') };
  if (q.get('defect') !== null) c.defect = q.get('defect');
  const at = q.get('auth_time');
  if (at !== null && at !== 'none') c.auth_time = Number(at);
  return c;
};
idp.nextLogin = claims(new URLSearchParams({ sub: 'sub-none', email: 'none@example.com' }));
await idp.start(port);
createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  idp.nextLogin = claims(u.searchParams);
  res.end('ok');
}).listen(port + 1, '127.0.0.1');
process.stdout.write(`${JSON.stringify({ ...idp.endpoints, clientId: idp.clientId })}\n`);
process.once('SIGTERM', () => void idp.stop().then(() => process.exit(0)));
