// e2e-smoke (DEVOPS-PLAN 5.1 "Browser end-to-end smoke", PR subset): journeys of the BUILT staff shell in Chromium against
// the real API process behind the same-origin proxy (no CORS), plus contract mocks for states the API cannot yet produce.
// HEAAA-639: rewritten for the real staff shell (sign-in redirect, session gate, shared release prompts); the old placeholder
// connection page no longer exists.
// A suite that finds no test, or skips one, fails (check-report.mjs and Playwright's own empty-suite exit).
import { expect, test, type Page, type Route } from '@playwright/test';

const RELEASE_HEADER = /^r[1-9][0-9]*\.[0-9a-f]{12}$/;

const SESSION = {
  principalId: '11111111-1111-4111-8111-111111111111',
  realm: 'google',
  audience: 'staff',
  displayName: 'Dr Smoke',
  csrfToken: 'csrf-smoke',
  roles: [{ key: 'doctor', locationId: '22222222-2222-4222-8222-222222222222' }],
  permissions: [],
  patients: [],
};

/** A signed-in staff session; every other /api call the shell makes answers an empty list or 404 (this suite checks the shell, not the clinical pages). */
async function signedIn(page: Page, banners?: (r: Route) => Promise<void>) {
  await page.route('**/api/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/v1/auth/session')
      return r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ...SESSION,
          idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        }),
      });
    if (path === '/api/v1/banners') {
      if (banners) return banners(r);
      return r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
    }
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

test('shell loads on one origin: signed out goes to sign-in, no script error, no failed request, nothing sent to a third party', async ({
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
  // The real API answers the session read with 401; the shell sends the person to the sign-in screen.
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Sign in to the staff portal' }),
  ).toBeVisible();
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
  await expect(page).toHaveURL(/\/sign-in/);
  expect(seen.length, 'the shell made no /api call').toBeGreaterThan(0);
  for (const s of seen) {
    expect(s.release, `X-Client-Release on ${s.url}`).toMatch(RELEASE_HEADER);
    expect(s.status, `${s.url} must not be a 5xx from the real API`).toBeLessThan(500);
  }
});

test('a failed roles read shows a retry button that repeats the reads once per activation, with no timer polling', async ({
  page,
}) => {
  // One page load reads the session twice (identity, then roles). The second read returns no body: a failed read, not "no roles".
  let calls = 0;
  await page.route('**/api/v1/auth/session', (r) => {
    calls++;
    if (calls % 2 === 0) return r.fulfill({ status: 204 });
    return r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...SESSION,
        idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    });
  });
  await page.goto('/');
  const button = page.getByRole('button', { name: /try again|retry/i });
  await expect(button).toBeVisible();
  expect(calls).toBe(2);
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => calls).toBe(4);
  await page.waitForTimeout(1500);
  expect(calls, 'no timer-driven polling of the session').toBe(4);
});

test('a refused client release opens the blocking dialog and focus moves into it', async ({
  page,
}) => {
  await signedIn(page, (r) =>
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
  await signedIn(page);
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
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.locator('html')).toHaveAttribute('lang', /^[a-z]{2}/);
  await expect(page).toHaveTitle(/\S/);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
});
