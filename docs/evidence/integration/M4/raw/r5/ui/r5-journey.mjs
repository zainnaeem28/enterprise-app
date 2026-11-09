// r5 patient-portal M4 journey (Chromium, real API+worker processes, built patient app). usage: node r5-journey.mjs <root> <outDir>
import { createRequire } from 'node:module';
const [root, out] = process.argv.slice(2);
const { chromium } = createRequire(root + '/apps/patient/package.json')('@playwright/test');
const B = 'http://127.0.0.1:4574';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
const calls = [], log = [];
p.on('response', async (r) => { const u = new URL(r.url()); if (!u.pathname.startsWith('/api/')) return; calls.push(`${r.request().method()} ${u.pathname} -> ${r.status()}`); });
const text = async () => (await p.innerText('body')).replace(/\s+/g, ' ').slice(0, 300);
let n = 0;
async function step(name, fn) {
  const m = calls.length;
  try { await fn(); await p.waitForLoadState('networkidle'); log.push(`PASS  ${name} | ${calls.slice(m).join(' ; ')}`); log.push('      page: ' + await text()); await p.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true }); }
  catch (e) { log.push(`FAIL  ${name}: ${e.message.split('\n')[0]} | ${calls.slice(m).join(' ; ')}`); log.push('      url: ' + p.url() + ' page: ' + await text()); await p.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-FAILED-${name}.png`, fullPage: true }).catch(() => {}); }
}
const T = { timeout: 15000 };
await step('landing', async () => { await p.goto(B + '/'); });
await step('sign-in', async () => {
  await p.getByRole('button', { name: /sign in/i }).or(p.getByRole('link', { name: /sign in/i })).first().click(T);
  const c = p.getByRole('button', { name: /continue/i }).or(p.getByRole('link', { name: /continue/i }));
  if (await c.count()) await c.first().click(T);
  await p.waitForURL((u) => u.port === '4574' && !u.pathname.startsWith('/continue'), T);
  await p.waitForResponse((r) => /auth\/session/.test(r.url()) && r.status() === 200, T).catch(() => {}); await p.waitForTimeout(1500);
});
for (const [name, path] of [['profile', '/profile'], ['profile-notifications', '/profile/notifications'], ['messages-list', '/messages'], ['messages-new', '/messages/new'], ['privacy', '/privacy'], ['appointments', '/appointments']])
  await step(name, async () => { await p.goto(B + path); await p.waitForTimeout(2500); });
await step('messages-send', async () => {
  await p.goto(B + '/messages/new');
  const f = p.locator('textarea, input[type=text]');
  const k = await f.count(); log.push('      fields on new-message form: ' + k);
  for (let i = 0; i < k; i++) await f.nth(i).fill('Synthetic integration check message');
  await p.getByRole('button', { name: /send|submit/i }).first().click(T);
  await p.waitForTimeout(1500);
});
await step('messages-list-after', async () => { await p.goto(B + '/messages'); });
await b.close();
(await import('node:fs')).writeFileSync(out + '/journey-run.txt', log.join('\n') + '\n\nAPI CALLS\n' + calls.join('\n') + '\n');
console.log(log.join('\n'));
