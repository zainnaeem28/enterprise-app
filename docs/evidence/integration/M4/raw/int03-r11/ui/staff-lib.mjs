// shared helpers for the r10 staff journeys. usage in a script: const h = await open(root, out, tag, {sub,email})
import { createRequire } from 'node:module'; import { writeFileSync } from 'node:fs';
export const BASE = 'http://localhost:4675';
export async function open(root, out, tag, who) {
  const { chromium } = createRequire(root + '/apps/staff/package.json')('@playwright/test');
  await fetch(`http://127.0.0.1:9301/next?sub=${who.sub}&email=${who.email}`, { method: 'POST' });
  const b = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--in-process-gpu', '--no-zygote', '--disable-dev-shm-usage', '--disable-features=Vulkan,VizDisplayCompositor'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const calls = [], log = []; let n = 0;
  p.on('response', async (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && r.status() >= 400) calls.push(`ERRBODY ${r.status()} ${u.pathname}: ${(await r.text().catch(() => '')).slice(0, 300)}`); if (u.pathname.startsWith('/api/')) calls.push(`${r.request().method()} ${u.pathname} -> ${r.status()}`); });
  const text = async () => (await p.innerText('body', { timeout: 8000 }).catch((e) => '(no text)')).replace(/\s+/g, ' ');
  const step = async (name, fn, keep = 400) => {
    const m = calls.length; let res = 'PASS';
    try { await fn(); await p.waitForLoadState('networkidle').catch(() => {}); } catch (e) { res = 'FAIL ' + e.message.split('\n')[0]; }
    const t = await text();
    log.push(`${res} ${name} | ${p.url()} | api: ${calls.slice(m).filter((c) => !/auth\/session/.test(c)).join(' ; ')}\n      page: ${t.slice(0, keep)}`);
    await p.screenshot({ path: `${out}/${tag}-${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true });
    return t;
  };
  const finish = async () => { writeFileSync(`${out}/${tag}-run.txt`, log.join('\n') + '\n\nAPI CALLS\n' + calls.join('\n') + '\n'); console.log(log.join('\n')); await b.close(); };
  return { b, p, step, finish, calls };
}
export async function signIn(h) {
  await h.step('sign-in', async () => { await h.p.goto(BASE + '/api/v1/auth/sign-in'); await h.p.waitForTimeout(4000); });
}
