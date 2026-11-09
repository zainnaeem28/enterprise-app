// What a staff user gets from the SHIPPED staff build (apps/staff/dist, entry main.tsx). usage: node staff-shipped.mjs <root> <outDir> [base=http://localhost:4675]
import { createRequire } from 'node:module'; import { writeFileSync } from 'node:fs';
const [root, out, base = 'http://localhost:4675'] = process.argv.slice(2);
const { chromium } = createRequire(root + '/apps/staff/package.json')('@playwright/test');
const b = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox', '--disable-gpu'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const calls = [], log = []; p.on('response', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) calls.push(`${r.request().method()} ${u.pathname} -> ${r.status()}`); });
const tag = process.argv[5] ?? 'staff-shipped'; let n = 0;
const shot = async (name) => { const t = (await p.innerText('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 300); log.push(`${name} | ${p.url()} | ${t}`); await p.screenshot({ path: `${out}/${tag}-${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true }); };
await p.goto(base + '/'); await p.waitForTimeout(3000); await shot('landing');
await p.goto(base + '/api/v1/auth/sign-in'); await p.waitForTimeout(4000); await shot('after-sign-in');
for (const path of (process.env.PATHS ?? '/schedule,/tasks,/arrivals,/messages').split(',')) { await p.goto(base + path); await p.waitForTimeout(3000); await shot('path' + path.replace(/\//g, '-')); }
writeFileSync(`${out}/${tag}-run.txt`, log.join('\n') + '\n\nAPI CALLS\n' + calls.join('\n') + '\n'); console.log(log.join('\n')); await b.close();
