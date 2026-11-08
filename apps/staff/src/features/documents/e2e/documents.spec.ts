import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// CONTRACT MOCK of documents.yaml. No real API, object store, scanner or database runs in this check; the real journey
// is exercised only after integration. The mock lets a test move the scan state by hand.
const PATIENT = '22222222-2222-4222-8222-222222222222';
const DOC = '99999999-9999-4999-8999-999999999991';
const ALL = 'documents.read,documents.upload,documents.classify';
const shot = (name: string) =>
  fileURLToPath(new URL(`../evidence/screenshots/${name}.png`, import.meta.url));

const doc = (over: Record<string, unknown> = {}) => ({
  id: DOC,
  patientId: PATIENT,
  classification: 'insurance_card',
  suggestedClassification: 'id_document',
  status: 'clean',
  uploadChannel: 'staff',
  uploadedAt: new Date(Date.now() - 3600_000).toISOString(),
  confirmedAt: null,
  contentType: 'application/pdf',
  sizeBytes: 123_456,
  onLegalHold: false,
  ...over,
});

interface Mock {
  docs: Record<string, unknown>[];
  seen: string[];
}

async function mockApi(page: Page, docs: Record<string, unknown>[]): Promise<Mock> {
  const mock: Mock = { docs, seen: [] };
  const reply = (
    route: Route,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    route.fulfill({
      status,
      contentType: status >= 400 ? 'application/problem+json' : 'application/json',
      headers: {
        'x-session-idle-expires-at': new Date(Date.now() + 30 * 60_000).toISOString(),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  await page
    .context()
    .route('https://objects.test/**', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    mock.seen.push(`${req.method()} ${path}`);
    expect(req.headers()['x-client-release']).toMatch(/^r[1-9][0-9]*\.[0-9a-f]{12}$/);
    if (req.method() === 'GET' && path.endsWith('/documents'))
      return reply(route, 200, { items: mock.docs, nextCursor: null });
    if (path.endsWith('/document-uploads'))
      return reply(route, 201, {
        documentId: DOC,
        uploadUrl: 'https://objects.test/q/abc?sig=1',
        uploadHeaders: { 'Content-Type': 'application/pdf' },
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    if (path.endsWith('/complete')) {
      mock.docs = [doc({ status: 'scanning', suggestedClassification: null })];
      return reply(route, 202, { status: 'scanning' });
    }
    if (path.endsWith('/download-url'))
      return reply(route, 200, {
        url: 'https://objects.test/c/abc?sig=2',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    if (req.method() === 'PUT' && path.endsWith('/classification')) {
      mock.docs = [doc({ classification: JSON.parse(req.postData() ?? '{}').classification })];
      return reply(route, 200, mock.docs[0], { etag: 'W/"3"' });
    }
    if (path.endsWith('/confirm')) {
      mock.docs = [doc({ status: 'confirmed', confirmedAt: new Date().toISOString() })];
      return reply(route, 200, mock.docs[0], { etag: 'W/"4"' });
    }
    return reply(route, 404, { code: 'kernel.not_found' });
  });
  return mock;
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
}

test('staff upload shows progress, then scanning; the file cannot be opened until clean; classification is confirmed', async ({
  page,
}, info) => {
  const mock = await mockApi(page, []);
  await page.goto(`/?perms=${ALL}`);
  await expect(page.getByText('No documents yet.')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-1-empty`), fullPage: true });

  await page.getByLabel('Document type').selectOption('insurance_card');
  await page
    .getByLabel('Choose a file')
    .setInputFiles({ name: 'card.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2048) });
  const row = page.getByRole('listitem').filter({ hasText: 'Scanning' });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: /open/i })).toHaveCount(0);
  await expect(row.getByText(/cannot be opened until the scan finishes clean/i)).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-2-scanning`), fullPage: true });

  // The scanner finishes (moved by hand in this mock); the list refreshes by itself.
  mock.docs = [doc()];
  await expect(page.getByText('Needs classification')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/suggested by text recognition/i)).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-3-clean-confirm`), fullPage: true });

  await page.getByLabel('Classification', { exact: true }).selectOption('id_document');
  await page.getByRole('button', { name: /^confirm classification/i }).click();
  await expect(page.getByText(/^Confirmed/).first()).toBeVisible();
  expect(mock.seen).toContain(`PUT /api/v1/documents/${DOC}/classification`);
  expect(mock.seen).toContain(`POST /api/v1/documents/${DOC}/confirm`);
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-4-confirmed`), fullPage: true });

  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: /open/i }).click();
  const opened = await popup;
  await opened.waitForURL(/https:\/\/objects\.test\/c\/abc/);
});

test('a quarantined file shows its reason and cannot be opened', async ({ page }, info) => {
  await mockApi(page, [doc({ status: 'quarantined', suggestedClassification: null })]);
  await page.goto(`/?perms=${ALL}`);
  await expect(page.locator('.ehr-chip', { hasText: 'Blocked' })).toBeVisible();
  await expect(page.getByText(/did not pass the safety scan/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /open/i })).toHaveCount(0);
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-5-quarantined`), fullPage: true });
});

test('a reader sees the list without upload or confirm controls', async ({ page }, info) => {
  await mockApi(page, [doc()]);
  await page.goto('/?perms=documents.read');
  await expect(page.getByText(/permission to upload/i)).toBeVisible();
  await expect(page.getByLabel('Choose a file')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /confirm classification/i })).toHaveCount(0);
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-6-reader`), fullPage: true });
});
