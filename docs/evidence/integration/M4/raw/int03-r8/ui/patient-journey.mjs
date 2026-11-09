// r8 patient-portal M4 journey re-run (Chromium, real API+worker processes, built patient app). usage: node r5-journey.mjs <root> <outDir>
import { createRequire } from 'node:module';
const [root, out] = process.argv.slice(2);
const { chromium } = createRequire(root + '/apps/patient/package.json')('@playwright/test');
const B = 'http://127.0.0.1:4674';
const b = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox','--disable-gpu','--in-process-gpu','--no-zygote','--disable-dev-shm-usage','--disable-features=Vulkan,VizDisplayCompositor'], logger: { isEnabled: () => true, log: (nm, sv, m) => { if (/crash|SIGSEGV|killed|exit|ENOSPC|error/i.test(String(m))) console.error('BL', String(m).slice(0, 200)); } } });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage(); p.on('crash', () => console.log('PAGE CRASH')); b.on('disconnected', () => console.log('BROWSER DISCONNECTED'));
const calls = [], log = [];
p.on('response', async (r) => { const u = new URL(r.url()); if (!u.pathname.startsWith('/api/')) return; calls.push(`${r.request().method()} ${u.pathname} -> ${r.status()}`); });
const text = async () => { try { return (await p.innerText('body', {timeout: 8000})).replace(/\s+/g, ' ').slice(0, 300); } catch (e) { return '(no text: ' + e.message.split('\n')[0] + ')'; } };
let n = 0;
async function step(name, fn) {
  const m = calls.length;
  try { await fn(); await p.waitForLoadState('networkidle'); log.push(`PASS  ${name} | ${calls.slice(m).join(' ; ')}`); log.push('      page: ' + await text()); await p.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true }); }
  catch (e) { log.push(`FAIL  ${name}: ${e.message.split('\n')[0]} | ${calls.slice(m).join(' ; ')}`); log.push('      url: ' + p.url() + ' page: ' + await text()); await p.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-FAILED-${name}.png`, fullPage: true }).catch(() => {}); }
}
const T = { timeout: 15000 };
await step('landing', async () => { await p.goto(B + '/'); await p.waitForTimeout(6000); });
await step('sign-in', async () => {
  await p.getByRole('button', { name: /sign in/i }).or(p.getByRole('link', { name: /sign in/i })).first().click(T);
  const c = p.getByRole('button', { name: /continue/i }).or(p.getByRole('link', { name: /continue/i }));
  if (await c.count()) await c.first().click(T);
  await p.waitForURL((u) => u.port === '4674' && !u.pathname.startsWith('/continue'), T);
  await p.waitForResponse((r) => /auth\/session/.test(r.url()) && r.status() === 200, T).catch(() => {}); await p.waitForTimeout(1500);
});
for (const [name, path] of [['profile', '/profile'], ['profile-notifications', '/profile/notifications'], ['messages-list', '/messages'], ['messages-new', '/messages/new'], ['privacy', '/privacy'], ['appointments', '/appointments']])
  await step(name, async () => { await p.goto(B + path); await p.waitForTimeout(2500); });
await step('privacy-request-copy', async () => {
  await p.goto(B + '/privacy'); await p.waitForTimeout(2000);
  await p.getByRole('button', { name: /request a copy of my data/i }).click(T);
  await p.getByRole('alertdialog').waitFor(T);
  await p.screenshot({ path: `${out}/privacy-confirm-dialog.png`, fullPage: true });
  await p.getByRole('alertdialog').getByRole('button', { name: 'Request my data' }).click(T);
  await p.waitForTimeout(3000);
});
await step('privacy-after-worker-wait', async () => { await p.waitForTimeout(8000); await p.reload(); await p.waitForTimeout(2500); });
await b.close();
(await import('node:fs')).writeFileSync(out + '/journey-run.txt', log.join('\n') + '\n\nAPI CALLS\n' + calls.join('\n') + '\n');
console.log(log.join('\n'));
