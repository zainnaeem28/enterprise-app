// a11y-smoke (DEVOPS-PLAN 5.1): axe-core on the built staff shell in every state it can be in, at a desktop and a 360 px
// viewport. Blocks on serious or critical violations. Automated rules find only part of WCAG; the full audit is manual
// (DEP-17, TEST-CASES TC-A11Y). The API answers are contract mocks of the documented problem+json responses.
// Since INT-04 the shell sends a signed-out visitor from `/` to `/sign-in` and shows the release prompts only on the
// signed-in shell, so the release states are reached with a (mocked) signed-in session with no roles.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const SESSION = '**/api/v1/auth/session';
const problem = (status: number, code: string) => ({
  status,
  contentType: 'application/problem+json',
  body: JSON.stringify({ status, code, requestId: 'req-smoke' }),
});

const IDLE = () => new Date(Date.now() + 30 * 60_000).toISOString();
// A signed-in staff session with no roles: the shell renders (with the release prompts) and makes no other API call.
const signedIn = () => ({
  status: 200,
  contentType: 'application/json',
  headers: { 'X-Session-Idle-Expires-At': IDLE() },
  body: JSON.stringify({
    principalId: '11111111-1111-4111-8111-111111111111',
    realm: 'google',
    audience: 'staff',
    displayName: 'Smoke User',
    csrfToken: 'csrf-smoke',
    idleExpiresAt: IDLE(),
    roles: [],
    permissions: [],
    patients: [],
  }),
});

async function expectNoSeriousViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  expect(results.passes.length, `${label}: axe evaluated no rule (empty scan)`).toBeGreaterThan(0);
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    `${label}: serious/critical axe violations`,
  ).toEqual([]);
}

const viewports = [
  { name: 'desktop 1280', size: { width: 1280, height: 800 } },
  { name: 'phone 360', size: { width: 360, height: 740 } },
];

for (const vp of viewports) {
  test.describe(vp.name, () => {
    test.use({ viewport: vp.size });

    test('sign-in page (signed-out visitor redirected from /)', async ({ page }) => {
      await page.route(SESSION, (r) => r.fulfill(problem(401, 'auth.unauthenticated')));
      await page.goto('/');
      await expect(page).toHaveURL(/\/sign-in$/);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Sign in to the staff portal' }),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: /administrator sign-in/i })).toBeVisible();
      await expectNoSeriousViolations(page, 'sign-in');
    });

    test('server error state', async ({ page }) => {
      // A 503 on the very first session read is treated as signed out (redirect to /sign-in); the error page shows when
      // the session loads and the roles read that follows fails, so the first answer is a session and the rest are 503.
      let reads = 0;
      await page.route(SESSION, (r) =>
        r.fulfill(++reads === 1 ? signedIn() : problem(503, 'kernel.unavailable')),
      );
      await page.goto('/');
      await expect(
        page.getByRole('heading', { level: 1, name: /Something went wrong on our side/ }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
      await expectNoSeriousViolations(page, 'server error');
    });

    test('blocking release dialog', async ({ page }) => {
      await page.route(SESSION, (r) => r.fulfill(signedIn()));
      await page.route('**/api/v1/auth/sign-out', (r) =>
        r.fulfill(problem(400, 'kernel.client_release_unsupported')),
      );
      await page.goto('/');
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(
        page.getByRole('alertdialog', { name: 'This page is out of date' }),
      ).toBeVisible();
      await expectNoSeriousViolations(page, 'blocking dialog');
    });

    test('non-blocking release bar (signed in)', async ({ page }) => {
      await page.route(SESSION, (r) => r.fulfill(signedIn()));
      await page.route('**/release.json', (r) =>
        r.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ release_number: 99 }),
        }),
      );
      await page.goto('/');
      await expect(
        page.getByRole('status').filter({ hasText: 'A new version is available' }),
      ).toBeVisible();
      await expectNoSeriousViolations(page, 'release bar');
    });
  });
}
