// INT-01 auth-slice journey on the combined candidate: browser -> same-origin proxy -> API -> local OIDC conformance IdP
// -> session -> scoped read (GET /api/v1/auth/session) -> audit event. Synthetic data, throwaway database.
// Usage: node journey.mjs <repoRoot> <outDir>   (needs EHR_TEST_ADMIN_URL, built workspace, playwright chromium)
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const kit = await import(pathToFileURL(`${root}/apps/api/dist/src/modules/identity/testkit.js`).href);
const { chromium } = await import(pathToFileURL(`${root}/apps/staff/node_modules/@playwright/test/index.mjs`).href);
const log = [];
const note = (s) => { log.push(s); console.log(s); };
const k = await kit.setup({ name: 'int01j' });
const apiUrl = new URL(k.base);
const dist = `${root}/apps/staff/dist`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const HOST = kit.STAFF_HOST;
const proxy = createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const headers = { 'x-client-release': kit.RELEASE, ...req.headers, host: HOST };
    const p = import('node:http').then(({ request }) => {
      const u = request({ host: apiUrl.hostname, port: apiUrl.port, path: req.url, method: req.method, headers }, (r) => {
        res.writeHead(r.statusCode, r.headers); r.pipe(res);
      });
      req.pipe(u);
    });
    return void p;
  }
  let f = join(dist, req.url.split('?')[0]);
  if (!existsSync(f) || f === dist + '/') f = join(dist, 'index.html');
  res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const port = proxy.address().port;
const origin = `http://127.0.0.1:${port}`;
let result = 'FAIL';
try {
  const jar = {};
  const send = async (path, extra = {}) => {
    const r = await fetch(origin + path, { redirect: 'manual', ...extra, headers: { cookie: Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; '), ...(extra.headers ?? {}) } });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (/Max-Age=0/i.test(c)) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return r;
  };
  const html = await (await send('/')).text();
  note(`1. staff app served same-origin: index.html ${html.includes('<div id="root">') || html.includes('id="root"') ? 'has root mount' : 'unexpected'} (${html.length} bytes)`);
  const anon = await send('/api/v1/auth/session');
  note(`2. anonymous GET /api/v1/auth/session -> ${anon.status}`);
  if (anon.status !== 401) throw new Error('expected 401');
  k.idp.nextLogin = { sub: 'int01-sub-1', email: 'int01.user@example.com', email_verified: true, hd: 'example.com', name: 'Integration User', auth_time: Math.floor(Date.now() / 1000), amr: ['pwd'] };
  const start = await send('/api/v1/auth/sign-in?returnTo=%2F');
  note(`3. GET /api/v1/auth/sign-in -> ${start.status}, redirect to IdP authorise endpoint; pre-auth cookie ${'__Host-oidc' in jar}`);
  const idp = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const back = new URL(idp.headers.get('location'));
  note(`4. local OIDC conformance IdP authorised (PKCE S256), redirects to ${back.pathname}`);
  const cb = await send(back.pathname + back.search);
  note(`5. callback -> ${cb.status} location=${cb.headers.get('location')}; __Host-sid set=${'__Host-sid' in jar}; pre-auth cookie cleared=${!('__Host-oidc' in jar)}`);
  const sc = cb.headers.getSetCookie().find((c) => c.startsWith('__Host-sid='));
  note(`   cookie attributes: ${sc.split(';').slice(1).map((x) => x.trim()).join('; ')}`);
  const me = await send('/api/v1/auth/session');
  const body = await me.json();
  note(`6. scoped read GET /api/v1/auth/session with session -> ${me.status} ${JSON.stringify(body)}`);
  if (me.status !== 200) throw new Error('session read failed');
  const hash = createHash('sha256').update(jar['__Host-sid']).digest();
  const s = (await k.q('SELECT s.id, s.audience, p.email, p.status FROM identity.session s JOIN identity.principal p ON p.id=s.principal_id WHERE s.token_hash=$1', [hash]))[0];
  note(`7. db: session audience=${s.audience}, principal ${s.email} status=${s.status}; only the token hash is stored`);
  const jobs = await kit.queuedJobs(k, 'identity.record_sign_in', `j.payload->>'sessionId' = $2`, [s.id]);
  const w = await k.worker['runRecordSignIn']({ db: k.wdb, orgId: kit.ORG, workspaceDomain: 'example.com' }, jobs[0], 'int01-job-1');
  const ev = await k.q('SELECT action, audience, realm FROM audit.event WHERE resource_id=$1', [s.id]);
  note(`8. worker job written=${w.written}; audit.event rows=${ev.length} action=${ev[0]?.action} audience=${ev[0]?.audience} realm=${ev[0]?.realm}`);
  if (ev.length !== 1 || ev[0].action !== 'sign_in') throw new Error('audit event missing');
  const bad = await send('/api/v1/auth/session', { headers: { cookie: '__Host-sid=forged' } });
  note(`9. forged session cookie -> ${bad.status}`);
  result = 'PASS';
} catch (e) {
  note('ERROR ' + (e?.stack ?? e));
} finally {
  note('RESULT ' + result);
  writeFileSync(`${out}/journey.log`, log.join('\n') + '\n');
  proxy.close(); await k.close();
}
process.exit(result === 'PASS' ? 0 : 1);
