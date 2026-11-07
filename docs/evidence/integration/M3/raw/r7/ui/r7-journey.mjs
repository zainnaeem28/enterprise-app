// Patient booking journey in Chromium against the REAL API process and the built patient app. usage: node r7-journey.mjs <repoRoot> <outDir>
import { createRequire } from 'node:module';
const [root, out] = process.argv.slice(2);
const { chromium } = createRequire(root + '/apps/patient/package.json')('@playwright/test');
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const p = await ctx.newPage();
const calls = [], log = [];
p.on('response', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) calls.push(`${r.request().method()} ${u.pathname}${u.search} -> ${r.status()}`); });
const text = async () => (await p.innerText('body')).replace(/\s+/g, ' ').slice(0, 400);
let n = 0, failed = false;
const shot = async (name) => p.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true });
async function step(name, fn) {
  if (failed) { log.push(`SKIP  ${name} (earlier step failed)`); return; }
  try { await fn(); log.push(`PASS  ${name}`); await shot(name); }
  catch (e) { failed = true; log.push(`FAIL  ${name}: ${e.message.split('\n')[0]}`); log.push('      url: ' + p.url() + ' body: ' + await text()); await shot('FAILED-' + name); }
}
const T = { timeout: 15000 };
await step('landing', async () => { await p.goto('http://127.0.0.1:4174/'); await p.waitForLoadState('networkidle'); });
await step('sign-in', async () => {
  await p.goto('http://127.0.0.1:4174/'); await p.waitForLoadState('networkidle');
  const s = p.getByRole('button', { name: /sign in/i }).or(p.getByRole('link', { name: /sign in/i }));
  await s.first().click(T);
  const c = p.getByRole('button', { name: /continue/i }).or(p.getByRole('link', { name: /continue/i }));
  if (await c.count()) await c.first().click(T);
  await p.waitForURL((u) => u.port === '4174' && !u.pathname.startsWith('/continue'), T); await p.waitForLoadState('networkidle');
  const cookies = (await ctx.cookies()).map((c) => `${c.name} secure=${c.secure} httpOnly=${c.httpOnly}`);
  log.push('      cookies: ' + cookies.join('; '));
  log.push('      landed: ' + p.url());
});
await step('service-listing', async () => {
  await p.goto('http://127.0.0.1:4174/book'); await p.getByRole('radio').first().waitFor(T);
  log.push('      services: ' + await p.getByRole('radio').count());
  await p.getByRole('radio').first().check();
});
await step('place-and-clinician-listing', async () => {
  await p.getByRole('button', { name: 'Continue' }).click(T);
  const place = p.getByLabel('Place'); await place.waitFor(T);
  const opts = await place.locator('option').allInnerTexts(); log.push('      places: ' + opts.join(' | '));
  await place.selectOption({ index: opts.length > 1 ? 1 : 0 }).catch(() => {});
  await p.getByLabel('Doctor').waitFor(T);
  log.push('      doctors: ' + (await p.getByLabel('Doctor').locator('option').allInnerTexts()).join(' | '));
});
await step('availability-search', async () => {
  await p.getByRole('button', { name: 'Continue' }).click(T);
  await p.getByRole('heading', { name: 'Choose a date and time' }).waitFor(T);
  await p.getByRole('button', { name: /\d{1,2}:\d\d [AP]M/ }).first().waitFor(T);
  log.push('      slot buttons: ' + await p.getByRole('button', { name: /\d{1,2}:\d\d [AP]M/ }).count());
});
await step('hold', async () => {
  await p.getByRole('button', { name: /\d{1,2}:\d\d [AP]M/ }).first().click(T);
  await p.getByRole('timer').waitFor(T); log.push('      timer: ' + await p.getByRole('timer').innerText());
});
await step('review', async () => { await p.getByRole('button', { name: 'Continue' }).click(T); await p.getByRole('heading', { name: 'Check and confirm' }).waitFor(T); });
await step('confirm', async () => { await p.getByRole('button', { name: 'Confirm appointment' }).click(T); await p.getByRole('heading', { name: 'Your appointment is booked' }).waitFor(T); });
await step('my-appointments', async () => {
  await p.goto('http://127.0.0.1:4174/appointments'); await p.getByRole('heading', { name: 'Your appointments' }).waitFor(T);
  await p.getByRole('button', { name: 'View details' }).first().waitFor(T);
  log.push('      appointments listed: ' + await p.getByRole('button', { name: 'View details' }).count());
});
console.log(log.join('\n') + '\n--- API calls seen by the browser ---\n' + calls.join('\n'));
await b.close();
process.exit(failed ? 1 : 0);
