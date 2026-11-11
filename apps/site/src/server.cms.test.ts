import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCmsContent } from './cms-content.js';
import { loadConfig } from './config.js';
import { createDirectoryClient } from './directory.js';
import { createSite } from './server.js';

// The site server with the ContentSource served by a fake CMS over HTTP (the real CMS schema is exercised in apps/cms,
// src/seed/contentsource.dbtest.ts). Proves: facts appear only when entered; nothing invented otherwise; degraded = no-store.
const FRESH_CACHE = 'public, max-age=60, stale-while-revalidate=30, stale-if-error=300';
let cmsState: { site: unknown; org: unknown; down: boolean } = { site: {}, org: {}, down: false };
let cms: Server;
let api: Server;
let site: Server;
let base = '';
const listen = (s: Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  cms = createServer((q, r) => {
    if (cmsState.down) return r.writeHead(503).end();
    const body = q.url?.startsWith('/api/globals/organisation') ? cmsState.org : cmsState.site;
    r.setHeader('content-type', 'application/json').end(JSON.stringify(body));
  });
  api = createServer((_q, r) => r.writeHead(503).end());
  const cmsPort = await listen(cms);
  const apiPort = await listen(api);
  const config = loadConfig(
    {
      PUBLIC_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
      SITE_ORIGIN: 'https://www.example.org',
      PATIENT_ORIGIN: 'https://my.example.org',
      CMS_ORIGIN: `http://127.0.0.1:${cmsPort}`,
    },
    '/nonexistent',
  );
  expect(config.cmsOrigin).toBe(`http://127.0.0.1:${cmsPort}`);
  site = createSite({
    config,
    client: createDirectoryClient({ baseUrl: config.publicApiOrigin, ttlMs: 0, staleMs: 0 }),
    contentProvider: createCmsContent({ baseUrl: config.cmsOrigin!, ttlMs: 0, staleMs: 0 }),
  });
  base = `http://127.0.0.1:${await listen(site)}`;
});
afterAll(() => {
  cms.close();
  api.close();
  site.close();
});

describe('site with CMS-backed ContentSource', () => {
  it('organisation not entered: no name, address, phone, e-mail, hours or team, and no placeholder in their place', async () => {
    cmsState = { site: {}, org: {}, down: false };
    for (const p of ['/', '/about', '/contact', '/legal/privacy']) {
      const h = await (await fetch(base + p)).text();
      expect(h, p).not.toMatch(/\[Product name\]|Phone:|Email:|Hours:|Address:|Our team|mailto:/);
      expect(h, p).not.toContain('og:site_name');
      expect(h, p).not.toContain('©');
    }
    const about = await (await fetch(base + '/about')).text();
    expect(about).toContain('<h1>About</h1>');
    expect(about).not.toContain('"worksFor"');
  });

  it('shows CMS text and the organisation facts that were entered, and only those', async () => {
    cmsState = {
      site: { home: { heading: 'Welcome from the CMS' } },
      org: {
        name: 'Example Practice',
        address: '1 Example Street\nSpringfield',
        phone: '+1 555 0100',
        clinicians: [{ name: 'Dr. Sample Doctor', title: 'Physician' }],
      },
      down: false,
    };
    const home = await fetch(base + '/');
    expect(await home.text()).toContain('Welcome from the CMS');
    expect((await fetch(base + '/legal/terms')).headers.get('cache-control')).toBe(FRESH_CACHE);
    const about = await (await fetch(base + '/about')).text();
    expect(about).toContain('<h1>About Example Practice</h1>');
    expect(about).toContain('Our team');
    expect(about).toContain('Dr. Sample Doctor');
    const contact = await (await fetch(base + '/contact')).text();
    expect(contact).toContain('1 Example Street');
    expect(contact).toContain('Phone: +1 555 0100');
    expect(contact).not.toContain('Email:');
    expect(contact).not.toContain('Hours:');
    expect(contact).toContain('<title>Contact – Example Practice</title>');
  });

  it('CMS down: static reviewed copy, no organisation facts, never cached by a CDN', async () => {
    cmsState = { site: {}, org: {}, down: true };
    const r = await fetch(base + '/legal/privacy');
    const h = await r.text();
    expect(r.status).toBe(200);
    expect(h).toContain('This public website does not ask for or store health information.');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const contact = await (await fetch(base + '/contact')).text();
    expect(contact).not.toMatch(/Phone:|Email:|Hours:|Address:/);
  });
});
