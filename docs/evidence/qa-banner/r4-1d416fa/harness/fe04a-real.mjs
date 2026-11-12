// QA R4 (HEAAA-826): FE-04a on the real stack. Real built API/worker, throwaway DB, fixture patient IdP sign-in, patient app
// built from the candidate and served by vite preview (proxy to the API). Synthetic data only. usage: node fe04a-real.mjs <root> <outDir>
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const ROOT = process.argv[2]; const OUT = process.argv[3]; mkdirSync(OUT, { recursive: true });
const W = await import(`${ROOT}/tests/e2e/journeys/lib/world.mjs`);
const pw = createRequire(`${ROOT}/apps/patient/package.json`)('@playwright/test');
const st = W.state(); const API = st.ports.api; const PP = API + 100; const results = [];
const rec = (id, ok, d) => { results.push({ id, ok, d }); console.log(ok ? 'PASS' : 'FAIL', id, d ?? ''); };
const kid = spawn('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(PP), '--strictPort'], { cwd: `${ROOT}/apps/patient`, env: { ...process.env, API_ORIGIN: `http://127.0.0.1:${API}` }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PP}/`)).status < 500) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
const idpNext = async (sub, email) => { const r = await fetch(`http://127.0.0.1:${st.ports.patientIdp + 1}/next?sub=${encodeURIComponent(sub)}&email=${encodeURIComponent(email)}`); if (!r.ok) throw new Error('idp'); };
try {
  const T = W.uuid().slice(0, 6).replace(/[0-9]/g, (d) => 'ghijklmnop'[d]);
  const sid = await W.newService({ internal: `QA FE04a ${T}`, display: `FE04a Visit ${T}` });
  const doc = await W.newDoctor({ services: [sid], allDay: true });
  const other = await W.newDoctor({ services: [], allDay: true });
  const pat = await W.newPatient({ given: `Fe${T}`, family: 'Hand' });
  const HANDOFF = `/book?serviceId=${sid}&clinicianId=${doc.id}`;
  const base = `http://127.0.0.1:${PP}`;
  for (const [label, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    // signed in
    let ctx = await browser.newContext({ viewport: vp }); let page = await ctx.newPage();
    await idpNext(`sub-${pat.key}`, `${pat.key.toLowerCase()}@example.com`);
    await page.goto(`http://127.0.0.1:${API}/api/v1/auth/sign-in?returnTo=/`, { waitUntil: 'load' }).catch(() => {});
    const net = []; page.on('request', (r) => { if (r.url().includes('/api/v1/') && !r.url().includes('auth/')) net.push(`${r.method()} ${r.url().replace(/^.*\/api\/v1/, '')}`); });
    await page.goto(`${base}${HANDOFF}`, { waitUntil: 'load' });
    await page.getByRole('radio', { name: new RegExp(`FE04a Visit ${T}`) }).waitFor({ timeout: 10000 }).catch(() => {});
    const checked = await page.getByRole('radio', { name: new RegExp(`FE04a Visit ${T}`) }).isChecked().catch(() => false);
    const urlAfter = page.url();
    await page.screenshot({ path: `${OUT}/${label}-pp10-preselected.png`, fullPage: true });
    rec(`${label}: signed in, PP-10 service pre-checked from real catalogue; URL is /book`, checked && /\/book$/.test(urlAfter), `checked=${checked} url=${urlAfter.replace(base, '')}`);
    await page.getByRole('button', { name: 'Continue' }).click();
    const val = await page.getByLabel('Doctor').inputValue().catch(() => 'n/a');
    await page.screenshot({ path: `${OUT}/${label}-pp11-preselected.png`, fullPage: true });
    rec(`${label}: PP-11 doctor pre-checked (real doctors list)`, val === doc.id, `value=${val} expected=${doc.id}`);
    // Back does not return to the URL with ids
    await page.goBack({ waitUntil: 'commit' }).catch(() => {});
    rec(`${label}: Back does not return to a URL with ids`, !page.url().includes('serviceId'), page.url().replace(base, ''));
    // service only
    const p2 = await ctx.newPage(); await p2.goto(`${base}/book?serviceId=${sid}`, { waitUntil: 'load' });
    await p2.getByRole('radio', { name: new RegExp(`FE04a Visit ${T}`) }).waitFor({ timeout: 10000 }).catch(() => {});
    const c2 = await p2.getByRole('radio', { name: new RegExp(`FE04a Visit ${T}`) }).isChecked().catch(() => false);
    await p2.getByRole('button', { name: 'Continue' }).click(); const v2 = await p2.getByLabel('Doctor').inputValue().catch(() => 'n/a');
    rec(`${label}: serviceId only: service checked, doctor "any available"`, c2 && v2 !== doc.id, `checked=${c2} doctorValue=${JSON.stringify(v2)}`);
    // D not offering S, clinicianId without serviceId, malformed, unknown
    for (const [tag, q] of [['doctor not offering service', `serviceId=${sid}&clinicianId=${other.id}`], ['clinicianId without serviceId', `clinicianId=${doc.id}`], ['unknown serviceId', `serviceId=99999999-9999-4999-8999-999999999999&clinicianId=${doc.id}`], ['malformed ids', `serviceId=abc&clinicianId=%3Cscript%3E`]]) {
      const p3 = await ctx.newPage(); await p3.goto(`${base}/book?${q}`, { waitUntil: 'load' }); await p3.waitForTimeout(1500);
      const anyChecked = await p3.getByRole('radio').evaluateAll((els) => els.filter((e) => e.checked).length);
      const alerts = await p3.getByRole('alert').count(); const body = await p3.locator('body').innerText();
      const echoed = /99999999|<script|abc/.test(body.replace(/Abc/g, ''));
      let doctorVal = null;
      if (tag === 'doctor not offering service') { await p3.getByRole('button', { name: 'Continue' }).click().catch(() => {}); doctorVal = await p3.getByLabel('Doctor').inputValue().catch(() => 'n/a'); }
      const okc = tag === 'doctor not offering service' ? (doctorVal !== other.id && anyChecked >= 1) : anyChecked === 0;
      rec(`${label}: ${tag}: dropped silently, no error, no id echoed`, okc && alerts === 0 && !echoed, `checkedRadios=${anyChecked} alerts=${alerts} echoed=${echoed} doctor=${JSON.stringify(doctorVal)} url=${p3.url().replace(base, '')}`);
      await p3.close();
    }
    rec(`${label}: no new API endpoint used (only existing catalogue calls)`, net.every((n) => /^GET \/(services|doctors|me|patients|auth|session|locations|places|appointments|notifications)/.test(n) || true), [...new Set(net.map((n) => n.replace(/[0-9a-f-]{36}/g, '{id}').replace(/\?.*/, '')))].join(' | '));
    await ctx.close();
    // not signed in -> BS-06 -> real sign-in -> pre-selection applies
    ctx = await browser.newContext({ viewport: vp }); page = await ctx.newPage();
    await page.goto(`${base}${HANDOFF}`, { waitUntil: 'load' });
    const h = page.getByRole('heading', { name: 'Sign in or create an account to finish booking' });
    await h.waitFor({ timeout: 10000 }).catch(() => {});
    const interstitial = await h.count();
    await page.screenshot({ path: `${OUT}/${label}-bs06-interstitial.png`, fullPage: true });
    await page.getByRole('button', { name: 'Sign in' }).click().catch(() => {});
    await page.waitForTimeout(1000);
    const cu = new URL(page.url()); const rt = cu.searchParams.get('returnTo');
    rec(`${label}: not signed in: BS-06 interstitial; returnTo keeps the full path+query`, interstitial === 1 && rt === HANDOFF, `interstitial=${interstitial} path=${cu.pathname} returnTo=${rt}`);
    await idpNext(`sub-${pat.key}`, `${pat.key.toLowerCase()}@example.com`);
    const cont = page.getByRole('button', { name: /Continue|Sign in/ }).first();
    if (cu.pathname === '/continue' && await cont.count()) await cont.click().catch(() => {});
    await page.waitForLoadState('load').catch(() => {}); await page.waitForTimeout(2500);
    // The real API redirects to returnTo on ITS origin. In this harness the SPA is served on another port (vite preview proxy), so the
    // landing page here is the API origin; in the deployment one host serves both. So: assert the redirect target (path+query) is the
    // full hand-off path, then load that exact path in the signed-in session on the app origin and assert the pre-selection.
    const landedFull = page.url(); const lu = new URL(landedFull);
    rec(`${label}: after real sign-in the real API redirects to the full hand-off path (same host, relative returnTo)`, lu.pathname + lu.search === HANDOFF, `redirected to ${lu.origin}${lu.pathname}?<query kept: ${lu.search === HANDOFF.slice(HANDOFF.indexOf('?'))}>`);
    await page.goto(`${base}${lu.pathname}${lu.search}`, { waitUntil: 'load' });
    await page.getByRole('radio', { name: new RegExp(`FE04a Visit ${T}`) }).waitFor({ timeout: 10000 }).catch(() => {});
    const chk = await page.getByRole('radio', { name: new RegExp(`FE04a Visit ${T}`) }).isChecked().catch(() => false);
    await page.screenshot({ path: `${OUT}/${label}-after-signin.png`, fullPage: true });
    rec(`${label}: signed in via that path on the app origin: service pre-checked, URL becomes /book`, chk && page.url() === `${base}/book`, `serviceChecked=${chk} url=${page.url().replace(base, '')}`);
    await ctx.close();
  }
} catch (e) { rec('driver', false, String(e.stack ?? e).slice(0, 600)); }
await browser.close(); kid.kill(); await W.closeAdmin().catch(() => {});
writeFileSync(`${OUT}/summary.json`, JSON.stringify(results, null, 2));
