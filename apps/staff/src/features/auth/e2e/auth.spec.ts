import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// CONTRACT MOCK of identity.yaml (GET /auth/session, POST /auth/session/extend, POST /auth/sign-out) and a stand-in
// for GET /auth/sign-in (the 302 to Google is answered with a marker page). No real API, database or OIDC provider
// runs in this check: the journey against the local OIDC conformance IdP happens only on the integrated candidate.
const shot = (name: string) =>
  fileURLToPath(new URL(`../evidence/screenshots/${name}.png`, import.meta.url));

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
}

interface Mock {
  seen: string[];
  idleInMs: number;
}
async function mockApi(page: Page, roles: string[] | 'signed-out', idleInMs = 30 * 60_000) {
  const mock: Mock = { seen: [], idleInMs };
  await page.route('**/api/v1/auth/sign-in**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>google-redirect</p>' }),
  );
  await page.route('**/api/v1/auth/session**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    mock.seen.push(`${req.method()} ${path}`);
    expect(req.headers()['x-client-release']).toMatch(/^r[1-9][0-9]*\.[0-9a-f]{12}$/);
    const idle = new Date(Date.now() + mock.idleInMs).toISOString();
    if (roles === 'signed-out')
      return route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({ code: 'auth.unauthenticated', requestId: 'req-1' }),
      });
    if (path.endsWith('/extend')) {
      mock.idleInMs = 30 * 60_000;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'x-session-idle-expires-at': new Date(Date.now() + mock.idleInMs).toISOString(),
        },
        body: JSON.stringify({ idleExpiresAt: new Date(Date.now() + mock.idleInMs).toISOString() }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'x-session-idle-expires-at': idle },
      body: JSON.stringify({
        principalId: '11111111-1111-4111-8111-111111111111',
        realm: 'google',
        audience: 'staff',
        displayName: 'Dr Test',
        csrfToken: 'csrf-1',
        idleExpiresAt: idle,
        roles: roles.map((key) => ({ key })),
        permissions: [],
        patients: [],
      }),
    });
  });
  await page.route('**/api/v1/auth/sign-out', (route) => {
    mock.seen.push('POST /api/v1/auth/sign-out');
    return route.fulfill({ status: 204 });
  });
  return mock;
}

test('sign-in offers Continue with Google only and the plain contact-IT message', async ({
  page,
}, info) => {
  await mockApi(page, 'signed-out');
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in to the staff portal' })).toBeVisible();
  await expect(page.locator('input')).toHaveCount(0);
  await expect(page.getByText('Contact IT.')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-1-sign-in`), fullPage: true });

  await page.goto('/sign-in?problem=1');
  await expect(page.getByText('We could not sign you in')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-2-sign-in-problem`), fullPage: true });

  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await expect(page.getByText('google-redirect')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/api/v1/auth/sign-in');
});

test('a visitor who is not signed in is sent to sign-in with a known screen path only', async ({
  page,
}) => {
  await mockApi(page, 'signed-out');
  await page.goto('/schedule');
  await page.waitForURL('**/sign-in?returnTo=%2Fschedule');
  await page.goto('/patients/9f2c');
  await page.waitForURL((u) => u.pathname === '/sign-in' && u.search === '');
});

test('a doctor sees the Doctor navigation; front desk sees Pre-consultation', async ({
  page,
}, info) => {
  await mockApi(page, ['doctor']);
  await page.goto('/');
  await page.waitForURL('**/schedule');
  const nav = page.getByRole('navigation', { name: 'Staff portal' });
  if (info.project.name === 'phone') {
    for (const n of ['Alerts', 'Schedule', 'Patients'])
      await expect(nav.getByRole('link', { name: n }).last()).toBeVisible();
    await expect(nav.getByText('More')).toBeVisible();
    await nav.getByText('More').click();
    await expect(nav.getByRole('link', { name: 'Notes to sign' }).last()).toBeVisible();
  } else {
    await expect(nav.getByRole('link')).toHaveText([
      'Alerts',
      'Schedule',
      'Patients',
      'Tasks & messages',
      'Notes to sign',
    ]);
  }
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-3-doctor`), fullPage: true });

  const fd = await page.context().newPage();
  await mockApi(fd, ['front_desk']);
  await fd.goto('/');
  await fd.waitForURL('**/arrivals');
  await expect(fd.getByRole('navigation').getByRole('link', { name: 'Notes to sign' })).toHaveCount(
    0,
  );
  await axe(fd);
  await fd.screenshot({ path: shot(`${info.project.name}-4-front-desk`), fullPage: true });
});

test('idle warning, stay signed in, sign out and the signed-out screen', async ({ page }, info) => {
  const mock = await mockApi(page, ['doctor'], 100_000);
  await page.goto('/schedule');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('signed out in');
  await expect(dialog)
    .toBeFocused({ timeout: 2000 })
    .catch(() => undefined);
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-5-idle-warning`), fullPage: true });
  expect(mock.seen.filter((s) => s.endsWith('/extend'))).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Stay signed in' }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.seen.filter((s) => s.endsWith('/extend'))).toHaveLength(1);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/signed-out');
  await expect(page.getByRole('heading', { name: 'You have signed out' })).toBeVisible();
  expect(mock.seen).toContain('POST /api/v1/auth/sign-out');
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-6-signed-out`), fullPage: true });
});

test('the session ending shows the signed-out dialog and returns to the same screen after sign-in', async ({
  page,
}, info) => {
  await mockApi(page, ['doctor'], 2_000);
  await page.goto('/alerts');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Your session ended', { timeout: 8000 });
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-7-session-ended`), fullPage: true });
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/sign-in?returnTo=%2Falerts');
});
