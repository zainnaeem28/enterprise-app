import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { IDS } from './ids.mjs';

// Runs against the BUILT site server with a CONTRACT MOCK of the public directory (e2./ids.mjs). The real API is not exercised.
const PAGES = [
  '/',
  '/services',
  '/doctors',
  `/doctors/${IDS.doctor}`,
  '/locations',
  '/contact',
  '/legal/privacy',
  '/legal/cookies',
  '/nope',
];

test('TC-BS-01 pages for services, doctors with next slot, locations and contact', async ({
  page,
}) => {
  await page.goto('/services');
  await expect(page.getByRole('heading', { level: 1, name: 'Services' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'General visit' })).toBeVisible();
  await page.goto('/doctors');
  await expect(page.getByText('Dr. Sample Doctor').first()).toBeVisible();
  await expect(page.getByText(/Next available:/).first()).toBeVisible();
  await page.goto('/locations');
  await expect(page.getByText('1 Main St')).toBeVisible();
  await page.goto('/contact');
  await expect(page.getByRole('heading', { level: 1, name: 'Contact' })).toBeVisible();
  await expect(page.getByText('Main Clinic')).toBeVisible();
});

test('TC-BS-02 Book hands off to my. with service and doctor as opaque IDs only', async ({
  page,
}) => {
  await page.route('http://127.0.0.1:4323/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>patient</h1>' }),
  );
  await page.goto(`/doctors/${IDS.doctor}`);
  await page.getByRole('link', { name: 'Book General visit' }).click();
  await page.waitForURL('http://127.0.0.1:4323/book?**');
  const u = new URL(page.url());
  expect([...u.searchParams.keys()].sort()).toEqual(['clinicianId', 'serviceId']);
  expect(u.searchParams.get('serviceId')).toBe(IDS.service);
  expect(u.searchParams.get('clinicianId')).toBe(IDS.doctor);
});

async function analyticsRequests(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith('http://127.0.0.1:4322')) seen.push(r.url());
  });
  return seen;
}

test('TC-BS-08 no analytics before consent; essential only keeps it off; choice is remembered', async ({
  page,
}) => {
  const seen = await analyticsRequests(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Essential only' })).toBeVisible();
  await page.getByRole('link', { name: 'Services' }).first().click();
  await page.waitForLoadState('networkidle');
  expect(seen).toEqual([]);
  await page.getByRole('button', { name: 'Essential only' }).click();
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: 'Essential only' })).toHaveCount(0);
  expect(seen).toEqual([]);
});

test('TC-BS-08/04 accept all loads analytics; events carry only the page template, no names or IDs', async ({
  page,
}) => {
  const seen = await analyticsRequests(page);
  await page.goto(`/doctors/${IDS.doctor}`);
  expect(seen).toEqual([]);
  await page.getByRole('button', { name: 'Accept all' }).click();
  await page.waitForFunction(
    () => (window as unknown as { __analyticsLoaded?: boolean }).__analyticsLoaded === true,
  );
  expect(seen).toEqual(['http://127.0.0.1:4322/analytics.js']);
  await page
    .getByRole('link', { name: 'Book General visit' })
    .evaluate((a) => a.addEventListener('click', (e) => e.preventDefault()));
  await page.getByRole('link', { name: 'Book General visit' }).click();
  const layer = await page.evaluate(
    () => (window as unknown as { dataLayer: unknown[] }).dataLayer,
  );
  expect(layer).toEqual([
    { event: 'page_view', template: 'doctor-profile' },
    { event: 'book_click', template: 'doctor-profile' },
  ]);
  const payload = JSON.stringify(layer);
  for (const forbidden of ['Sample', 'General', IDS.doctor, IDS.service, 'Main Clinic'])
    expect(payload).not.toContain(forbidden);
  // remembered across a reload: analytics load again without asking
  await page.reload();
  await page.waitForFunction(
    () => (window as unknown as { __analyticsLoaded?: boolean }).__analyticsLoaded === true,
  );
  await expect(page.getByRole('button', { name: 'Accept all' })).toHaveCount(0);
  // changing the choice from the footer turns it off again
  await page.getByRole('button', { name: 'Cookie settings' }).click();
  await page.getByRole('button', { name: 'Essential only' }).click();
  expect(
    await page.evaluate(() => (window as unknown as { dataLayer: unknown[] }).dataLayer),
  ).toEqual([]);
});

test('TC-BS-05 sitemap, robots, titles, descriptions and structured data', async ({
  page,
  request,
}) => {
  const sitemap = await (await request.get('/sitemap.xml')).text();
  expect(sitemap).toContain(`/doctors/${IDS.doctor}</loc>`);
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Sitemap: http://127.0.0.1:4320/sitemap.xml');
  const titles = new Set<string>();
  for (const p of ['/', '/services', '/doctors', '/locations', '/contact']) {
    await page.goto(p);
    const title = await page.title();
    expect(title.length).toBeGreaterThan(5);
    titles.add(title);
    expect(await page.locator('meta[name=description]').getAttribute('content')).toBeTruthy();
    expect(await page.locator('link[rel=canonical]').getAttribute('href')).toBe(
      `http://127.0.0.1:4320${p}`,
    );
  }
  expect(titles.size).toBe(5);
  const types = async (p: string) => {
    await page.goto(p);
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    return blocks.map((b) => JSON.parse(b) as { '@type': string });
  };
  expect((await types(`/doctors/${IDS.doctor}`)).map((d) => d['@type'])).toContain('Physician');
  expect((await types('/services')).map((d) => d['@type'])).toContain('ItemList');
  expect((await types('/locations')).map((d) => d['@type'])).toContain('MedicalClinic');
});

test('TC-BS-07 no language switch', async ({ page }) => {
  for (const p of PAGES.slice(0, 6)) {
    await page.goto(p);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('link', { name: /español|language|idioma/i })).toHaveCount(0);
  }
});

test('not found returns 404 and noindex', async ({ request }) => {
  const res = await request.get('/nope');
  expect(res.status()).toBe(404);
  expect(await res.text()).toContain('noindex');
});

for (const [name, size] of [
  ['desktop', { width: 1280, height: 900 }],
  ['phone-320', { width: 320, height: 640 }],
] as const) {
  test(`axe: no violations on every page, banner open, ${name}`, async ({ page }) => {
    await page.setViewportSize(size);
    for (const p of PAGES) {
      await page.goto(p);
      await expect(page.getByRole('button', { name: 'Accept all' })).toBeVisible();
      const r = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(r.violations, `${p} ${name}`).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${p} horizontal overflow`).toBeLessThanOrEqual(0);
    }
  });
}
