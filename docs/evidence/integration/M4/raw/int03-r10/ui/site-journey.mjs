// Brand site (apps/site, FE-15 a1953ec merged). usage: node site-journey.mjs <root> <outDir> <base> <tag>
import { createRequire } from 'node:module'; import { writeFileSync } from 'node:fs';
const [root, out, base, tag] = process.argv.slice(2);
const { chromium } = createRequire(root + '/apps/site/package.json')('@playwright/test');
const b = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const log = []; let n = 0;
for (const path of ['/', '/about', '/services', '/doctors', '/locations', '/contact']) {
  const r = await p.goto(base + path); await p.waitForTimeout(1200);
  const t = (await p.innerText('body')).replace(/\s+/g, ' ').slice(0, 260);
  log.push(`${r.status()} ${path} | ${t}`);
  await p.screenshot({ path: `${out}/${tag}-${String(++n).padStart(2, '0')}${path === '/' ? '-home' : path.replace('/', '-')}.png`, fullPage: true });
}
await p.goto(base + '/'); const links = await p.$$eval('a', (as) => as.map((a) => a.getAttribute('href')).filter((h) => /book|:4674/.test(h ?? '')));
log.push('book/hand-off links on home: ' + JSON.stringify(links.slice(0, 5)));
await p.goto(base + '/doctors'); const bl = await p.$$eval('a', (as) => as.map((a) => a.getAttribute('href')).filter((h) => /book/.test(h ?? '')));
log.push('book links on /doctors: ' + JSON.stringify(bl.slice(0, 3)));
for (const f of ['/robots.txt', '/sitemap.xml', '/healthz']) { const r = await p.request.get(base + f); log.push(`${r.status()} ${f} ${(await r.text()).replace(/\s+/g, ' ').slice(0, 160)}`); }
writeFileSync(`${out}/${tag}-run.txt`, log.join('\n') + '\n'); console.log(log.join('\n')); await b.close();
