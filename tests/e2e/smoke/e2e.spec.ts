// e2e-smoke (DEVOPS-PLAN 5.1 "Browser end-to-end smoke", PR subset): journeys of the BUILT staff shell in Chromium against
// the real API process behind the same-origin proxy (no CORS), plus contract mocks for states the API cannot yet produce.
// A suite that finds no test, or skips one, fails (check-report.mjs and Playwright's own empty-suite exit).
import { expect, test } from '@playwright/test';

const RELEASE_HEADER = /^r[1-9][0-9]*\.[0-9a-f]{12}$/;

test('shell loads on one origin: no console error, no failed request, nothing sent to a third party', async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? 'http://127.0.0.1:4173').origin;
  const errors: string[] = [];
  const foreign: string[] = [];
  const failed: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!r.url().startsWith('data:') && new URL(r.url()).origin !== origin) foreign.push(r.url());
  });
  page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()}`));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff portal' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Server connection' })).toBeVisible();
  // The call is answered by the real API: any definite answer ends the "Checking" state.
  await expect(page.getByText('Checking the server…')).toBeHidden();
  // 4xx answers are logged by the browser as console errors; only script errors count here.
  expect(
    errors.filter((e) => !/Failed to load resource/.test(e)),
    'script errors',
  ).toEqual([]);
  expect(
    foreign,
    'requests to another origin (NFR-18: no third-party or analytics calls from a PHI origin)',
  ).toEqual([]);
  expect(failed, 'failed requests').toEqual([]);
});

test('every /api call sends X-Client-Release and reaches the real API', async ({ page }) => {
  const seen: Array<{ url: string; release: string | undefined; status: number }> = [];
  page.on('response', (res) => {
    const u = new URL(res.url());
    if (u.pathname.startsWith('/api/'))
      seen.push({
        url: u.pathname,
        release: res.request().headers()['x-client-release'],
        status: res.status(),
      });
  });
  await page.goto('/');
  await expect(page.getByText('Checking the server…')).toBeHidden();
  expect(seen.length, 'the shell made no /api call').toBeGreaterThan(0);
  for (const s of seen) {
    expect(s.release, `X-Client-Release on ${s.url}`).toMatch(RELEASE_HEADER);
    expect(s.status, `${s.url} must not be a 5xx from the real API`).toBeLessThan(500);
  }
});

test('"Check again" repeats the call once per activation and is keyboard-operable', async ({
  page,
}) => {
  let calls = 0;
  await page.route('**/api/v1/auth/session', (r) => {
    calls++;
    return r.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: JSON.stringify({ status: 401, code: 'auth.unauthenticated', requestId: 'req-smoke' }),
    });
  });
  await page.goto('/');
  await expect(page.getByText('You are not signed in')).toBeVisible();
  expect(calls).toBe(1);
  const button = page.getByRole('button', { name: 'Check again' });
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => calls).toBe(2);
  await page.waitForTimeout(1500);
  expect(calls, 'no timer-driven polling of the session').toBe(2);
});

test('a refused client release opens the blocking dialog and focus moves into it', async ({
  page,
}) => {
  await page.route('**/api/v1/auth/session', (r) =>
    r.fulfill({
      status: 400,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        status: 400,
        code: 'kernel.client_release_unsupported',
        requestId: 'req-smoke',
      }),
    }),
  );
  await page.goto('/');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(':focus')).toHaveCount(1);
});

test('a newer release on release.json shows the non-blocking bar', async ({ page }) => {
  await page.route('**/api/v1/auth/session', (r) =>
    r.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: JSON.stringify({ status: 401, code: 'auth.unauthenticated' }),
    }),
  );
  await page.route('**/release.json', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ release_number: 99 }) }),
  );
  await page.goto('/');
  await expect(
    page.getByRole('status').filter({ hasText: 'A new version is available' }),
  ).toBeVisible();
});

test('security baseline on the built shell: skip link first, document language and title set', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', /^[a-z]{2}/);
  await expect(page).toHaveTitle(/\S/);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
});
