// Browser tooling smoke: serve a built SPA (vite preview) on a private port and screenshot routes.
// Usage: node scripts/ci/browser-smoke.mjs <app-dir> <out-dir> <port> <route>...
// Needs the browser from scripts/ci/install-browser.sh (PLAYWRIGHT_BROWSERS_PATH, LD_LIBRARY_PATH).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const [app, out, port, ...routes] = process.argv.slice(2);
if (!app || !out || !port || routes.length === 0) {
  console.error('usage: browser-smoke.mjs <app-dir> <out-dir> <port> <route>...');
  process.exit(2);
}
const { chromium } = createRequire(`${process.cwd()}/${app}/package.json`)('@playwright/test');
mkdirSync(out, { recursive: true });
const srv = spawn(
  'pnpm',
  ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'],
  { cwd: app, stdio: 'ignore' },
);
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  console.log(`chromium ${b.version()}`);
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  for (const r of routes) {
    const res = await p.goto(base + r);
    await p.waitForLoadState('networkidle').catch(() => {});
    const file = `${out}/${r.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root'}.png`;
    await p.screenshot({ path: file, fullPage: true });
    console.log(`${res?.status()} ${r} -> ${file} title=${JSON.stringify(await p.title())}`);
  }
  await b.close();
} finally {
  srv.kill();
}
