import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// CONTRACT MOCK of the API (no real API or IdP fixture runs in this local check; the fixture journey on `ci`
// waits on the DevOps wiring request). The mock follows identity.yaml: sign-in 302 -> IdP, callback 302 -> returnTo
// with the session cookie, session and me as documented. It is labelled as such in the report.
async function mockApi(page: Page, opts: { signIn?: number; session?: number } = {}) {
  let signedIn = false;
  const seen: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    seen.push(`${route.request().method()} ${url.pathname}`);
    const problem = (status: number, code: string) =>
      route.fulfill({
        status,
        contentType: 'application/problem+json',
        body: JSON.stringify({ status, code, requestId: 'req-e2e' }),
      });
    switch (url.pathname) {
      case '/api/v1/auth/sign-in':
        if (opts.signIn !== undefined) return problem(opts.signIn, 'kernel.unavailable');
        return route.fulfill({
          status: 302,
          headers: {
            location: `/api/v1/auth/callback?code=c&state=s&to=${encodeURIComponent(url.searchParams.get('returnTo') ?? '/')}`,
          },
        });
      case '/api/v1/auth/callback':
        signedIn = true;
        return route.fulfill({
          status: 302,
          headers: { location: url.searchParams.get('to') ?? '/' },
        });
      case '/api/v1/auth/session':
        if (opts.session !== undefined) return problem(opts.session, 'identity.sign_in_failed');
        if (!signedIn) return problem(401, 'auth.unauthenticated');
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: {
            'x-session-idle-expires-at': new Date(Date.now() + 30 * 60_000).toISOString(),
          },
          body: JSON.stringify({
            principalId: '11111111-1111-4111-8111-111111111111',
            realm: 'patient',
            audience: 'patient',
            displayName: 'Test Patient',
            csrfToken: 'csrf-e2e',
            idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            roles: [],
            permissions: [],
            patients: [{ patientId: 'p1', relation: 'self', scope: 'full' }],
          }),
        });
      case '/api/v1/me':
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ patients: [{ patientId: 'p1' }] }),
        });
      case '/api/v1/auth/sign-out':
        expect(route.request().headers()['x-csrf-token']).toBe('csrf-e2e');
        signedIn = false;
        return route.fulfill({ status: 204 });
      default:
        return problem(404, 'kernel.not_found');
    }
  });
  return seen;
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
}

test('entry, pre-redirect, sign-in, callback, landing and sign-out, with axe on each page', async ({
  page,
}) => {
  const seen = await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Patient portal' })).toBeVisible();
  await expect(page.locator('input')).toHaveCount(0);
  await axe(page);

  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText(/secure sign-in page/)).toBeVisible();
  await axe(page);

  await page.getByRole('button', { name: 'Continue to secure sign-in' }).click();
  await expect(page.getByRole('heading', { name: 'You are signed in' })).toBeVisible();
  await expect(page.getByText('Signed in as Test Patient.')).toBeVisible();
  await expect(page).toHaveURL(/\/account$/);
  await axe(page);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Patient portal' })).toBeVisible();
  expect(seen).toContain('POST /api/v1/auth/sign-out');
  expect(seen.filter((s) => s.startsWith('GET /api/v1/auth/sign-in')).length).toBeGreaterThan(0);
});

test('a callback that left no session shows the sign-in-failed state', async ({ page }) => {
  await mockApi(page);
  await page.goto('/account'); // callback did not complete: no session
  await expect(page.getByRole('heading', { name: 'You are not signed in' })).toBeVisible();
  await axe(page);
  await page.goto('/problem?code=identity.sign_in_failed');
  await expect(page.getByRole('heading', { name: 'We could not sign you in' })).toBeVisible();
  await axe(page);
});

test('a refused sign-in shows the unavailable state', async ({ page }) => {
  await mockApi(page, { signIn: 503 });
  await page.goto('/continue');
  await page.getByRole('button', { name: 'Continue to secure sign-in' }).click();
  await expect(
    page.getByRole('heading', { name: 'Sign-in is not available right now' }),
  ).toBeVisible();
  await axe(page);
});
