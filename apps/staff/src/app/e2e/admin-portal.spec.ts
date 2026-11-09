import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// CONTRACT MOCK: the session call and every admin list call are answered by Playwright (empty lists). No real API, database
// or security key runs here. This exercises the real StaffApp router, realm bar and admin screens in a browser (layout,
// colour contrast), with axe results and screenshots kept as evidence (INT04-F03-R1/R2).
const evidence = (p: string) => fileURLToPath(new URL(`../evidence/${p}`, import.meta.url));
mkdirSync(evidence('axe'), { recursive: true });
mkdirSync(evidence('screenshots'), { recursive: true });

const SCREENS = [
  ['audit', '/admin/audit', 'Audit log'],
  ['btg', '/admin/btg', 'Break-the-glass review'],
  ['users', '/admin/users', 'Users & roles'],
  ['privacy', '/admin/privacy', 'Privacy requests'],
  ['clinics', '/admin/clinics', 'Clinics, rooms, hours and holidays'],
  ['services', '/admin/services', 'Services catalogue'],
  ['policies', '/admin/policies', 'Booking policies'],
  ['templates', '/admin/templates', 'Consent and questionnaire templates'],
  ['integrations', '/admin/integrations', 'Integrations'],
  ['flags', '/admin/flags', 'Feature flags and banners'],
  ['vital-ranges', '/admin/vital-ranges', 'Vital-sign reference ranges'],
] as const;

async function mockApi(page: Page, session: 'admin' | 'none') {
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/auth/session')) {
      if (session === 'none')
        return route.fulfill({
          status: 401,
          contentType: 'application/problem+json',
          body: JSON.stringify({ status: 401, code: 'auth.unauthenticated', requestId: 'r' }),
        });
      const idle = new Date(Date.now() + 30 * 60_000).toISOString();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Session-Idle-Expires-At': idle },
        body: JSON.stringify({
          principalId: '11111111-1111-4111-8111-111111111111',
          realm: 'admin_pool',
          audience: 'staff',
          displayName: 'Admin Test',
          csrfToken: 'c',
          idleExpiresAt: idle,
          roles: [{ key: 'org_admin' }],
          permissions: [],
          patients: [],
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], nextCursor: null }),
    });
  });
  await page.route('**/release.json', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ release_number: 1 }) }),
  );
}

async function axe(page: Page, name: string, project: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  writeFileSync(
    evidence(`axe/${project}-${name}.json`),
    JSON.stringify(
      {
        screen: name,
        project,
        url: page.url().replace(/^https?:\/\/[^/]+/, ''),
        axeVersion: results.testEngine.version,
        violations: results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => n.target),
        })),
        passes: results.passes.length,
        incomplete: results.incomplete.map((v) => v.id),
      },
      null,
      2,
    ),
  );
  expect(
    results.violations.map((v) => `${v.id} (${v.impact})`),
    `axe violations on ${name}`,
  ).toEqual([]);
}

test('staff sign-in offers the separate Administrator sign-in link (INT04-F03-R1)', async ({
  page,
}, info) => {
  await mockApi(page, 'none');
  await page.goto('/sign-in');
  const google = page.getByRole('link', { name: 'Continue with Google' });
  const admin = page.getByRole('link', { name: /administrator sign-in/i });
  await expect(google).toBeVisible();
  await expect(admin).toBeVisible();
  await expect(admin).toHaveAttribute('href', '/admin/sign-in');
  await page.screenshot({ path: evidence(`screenshots/${info.project.name}-sign-in.png`) });
  await axe(page, 'sign-in', info.project.name);
  await admin.click();
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  await expect(page.getByRole('heading', { name: 'Administrator sign-in' })).toBeVisible();
  await page.screenshot({ path: evidence(`screenshots/${info.project.name}-admin-sign-in.png`) });
  await axe(page, 'admin-sign-in', info.project.name);
});

for (const [name, path, heading] of SCREENS) {
  test(`admin screen ${path}`, async ({ page }, info) => {
    await mockApi(page, 'admin');
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.locator('.ehr-realm-banner')).toBeVisible();
    await page.screenshot({
      path: evidence(`screenshots/${info.project.name}-${name}.png`),
      fullPage: true,
    });
    await axe(page, name, info.project.name);
  });
}
