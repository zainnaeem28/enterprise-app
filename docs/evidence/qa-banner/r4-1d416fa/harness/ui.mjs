// HEAAA-666: real-browser BR-34 checks (staff app built from cdc388d, real API, real OIDC fixture sign-in). Synthetic data only.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const ROOT = '/paperclip/scratch/integ-977'; const OUT = process.argv[2]; mkdirSync(OUT, { recursive: true });
const W = await import(`${ROOT}/tests/e2e/journeys/lib/world.mjs`);
const C = await import(`${ROOT}/tests/e2e/journeys/lib/clinical.mjs`);
const { state, newPatient, newStaff, newDoctor, A1, sql } = W;
const pw = createRequire(`${ROOT}/apps/staff/package.json`)('@playwright/test');
const st = state(); const API = st.ports.api; const SP = API + 101;
const results = []; const rec = (id, ok, d) => { results.push({ id, ok, d }); console.log(ok ? 'PASS' : 'FAIL', id, d ?? ''); };
const kid = spawn('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(SP), '--strictPort'], { cwd: `${ROOT}/apps/staff`, env: { ...process.env, API_ORIGIN: `http://localhost:${API}` }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://localhost:${SP}/`)).status < 500) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const idpNext = async (sub, email) => { const r = await fetch(`http://127.0.0.1:${st.ports.staffIdp + 1}/next?sub=${encodeURIComponent(sub)}&email=${encodeURIComponent(email)}`); if (!r.ok) throw new Error('idp'); };
const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
async function signIn(key, vp) {
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  await idpNext(`sub-${key}`, `${key.toLowerCase()}@example.com`);
  await page.goto(`http://localhost:${API}/api/v1/auth/sign-in?returnTo=/`, { waitUntil: 'load' }).catch(() => {});
  return { ctx, page };
}
const bannerInfo = async (page) => page.evaluate(() => {
  const b = document.querySelector('.ehr-patient-banner'); if (!b) return null;
  const q = (s) => { const e = b.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { text: e.textContent.trim(), visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none', inView: r.top >= 0 && r.bottom <= innerHeight }; };
  const r = b.getBoundingClientRect();
  return { name: q('.ehr-patient-banner__name'), dob: q('.ehr-patient-banner__dob'), avatar: q('.ehr-avatar'), img: !!b.querySelector('.ehr-avatar img'), allergy: q('.ehr-patient-banner__allergy'), mrn: q('.ehr-patient-banner__mrn'), position: getComputedStyle(b).position, top: r.top, width: r.width, scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
});
try {
  const T = W.uuid().slice(0, 6).replace(/[0-9]/g, (d) => 'ghijklmnop'[d]);
  const doc = await newDoctor({ allDay: true });
  const long = await newPatient({ given: T + 'L'.repeat(54), family: 'F'.repeat(59), dob: '1971-02-03' });
  const nophoto = await newPatient({ given: T + 'NoPhoto', family: 'Ui', dob: '1990-05-06' });
  const p4 = await newPatient({ given: T + 'Same', family: 'NameUi', dob: '1975-03-04' });
  const p5 = await newPatient({ given: T + 'Same', family: 'NameUi', dob: '1982-09-30' });
  for (const p of [long, nophoto, p4, p5]) await sql(`INSERT INTO patient.care_team_member (id, organisation_id, patient_id, principal_id, role) SELECT $1, organisation_id, $2, $3, 'clinician' FROM patient.patient WHERE id=$2`, [W.uuid(), p.id, doc.id]);
  console.log('doc', doc.key, doc.id, 'careteam rows', JSON.stringify((await sql(`SELECT patient_id, principal_id FROM patient.care_team_member WHERE principal_id=$1`, [doc.id])).rows.length));
  for (const [label, vp] of [['1280', { width: 1280, height: 900 }], ['360', { width: 360, height: 740 }], ['zoom200', { width: 640, height: 450 }]].filter((x) => !process.env.ONLY || x[0] === process.env.ONLY)) {
    const { ctx, page } = await signIn(doc.key, vp);
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    page.on('response', async (r) => { if (r.url().includes('/api/v1/patients/') && label === '1280') console.log('  net', r.status(), r.request().method(), r.url().replace(/^.*\/api\/v1/, ''), r.status() >= 400 ? (await r.text()).slice(0, 160) : ''); });
    const SB = `http://localhost:${SP}`;
    console.log('session', (await page.request.get(`http://localhost:${API}/api/v1/auth/session`, { headers: { 'x-client-release': 'r1.000000000000' } })).status());
    for (const [tag, p, nm] of [['nophoto', nophoto, T + 'NoPhoto'], ['long', long, T + 'LLLL'], ['same-1975', p4, T + 'Same'], ['same-1982', p5, T + 'Same']]) {
      await page.goto(`${SB}/patients`, { waitUntil: 'load' });
      await page.fill('#pl-name', nm); if (tag.startsWith('same')) await page.fill('#pl-dob', p.id === p4.id ? '1975-03-04' : '1982-09-30');
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: /Open chart/ }).first().click({ timeout: 8000 }).catch((e) => console.log('open chart click failed', tag, String(e.message).slice(0, 100)));
      await page.waitForSelector('.ehr-patient-banner', { timeout: 8000 }).catch(() => {});
      const bi = await bannerInfo(page);
      await page.screenshot({ path: `${OUT}/${label}-${tag}.png`, fullPage: true });
      await page.mouse.wheel(0, 4000); await page.waitForTimeout(300);
      const after = await bannerInfo(page);
      rec(`${label}:${tag}:banner`, !!bi && bi.name?.visible && bi.dob?.visible, JSON.stringify({ name: bi?.name?.text?.slice(0, 30) + '(' + bi?.name?.text?.length + ')', dob: bi?.dob?.text, avatar: bi?.avatar?.text, img: bi?.img, allergy: bi?.allergy?.text?.slice(0, 40), mrnVisible: bi?.mrn?.visible, pos: bi?.position, scrollX: bi ? bi.scrollW > bi.innerW : null, afterScroll: after ? { dobVisible: after.dob?.visible, dobInView: after.dob?.inView, top: after.top } : null }));
    }
    await ctx.close();
  }
  // doctor visit screens: schedule -> open visit -> banner above the note editor
  const v = await C.visit({ doc }); await C.checkIn(v);
  for (const [label, vp] of [['1280', { width: 1280, height: 900 }], ['360', { width: 360, height: 740 }]]) {
    const { ctx, page } = await signIn(doc.key, vp);
    await page.goto(`http://localhost:${SP}/schedule`, { waitUntil: 'load' });
    await page.getByRole('link', { name: /Test Patient|MRN-/ }).first().click({ timeout: 8000 }).catch(async (e) => { console.log('open visit failed', String(e.message).slice(0, 80)); await page.getByRole('button', { name: /Test Patient|MRN-/ }).first().click({ timeout: 4000 }).catch(() => {}); });
    await page.waitForSelector('.ehr-patient-banner', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
    const bv = await bannerInfo(page);
    const head = await page.locator('h2, h3').allInnerTexts();
    await page.screenshot({ path: `${OUT}/doctor-visit-${label}.png`, fullPage: true });
    const startBtn = page.getByRole('button', { name: /Start (consultation|note)|Begin/ }).first();
    const hasStart = await startBtn.count();
    if (hasStart) { await startBtn.click().catch(() => {}); await page.waitForTimeout(1500); }
    await page.mouse.wheel(0, 6000); await page.waitForTimeout(300);
    const after = await bannerInfo(page);
    await page.screenshot({ path: `${OUT}/doctor-note-scrolled-${label}.png` });
    rec(`${label}:DR-03/04 visit workspace`, !!bv && bv.name?.visible && bv.dob?.visible, JSON.stringify({ banner: !!bv, name: bv?.name?.text, dob: bv?.dob?.text, headings: head.slice(0, 12), startButton: hasStart, afterScroll: after ? { dobInView: after.dob?.inView, top: after.top } : null, scrollY: await page.evaluate(() => scrollY), docH: await page.evaluate(() => document.documentElement.scrollHeight) }));
    await ctx.close();
  }
  // front desk / triage nurse
  const fd = await newStaff([['front_desk', A1], ['triage_nurse', A1]], { name: 'STF-FD-UI' });
  const f = await signIn(fd.key, { width: 1280, height: 900 });
  f.page.on('response', async (r) => { if (r.url().includes('/api/v1/') && !r.url().includes('auth') && r.status() >= 400) console.log('  fdnet', r.status(), r.url().replace(/^.*\/api\/v1/, '')); });
  await f.page.goto(`http://localhost:${SP}/arrivals`, { waitUntil: 'load' });
  await f.page.getByRole('tab', { name: /Check.?in/i }).click({ timeout: 5000 }).catch((e) => console.log('tab failed', String(e.message).slice(0, 60)));
  await f.page.getByLabel(/name/i).first().fill('Test').catch(() => {});
  await f.page.keyboard.press('Enter'); await f.page.waitForTimeout(1200);
  await f.page.getByRole('button', { name: /Show visits/ }).last().click({ timeout: 5000 }).catch((e) => console.log('pc02 choose failed', String(e.message).slice(0, 80)));
  await f.page.waitForTimeout(1200);
  let bi = await bannerInfo(f.page); await f.page.screenshot({ path: `${OUT}/fd-PC-02-check-in-patient-chosen.png`, fullPage: true });
  rec('PC-02 check-in with a patient chosen: banner (name, DOB, photo)', !!bi, `banner=${!!bi}; body: ${(await f.page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 220)}`);
  await f.page.goto(`http://localhost:${SP}/arrivals`, { waitUntil: 'load' }); await f.page.waitForTimeout(1000);
  await f.page.screenshot({ path: `${OUT}/fd-PC-01-arrivals.png`, fullPage: true });
  const trBtn = f.page.getByRole('button', { name: /Triage|Vitals|Record|Open/ }).first();
  if (await trBtn.count()) { await trBtn.click().catch(() => {}); await f.page.waitForTimeout(1500); }
  bi = await bannerInfo(f.page); await f.page.screenshot({ path: `${OUT}/fd-triage-vitals.png`, fullPage: true });
  rec('triage/vitals screen reached from PC-01: banner', !!bi, `url ${f.page.url().replace(/\?.*/, '')} banner=${!!bi} ${bi ? JSON.stringify({ name: bi.name?.text, dob: bi.dob?.text, img: bi.img, avatar: bi.avatar?.text }) : ''}`);
  await f.ctx.close();
} catch (e) { rec('driver', false, String(e.stack ?? e).slice(0, 500)); }
await browser.close(); kid.kill(); await W.closeAdmin().catch(() => {});
writeFileSync(`${OUT}/summary.json`, JSON.stringify(results, null, 2));
