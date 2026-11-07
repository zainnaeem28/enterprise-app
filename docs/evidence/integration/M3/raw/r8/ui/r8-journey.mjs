// r8 patient journeys in Chromium against the REAL API + worker processes and the built patient app.
// usage: node r8-journey.mjs <repoRoot> <outDir>. Journeys: A book, B change, C cancel, D waitlist. Each step reports PASS/FAIL; later steps of a journey skip after a failure.
import { createRequire } from 'node:module';
const [root, out] = process.argv.slice(2);
const { chromium } = createRequire(root + '/apps/patient/package.json')('@playwright/test');
const B = 'http://127.0.0.1:4174';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
const calls = [], log = [];
p.on('response', async (r) => { const u = new URL(r.url()); if (!u.pathname.startsWith('/api/')) return; calls.push(`${r.request().method()} ${u.pathname}${u.search} -> ${r.status()}`);
  if (r.status() >= 400 && r.status() !== 404) { try { const t = await r.text(); calls.push('    body: ' + t.slice(0, 500) + ' req: ' + (r.request().postData() ?? '').slice(0, 400)); } catch {} } });
const text = async () => (await p.innerText('body')).replace(/\s+/g, ' ').slice(0, 400);
let n = 0, failed = false, anyFailed = false;
const shot = async (name) => p.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true });
async function step(name, fn) {
  if (failed) { log.push(`SKIP  ${name} (earlier step of this journey failed)`); return; }
  try { await fn(); log.push(`PASS  ${name}`); await shot(name); }
  catch (e) { failed = anyFailed = true; log.push(`FAIL  ${name}: ${e.message.split('\n')[0]}`); log.push('      url: ' + p.url() + ' body: ' + await text()); await shot('FAILED-' + name); }
}
const journey = (t) => { failed = false; log.push(`== ${t}`); };
const T = { timeout: 15000 };
const SLOT = /\d{1,2}:\d\d [AP]M/;
const mark = () => calls.length;
const since = (m) => calls.slice(m).join(' | ');
let apptId;

journey('A. sign-in (fresh database, NO manual task-type sync) and booking');
await step('landing', async () => { await p.goto(B + '/'); await p.waitForLoadState('networkidle'); });
await step('sign-in', async () => {
  const s = p.getByRole('button', { name: /sign in/i }).or(p.getByRole('link', { name: /sign in/i }));
  await s.first().click(T);
  const c = p.getByRole('button', { name: /continue/i }).or(p.getByRole('link', { name: /continue/i }));
  if (await c.count()) await c.first().click(T);
  await p.waitForURL((u) => u.port === '4174' && !u.pathname.startsWith('/continue'), T); await p.waitForLoadState('networkidle');
  log.push('      cookies: ' + (await ctx.cookies()).map((c) => `${c.name} secure=${c.secure} httpOnly=${c.httpOnly}`).join('; ') + ' landed: ' + p.url());
  if (!calls.some((c) => /auth\/session -> 200/.test(c))) throw new Error('no 200 session');
});
const book = async (svc) => {
  await p.goto(B + '/book'); await p.getByRole('radio').first().waitFor(T);
  await (svc ? p.getByRole('radio', { name: svc }) : p.getByRole('radio').first()).check();
  await p.getByRole('button', { name: 'Continue' }).click(T);
  const place = p.getByLabel('Place'); await place.waitFor(T);
  const o = await place.locator('option').allInnerTexts(); await place.selectOption({ index: o.length > 1 ? 1 : 0 }).catch(() => {});
  await p.getByLabel('Doctor').waitFor(T);
  await p.getByRole('button', { name: 'Continue' }).click(T);
  await p.getByRole('heading', { name: 'Choose a date and time' }).waitFor(T);
  await p.getByRole('button', { name: SLOT }).first().waitFor(T);
};
await step('service, place, clinician, availability', () => book(/General appointment/));
await step('hold', async () => { await p.getByRole('button', { name: SLOT }).nth(48).click(T); await p.getByRole('timer').waitFor(T); });
await step('review', async () => { await p.getByRole('button', { name: 'Continue' }).click(T); await p.getByRole('heading', { name: 'Check and confirm' }).waitFor(T); });
await step('confirm', async () => { await p.getByRole('button', { name: 'Confirm appointment' }).click(T); await p.getByRole('heading', { name: 'Your appointment is booked' }).waitFor(T); });
await step('my appointments', async () => {
  await p.goto(B + '/appointments'); await p.getByRole('heading', { name: 'Your appointments' }).waitFor(T);
  await p.getByRole('button', { name: 'View details' }).first().waitFor(T);
});

journey('B. appointment detail and change time');
await step('detail', async () => {
  const m = mark(); await p.getByRole('button', { name: 'View details' }).first().click(T);
  await p.getByRole('button', { name: 'Change time' }).waitFor(T);
  apptId = new URL(p.url()).pathname.split('/').pop(); log.push('      appointment id seen in URL: ' + apptId + ' calls: ' + since(m));
});
let before;
await step('change: choose a different time', async () => {
  before = await p.innerText('main');
  await p.getByRole('button', { name: 'Change time' }).click(T);
  await p.getByRole('heading', { name: 'Choose a new time' }).waitFor(T);
  const slots = p.getByRole('button', { name: SLOT }); await slots.first().waitFor(T);
  await slots.nth(64).click(T); await p.waitForTimeout(800);
});
await step('change: confirm the new time', async () => {
  const m = mark(); await p.getByRole('button', { name: 'Continue' }).click(T);
  await p.getByRole('heading', { name: 'Confirm the new time' }).waitFor(T); await shot('change-review');
  await p.getByRole('button', { name: 'Change to this time' }).click(T);
  await p.waitForURL((u) => !u.pathname.endsWith('/confirm'), T); await p.waitForLoadState('networkidle');
  log.push('      calls: ' + since(m) + ' | page: ' + (await text()).slice(0, 200));
  if (!calls.slice(m).some((c) => /reschedule -> 200/.test(c))) throw new Error('reschedule did not return 200');
});
await step('appointments after change (still one confirmed)', async () => {
  await p.goto(B + '/appointments'); await p.getByRole('button', { name: 'View details' }).first().waitFor(T);
  log.push('      listed: ' + await p.getByRole('button', { name: 'View details' }).count() + ' | ' + (await text()).slice(0, 250));
});

journey('C. cancel');
await step('cancel page shows policy text', async () => {
  await p.getByRole('button', { name: 'View details' }).first().click(T);
  await p.getByRole('button', { name: 'Cancel appointment' }).click(T);
  await p.getByRole('heading', { level: 1 }).first().waitFor(T);
  log.push('      page: ' + (await text()).slice(0, 300));
});
await step('cancel confirmed', async () => {
  const m = mark();
  await p.getByRole('button', { name: 'Cancel appointment' }).first().click(T);
  await p.getByRole('dialog').or(p.getByRole('alertdialog')).waitFor(T); await shot('cancel-dialog');
  await p.getByRole('alertdialog').or(p.getByRole('dialog')).getByRole('button', { name: 'Cancel appointment' }).click(T);
  await p.waitForLoadState('networkidle'); await p.waitForTimeout(1000);
  log.push('      calls: ' + since(m) + ' | page: ' + (await text()).slice(0, 250));
  if (!calls.slice(m).some((c) => /cancel -> 200/.test(c))) throw new Error('cancel did not return 200');
});
await step('appointments after cancel', async () => {
  await p.goto(B + '/appointments'); await p.waitForLoadState('networkidle');
  log.push('      page: ' + (await text()).slice(0, 300));
});

journey('D. waitlist join (patient)');
await step('reach the waitlist page', async () => {
  await book(/Waitlist visit/).catch(() => {});
  const wl = p.getByRole('button', { name: 'join the waitlist' });
  await wl.waitFor(T);
  if (!(await wl.count())) throw new Error('no empty week reachable in the UI (waitlist link never shown); next-buttons=' + (await next.count()));
  await wl.click(T); await p.getByRole('heading', { name: 'Join the waitlist' }).waitFor(T);
});
await step('join', async () => {
  const m = mark(); await p.getByRole('button', { name: 'Join the waitlist' }).click(T);
  await p.waitForLoadState('networkidle'); await p.waitForTimeout(1000);
  log.push('      calls: ' + since(m) + ' | page: ' + (await text()).slice(0, 250));
  if (!calls.slice(m).some((c) => /waitlist-entries -> 20\d/.test(c))) throw new Error('waitlist-entries did not succeed');
});

console.log(log.join('\n') + '\n--- API calls seen by the browser ---\n' + calls.join('\n'));
await b.close();
process.exit(anyFailed ? 1 : 0);
