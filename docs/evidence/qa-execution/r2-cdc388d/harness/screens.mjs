// QA-R2 real-stack browser journeys with screenshots beyond the administrator path (HEAAA-640).
// Real built API + worker + PostgreSQL, real OIDC sign-in through the fixture IdP, the BUILT staff/patient apps (vite preview, /api proxied
// to the real API) and the BUILT brand-site server, driven by a real browser. No API mock. Synthetic data only.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import http from 'node:http';
import net from 'node:net';
const ROOT = resolve(process.argv[2]); const OUT = resolve(process.argv[3]); const ENGINE = process.argv[4] ?? 'chromium';
const W = await import(`${ROOT}/tests/e2e/journeys/lib/world.mjs`);
const { SVC, A1, search, nextDay, soon, newDoctor, newStaff, newPatient, book, state, sql, closeAdmin } = W;
const rq = createRequire(`${ROOT}/apps/staff/package.json`);
const pw = rq('@playwright/test');
const st = state(); const API = st.ports.api;
const PORTS = { patient: API + 100, staff: API + 101 };
mkdirSync(OUT, { recursive: true });
const results = [];
const rec = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(ok ? 'PASS' : 'FAIL', id, detail ?? ''); };
const kids = [];
const spawnQ = (cmd, args, opts) => { const p = spawn(cmd, args, { stdio: 'ignore', ...opts }); kids.push(p); return p; };
const waitUp = async (url) => { for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await new Promise((r) => setTimeout(r, 250)); } throw new Error('not up ' + url); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// built apps
spawnQ('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(PORTS.patient), '--strictPort'], { cwd: `${ROOT}/apps/patient`, env: { ...process.env, API_ORIGIN: `http://127.0.0.1:${API}` } });
spawnQ('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(PORTS.staff), '--strictPort'], { cwd: `${ROOT}/apps/staff`, env: { ...process.env, API_ORIGIN: `http://localhost:${API}` } });
await waitUp(`http://127.0.0.1:${PORTS.patient}/`); await waitUp(`http://localhost:${PORTS.staff}/`);

// synthetic world
const day = soon(1, 5);
const doc = await newDoctor({ services: [SVC.IN], allDay: true });
const pat = await newPatient({ given: 'Casey', family: 'Synthetic' });
const fd = await newStaff([['front_desk', A1]], { name: 'STF-FD-QA' });
const slots = await search(pat.client, { serviceId: SVC.IN, mode: 'in_person', day, clinicianId: doc.id });
const slot = slots.json?.slots?.[0] ?? slots.json?.items?.[0];
let appt = null;
if (slot) { try { appt = await book(pat, slot, SVC.IN, 'in_person'); } catch (e) { rec('seed.book', false, String(e.message).slice(0, 200)); } }
rec('seed.world', !!doc && !!pat && !!fd, `doctor ${doc.key}, patient ${pat.key}, front desk ${fd.key}, booked=${!!appt}`);

async function idpNext(kind, sub, email) {
  const port = (kind === 'staff' ? st.ports.staffIdp : st.ports.patientIdp) + 1;
  const r = await fetch(`http://127.0.0.1:${port}/next?sub=${encodeURIComponent(sub)}&email=${encodeURIComponent(email)}`);
  if (!r.ok) throw new Error('idp control');
}
const browserType = pw[ENGINE];
const browser = await browserType.launch(ENGINE === 'chromium' ? { args: ['--no-sandbox'] } : {});
async function signedIn(kind, key) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await idpNext(kind, `sub-${key}`, `${key.toLowerCase()}@example.com`);
  const host = kind === 'staff' ? 'localhost' : '127.0.0.1';
  await page.goto(`http://${host}:${API}/api/v1/auth/sign-in?returnTo=/`, { waitUntil: 'load' }).catch((e) => console.log('sign-in landing (returnTo / on the API origin has no page):', String(e.message).split('\n')[0]));
  const s = await page.request.get(`http://${host}:${API}/api/v1/auth/session`, { headers: { 'x-client-release': 'r1.000000000000' } });
  if (s.status() !== 200) console.log('session probe', kind, s.status(), (await s.text()).slice(0, 200), 'url after sign-in', page.url());
  return { ctx, page, session: s.status() };
}
const errs = [];
async function shot(page, name, { expectText, notText = /something went wrong|unexpected error|cannot read|undefined/i } = {}) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  const txt = await page.locator('body').innerText();
  let ok = txt.trim().length > 20 && !notText.test(txt);
  if (expectText) ok = ok && expectText.test(txt);
  rec(`${ENGINE}:${name}`, ok, `${page.url().replace(/\?.*/, '')} text=${txt.trim().length}ch${expectText ? ' expect ' + expectText : ''}`);
  return txt;
}
async function visit(page, base, path, name, o) {
  try { await page.goto(base + path, { waitUntil: 'load' }); }
  catch (e) { console.log('RETRY goto', path, String(e.message).split('\n')[0].slice(0, 160), 'url now', page.url()); await page.waitForTimeout(1500); await page.goto(base + path, { waitUntil: 'load' }); }
  return shot(page, name, o);
}

try {
  // ---- doctor (staff app)
  const d = await signedIn('staff', doc.key);
  rec(`${ENGINE}:doctor.session`, d.session === 200, `status ${d.session}`);
  const SB = `http://localhost:${PORTS.staff}`;
  d.page.on('pageerror', (e) => errs.push(`doctor pageerror ${e.message}`));
  for (const [p, n, x] of [['/schedule', '10-doctor-schedule', /Casey Synthetic/], ['/patients', '11-doctor-patient-list'], ['/alerts', '12-doctor-alerts'], ['/notes-to-sign', '13-doctor-notes-to-sign'], ['/availability', '14-doctor-availability'], ['/tasks', '15-doctor-tasks']])
    await visit(d.page, SB, p, n, x ? { expectText: x } : undefined);
  await d.ctx.close();
  // ---- front desk
  const f = await signedIn('staff', fd.key);
  rec(`${ENGINE}:frontdesk.session`, f.session === 200, `status ${f.session}`);
  f.page.on('pageerror', (e) => errs.push(`frontdesk pageerror ${e.message}`));
  for (const [p, n] of [['/arrivals', '20-frontdesk-arrivals'], ['/waitlist', '21-frontdesk-waitlist'], ['/patients', '22-frontdesk-patients'], ['/forms', '23-frontdesk-forms'], ['/triage', '24-frontdesk-triage-queue']])
    await visit(f.page, SB, p, n);
  await f.ctx.close();
  // ---- patient
  const p = await signedIn('patient', pat.key);
  rec(`${ENGINE}:patient.session`, p.session === 200, `status ${p.session}`);
  p.page.on('pageerror', (e) => errs.push(`patient pageerror ${e.message}`));
  const PB = `http://127.0.0.1:${PORTS.patient}`;
  for (const [pa, n, x] of [['/', '30-patient-home'], ['/book', '31-patient-booking-start', /What would you like to book/], ['/profile', '32-patient-profile', /Casey|profile/i], ['/privacy', '33-patient-privacy'], ['/messages', '34-patient-messages'], ['/appointments', '35-patient-appointments', /Confirmed/]])
    await visit(p.page, PB, pa, n, x ? { expectText: x } : undefined);
  if (appt) await visit(p.page, PB, `/appointments/${appt.appointment?.id ?? appt.reservationId}/previsit`, '36-patient-previsit');
  await p.ctx.close();
  // ---- brand site
  const proxyPort = await freePort(); const sitePort = await freePort();
  const proxy = http.createServer((req, res) => { const up = http.request({ host: '127.0.0.1', port: API, path: req.url, method: req.method, headers: { ...req.headers, host: 'integrations.localhost', 'x-forwarded-for': '10.77.0.1' } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); up.on('error', () => res.writeHead(502).end()); req.pipe(up); });
  await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));
  const base = `http://127.0.0.1:${sitePort}`;
  spawnQ('node', [`${ROOT}/apps/site/dist/server/server.js`], { env: { PATH: process.env.PATH, PORT: String(sitePort), SITE_ORIGIN: base, PUBLIC_API_ORIGIN: `http://127.0.0.1:${proxyPort}`, PATIENT_ORIGIN: `http://127.0.0.1:${PORTS.patient}` } });
  await waitUp(base + '/healthz');
  const sctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const sp = await sctx.newPage();
  for (const [pa, n, x] of [['/', '40-site-home'], ['/services', '41-site-services', /appointment|consult/i], ['/doctors', '42-site-doctors'], ['/locations', '43-site-locations']])
    await visit(sp, base, pa, n, { notText: /something went wrong|unexpected error/i, ...(x ? { expectText: x } : {}) });
  await sctx.close(); proxy.close();
  // ---- mobile width patient home (responsive)
  const mctx = await browser.newContext({ viewport: { width: 360, height: 740 } }); const mp = await mctx.newPage();
  await idpNext('patient', `sub-${pat.key}`, `${pat.key.toLowerCase()}@example.com`);
  await mp.goto(`http://127.0.0.1:${API}/api/v1/auth/sign-in?returnTo=/`).catch(() => {});
  await visit(mp, PB, '/', '50-patient-home-360px'); await mctx.close();
} catch (e) { rec(`${ENGINE}:driver`, false, String(e.stack ?? e).slice(0, 600)); }
await browser.close();
for (const k of kids) try { k.kill(); } catch {}
await closeAdmin().catch(() => {});
writeFileSync(`${OUT}/summary.json`, JSON.stringify({ engine: ENGINE, browser: browser.version?.() ?? null, results, pageErrors: errs, at: new Date().toISOString() }, null, 2));
console.log(`engine=${ENGINE} pass=${results.filter((r) => r.ok).length} fail=${results.filter((r) => !r.ok).length} pageErrors=${errs.length}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
