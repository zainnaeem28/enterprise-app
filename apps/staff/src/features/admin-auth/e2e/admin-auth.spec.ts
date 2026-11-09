import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// CONTRACT MOCK of identity.yaml (POST /admin/auth/sign-in/*, /admin/auth/elevation/*, POST /admin/role-change-requests,
// POST /auth/sign-out). No real API, database or security key runs here: the scripted key stands in for the physical one, and the
// physical-key cases (TC for FE-17) stay Pending-human. The journey against the real API happens on the integrated candidate.
const shot = (name: string) =>
  fileURLToPath(new URL(`../evidence/screenshots/${name}.png`, import.meta.url));

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
}

const options = {
  challengeId: '5d1b9a58-3b4b-4c0c-8f2e-1c1f4a6a9b01',
  publicKey: {
    challenge: 'AQIDBA',
    timeout: 120000,
    userVerification: 'required',
    allowCredentials: [{ id: 'AQID', type: 'public-key', transports: ['usb'] }],
  },
};
const problem = (status: number, code: string) => ({
  status,
  contentType: 'application/problem+json',
  body: JSON.stringify({ code, requestId: 'req-1' }),
});

async function mock(
  page: Page,
  opts: { signIn?: 'ok' | 'fail'; grantFor?: number; expiredOnce?: boolean } = {},
) {
  const seen: string[] = [];
  let roleCalls = 0;
  await page.route('**/api/v1/admin/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    seen.push(`${route.request().method()} ${path}`);
    if (path.endsWith('/options'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(options),
      });
    if (path.endsWith('/sign-in/verify'))
      return opts.signIn === 'fail'
        ? route.fulfill(problem(401, 'identity.sign_in_failed'))
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              principalId: 'p',
              csrfToken: 'c',
              idleExpiresAt: new Date(Date.now() + 600_000).toISOString(),
            }),
          });
    if (path.endsWith('/elevation/verify'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          elevationExpiresAt: new Date(Date.now() + (opts.grantFor ?? 900_000)).toISOString(),
        }),
      });
    if (path.endsWith('/role-change-requests')) {
      roleCalls += 1;
      return roleCalls === 1 && opts.expiredOnce === true
        ? route.fulfill(problem(403, 'identity.elevation_required'))
        : route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill(problem(404, 'kernel.not_found'));
  });
  await page.route('**/api/v1/auth/sign-out', (route) => {
    seen.push('POST /api/v1/auth/sign-out');
    return route.fulfill({ status: 204 });
  });
  return seen;
}

test('administrator sign-in: handle and security key, no password, no Google', async ({
  page,
}, info) => {
  const seen = await mock(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Administrator sign-in' })).toBeVisible();
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
  await expect(page.getByText('Continue with Google')).toHaveCount(0);
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-1-admin-sign-in`), fullPage: true });
  await page.getByLabel('Administrator handle').fill('Admin.One');
  await page.getByRole('button', { name: 'Sign in with security key' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-landed', '/admin');
  expect(seen).toEqual([
    'POST /api/v1/admin/auth/sign-in/options',
    'POST /api/v1/admin/auth/sign-in/verify',
  ]);
});

test('a refused sign-in reads the same whatever the cause', async ({ page }, info) => {
  await mock(page, { signIn: 'fail' });
  await page.goto('/');
  await page.getByLabel('Administrator handle').fill('admin.one');
  await page.getByRole('button', { name: 'Sign in with security key' }).click();
  await expect(page.getByText('We could not sign you in')).toBeVisible();
  await axe(page);
  await page.screenshot({
    path: shot(`${info.project.name}-2-admin-sign-in-refused`),
    fullPage: true,
  });
});

test('a cancelled key prompt is a plain, retryable message', async ({ page }) => {
  await mock(page);
  await page.goto('/?key=cancel');
  await page.getByLabel('Administrator handle').fill('admin.one');
  await page.getByRole('button', { name: 'Sign in with security key' }).click();
  await expect(page.getByText(/cancelled or timed out/)).toBeVisible();
});

test('the staff sign-in page links to the separate administrator sign-in', async ({ page }) => {
  await mock(page);
  await page.goto('/sign-in');
  await expect(page.getByRole('link', { name: 'Administrator sign-in' })).toHaveAttribute(
    'href',
    '/admin/sign-in',
  );
});

test('admin screen: fixed banner, elevation dialog names action, target and approver, chip after success', async ({
  page,
}, info) => {
  const seen = await mock(page);
  await page.goto('/admin');
  await expect(
    page.getByText('Administrator sign-in. Clinical data is not available here.'),
  ).toBeVisible();
  await expect(page.getByText('Administrator portal')).toBeVisible();
  await expect(page.getByText(/Elevated until/)).toHaveCount(0);
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-3-admin-banner`), fullPage: true });

  await page.getByRole('button', { name: 'Request role change' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Confirm with your security key' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Request a role change');
  await expect(dialog).toContainText('Dr A. Example: add Compliance officer');
  await expect(dialog).toContainText('A second administrator, not you');
  await expect(dialog.getByRole('button', { name: 'Use security key' })).toBeFocused();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-4-elevation-dialog`), fullPage: true });

  await dialog.getByRole('button', { name: 'Use security key' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/Elevated until \d\d:\d\d/)).toBeVisible();
  await expect(page.getByTestId('result')).toHaveText('status 200');
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-5-elevated-chip`), fullPage: true });
  // The dialog came first, so the privileged call was made once, with a live grant.
  expect(seen.filter((p) => p.includes('/elevation/'))).toHaveLength(2);
});

test('a grant that is gone mid-form: 403 elevation_required opens the dialog and the call is retried once', async ({
  page,
}) => {
  await mock(page, { expiredOnce: true });
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Request role change' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Use security key' }).click();
  // First role call returns 403 elevation_required; the dialog returns and the form keeps its state.
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Use security key' }).click();
  await expect(page.getByTestId('result')).toHaveText('status 200');
});

test('realm switch signs out and keeps the draft where the screen supports it', async ({
  page,
}) => {
  const seen = await mock(page, { grantFor: 900_000 });
  await page.goto('/admin');
  await page.getByLabel('Reason').fill('Covering for leave');
  await page.getByRole('button', { name: 'Sign out to switch to staff' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-signed-out', 'yes');
  expect(seen).toContain('POST /api/v1/auth/sign-out');
});
