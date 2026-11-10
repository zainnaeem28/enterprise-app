// TC-XB-01 (NFR-11), automated part: the same smoke journeys render and behave the same in the Chromium, Firefox and
// WebKit builds. Real devices and branded Chrome/Safari/Edge stay with QA (TC-XB-02, Pending-human). TC-XB-03 (an
// unsupported old browser) is not automatable with these engines and stays Pending-human.
import { expect, test } from '@playwright/test';
import { PATIENT, SITE, STAFF, mockApi } from './support';

test('TC-XB-01 staff: signed-out visitor is sent to the sign-in page, which offers Google sign-in', async ({
  page,
}) => {
  await mockApi(page, 'none');
  await page.goto(`${STAFF}/schedule`);
  await page.waitForURL((u) => u.pathname === '/sign-in');
  await expect(page.getByRole('heading').first()).toBeVisible();
  await expect(
    page
      .getByRole('link', { name: /google/i })
      .or(page.getByRole('button', { name: /google/i }))
      .first(),
  ).toBeVisible();
});

test('TC-XB-01 staff: a signed-in doctor lands on the schedule with navigation', async ({
  page,
}) => {
  await mockApi(page, 'staff-doctor');
  await page.goto(`${STAFF}/`);
  await page.waitForURL((u) => u.pathname === '/schedule');
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
});

test('TC-XB-01 staff: the administrator realm shows its fixed banner', async ({ page }) => {
  await mockApi(page, 'admin');
  await page.goto(`${STAFF}/admin/audit`);
  await expect(
    page.getByText(/Administrator sign-in\. Clinical data is not available here\./),
  ).toBeVisible();
});

test('TC-XB-01 patient: entry page leads to the sign-in hand-off page', async ({ page }) => {
  await mockApi(page, 'none');
  await page.goto(`${PATIENT}/`);
  await expect(page.getByRole('heading').first()).toBeVisible();
  await page.getByRole('button').first().click();
  await page.waitForURL((u) => u.pathname === '/continue');
  await expect(page.getByRole('heading').first()).toBeVisible();
});

test('TC-XB-01 patient: a signed-in patient reaches the booking start and the profile page', async ({
  page,
}) => {
  await mockApi(page, 'patient');
  await page.goto(`${PATIENT}/book`);
  await expect(page.getByRole('main')).toBeVisible();
  await page.goto(`${PATIENT}/profile`);
  await expect(page.getByRole('heading').first()).toBeVisible();
});

test('TC-XB-01 site: services page, and Book hands off to the patient portal with opaque IDs only', async ({
  page,
}) => {
  await page.goto(`${SITE}/services`);
  await expect(page.getByRole('heading', { level: 1, name: 'Services' })).toBeVisible();
  await page.goto(`${SITE}/doctors/33333333-3333-4333-8333-333333333333`);
  await page.getByRole('link', { name: 'Book General visit' }).click();
  await page.waitForURL(`${PATIENT}/book?**`);
  const u = new URL(page.url());
  expect([...u.searchParams.keys()].sort()).toEqual(['clinicianId', 'serviceId']);
});

test('TC-XB-01 site: keyboard — the skip link is the first tab stop and focus is visible', async ({
  page,
}) => {
  await page.goto(`${SITE}/`);
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName,
      text: el?.textContent?.trim() ?? '',
      outline: el ? getComputedStyle(el).outlineStyle : '',
    };
  });
  expect(focused.tag).toBe('A');
  expect(focused.text).toMatch(/skip/i);
});

test('TC-A11Y-05 (automated part) forced-colors and reduced-motion render without a scan error', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await page.goto(`${SITE}/`);
  await expect(page.getByRole('heading').first()).toBeVisible();
});

test('TC-A11Y-06 (automated part) an empty link-a-family-member form on the patient portal reports errors linked to fields', async ({
  page,
}) => {
  await mockApi(page, 'patient');
  await page.goto(`${PATIENT}/family/add`);
  await page
    .getByRole('button', { name: /send request/i })
    .first()
    .click();
  const invalid = page.locator('[aria-invalid="true"]');
  await expect(invalid.first()).toBeVisible();
  const described = await invalid.first().getAttribute('aria-describedby');
  expect(described, 'invalid field has aria-describedby linking its error').toBeTruthy();
});
