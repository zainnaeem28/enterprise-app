import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createDirectoryClient } from './directory.js';
import { createSite } from './server.js';

const S = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const D = '33333333-3333-4333-8333-333333333333';
const NAME = 'Dr. Sample Doctor';

let apiUp = true;
let slot: unknown = { startsAt: '2026-11-10T14:00:00Z' };
let api: Server;
let site: Server;
let base = '';

const listen = (s: Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  api = createServer((q, r) => {
    const u = new URL(q.url ?? '/', 'http://x');
    if (!apiUp) return r.writeHead(503).end();
    r.setHeader('content-type', 'application/json');
    const send = (b: unknown, s = 200) => r.writeHead(s).end(JSON.stringify(b));
    if (u.pathname === '/public/v1/services')
      return send({
        items: [{ id: S, patientDisplayName: 'General visit', durationMin: 20, mode: 'in_person' }],
      });
    if (u.pathname === '/public/v1/locations')
      return send({
        items: [
          {
            id: L,
            name: 'Main Clinic',
            kind: 'clinic',
            timeZone: 'America/New_York',
            address: { line1: '1 Main St', city: 'Springfield' },
            stateCode: 'IL',
            geo: { lat: 39.8, lng: -89.6 },
            phone: '+1 555 0100',
          },
        ],
      });
    if (u.pathname === '/public/v1/clinicians')
      return send({ items: [{ clinicianId: D, displayName: NAME }] });
    if (u.pathname === `/public/v1/clinicians/${D}/next-available`) return send(slot);
    send({}, 404);
  });
  const apiPort = await listen(api);
  const config = loadConfig(
    {
      PUBLIC_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
      SITE_ORIGIN: 'https://www.example.org',
      PATIENT_ORIGIN: 'https://my.example.org',
      ANALYTICS_SRC: 'https://analytics.example.net/a.js',
    },
    '/nonexistent',
  );
  // ttl 0: every request reads the mock, so each test controls the answer
  site = createSite({
    config,
    client: createDirectoryClient({ baseUrl: config.publicApiOrigin, ttlMs: 0, staleMs: 0 }),
  });
  base = `http://127.0.0.1:${await listen(site)}`;
});
afterAll(() => {
  api.close();
  site.close();
});

const get = (p: string) => fetch(base + p);

describe('pages (TC-BS-01)', () => {
  it('services page lists the neutral service names', async () => {
    const r = await get('/services');
    const h = await r.text();
    expect(r.status).toBe(200);
    expect(h).toContain('<h1>Services</h1>');
    expect(h).toContain('General visit');
  });
  it('doctors page shows each doctor with the next available slot, and a Book link with opaque IDs', async () => {
    const h = await (await get('/doctors')).text();
    expect(h).toContain(NAME);
    expect(h).toContain('Next available:');
    expect(h).toMatch(/datetime="2026-11-10T14:00:00.000Z"/i);
    expect(h).toContain(`href="https://my.example.org/book?serviceId=${S}&amp;clinicianId=${D}"`);
  });
  it('doctor page has one Book per service and structured data', async () => {
    const h = await (await get(`/doctors/${D}`)).text();
    expect(h).toContain(`<h1>${NAME}</h1>`);
    expect(h).toContain('"@type":"Physician"');
    expect(h).toContain(`https://my.example.org/book?serviceId=${S}&amp;clinicianId=${D}`);
  });
  it('locations and contact pages show the address and phone', async () => {
    for (const p of ['/locations', '/contact']) {
      const h = await (await get(p)).text();
      expect(h).toContain('1 Main St');
      expect(h).toContain('href="tel:+15550100"');
    }
  });
  it('an unknown doctor is a 404 with noindex; a malformed id too', async () => {
    for (const p of [
      '/doctors/44444444-4444-4444-8444-444444444444',
      '/doctors/not-an-id',
      '/nope',
    ]) {
      const r = await get(p);
      expect(r.status).toBe(404);
      expect(await r.text()).toContain('noindex');
    }
  });
  it('shows a plain note, not an error, when the slot is unknown or absent', async () => {
    slot = { startsAt: null };
    expect(await (await get('/doctors')).text()).toContain('No online appointments are open');
    slot = 'garbage';
    expect(await (await get('/doctors')).text()).toContain('Availability can’t be shown');
    slot = { startsAt: '2026-11-10T14:00:00Z' };
  });
});

describe('SEO (TC-BS-05)', () => {
  it('every page has a distinct title, description and canonical', async () => {
    const titles = new Set<string>();
    for (const p of ['/', '/services', '/doctors', '/locations', '/contact']) {
      const h = await (await get(p)).text();
      const title = /<title>([^<]+)<\/title>/.exec(h)?.[1];
      expect(title).toBeTruthy();
      titles.add(title ?? '');
      expect(h).toMatch(/<meta name="description" content="[^"]+"/);
      expect(h).toContain(`<link rel="canonical" href="https://www.example.org${p}"`);
    }
    expect(titles.size).toBe(5);
  });
  it('structured data parses as JSON on every page that has it', async () => {
    for (const p of ['/', '/services', '/doctors', `/doctors/${D}`, '/locations', '/contact']) {
      const h = await (await get(p)).text();
      const blocks = [...h.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map(
        (m) => m[1] ?? '',
      );
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks)
        expect((JSON.parse(b) as { '@context': string })['@context']).toBe('https://schema.org');
    }
  });
  it('sitemap and robots', async () => {
    const x = await (await get('/sitemap.xml')).text();
    expect(x).toContain(`<loc>https://www.example.org/doctors/${D}</loc>`);
    expect(await (await get('/robots.txt')).text()).toContain(
      'Sitemap: https://www.example.org/sitemap.xml',
    );
  });
});

describe('privacy and headers', () => {
  it('no analytics script or host appears in any page before consent; the CSP names it for the later load', async () => {
    for (const p of ['/', '/doctors', `/doctors/${D}`]) {
      const r = await get(p);
      const h = await r.text();
      // The address is only data for the browser bundle; no tag, preload or inline code refers to the host.
      expect(h.replace(/data-analytics-src="[^"]*"/, '')).not.toContain('analytics.example.net');
      expect(h).toContain('data-analytics-src="https://analytics.example.net/a.js"');
      expect(r.headers.get('content-security-policy')).toContain(
        "script-src 'self' https://analytics.example.net",
      );
    }
  });
  it('pages never read or set cookies, and one cached copy fits everyone', async () => {
    const r = await fetch(`${base}/doctors`, {
      headers: { cookie: 'site_consent=all; sid=secret' },
    });
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(r.headers.get('vary')).toBeNull();
    expect(r.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=30');
    expect(await r.text()).not.toContain('secret');
  });
  it('security headers', async () => {
    const r = await get('/');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });
  it('only GET and HEAD; no path escape from the asset directory', async () => {
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
    expect((await get('/assets/..%2f..%2fpackage.json')).status).toBe(404);
  });
});

describe('directory down', () => {
  it('pages say so, are not cached, and a doctor URL is 503 rather than a cacheable 404', async () => {
    apiUp = false;
    const r = await get('/doctors');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).toContain('This list is not available right now');
    const d = await get(`/doctors/${D}`);
    expect(d.status).toBe(503);
    expect(d.headers.get('cache-control')).toBe('no-store');
    expect((await get('/sitemap.xml')).status).toBe(503);
    apiUp = true;
  });
});
