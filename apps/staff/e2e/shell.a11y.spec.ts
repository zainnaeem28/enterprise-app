import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Contract mock of GET /api/v1/auth/session (no real API is running in this check); labelled as such in the report.
const mockMe = (page: import('@playwright/test').Page, status: number, body: unknown) =>
  page.route('**/api/v1/auth/session', async (route) => {
    expect(route.request().headers()['x-client-release']).toMatch(/^r[1-9][0-9]*\.[0-9a-f]{12}$/);
    await route.fulfill({
      status,
      contentType: status === 200 ? 'application/json' : 'application/problem+json',
      body: JSON.stringify(body),
    });
  });

test('built shell has no serious or critical axe violations', async ({ page }) => {
  await mockMe(page, 401, { status: 401, code: 'auth.unauthenticated', requestId: 'req-1' });
  await page.goto('/');
  await expect(page.getByText('You are not signed in')).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
});

test('blocking release dialog is accessible', async ({ page }) => {
  await mockMe(page, 400, {
    status: 400,
    code: 'kernel.client_release_unsupported',
    requestId: 'req-2',
  });
  await page.goto('/');
  await expect(page.getByRole('alertdialog')).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
});

test('non-blocking release bar is accessible', async ({ page }) => {
  await mockMe(page, 401, { status: 401, code: 'auth.unauthenticated' });
  await page.route('**/release.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ release_number: 99 }),
    }),
  );
  await page.goto('/');
  await expect(
    page.getByRole('status').filter({ hasText: 'A new version is available' }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
});
