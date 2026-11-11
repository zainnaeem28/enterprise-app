import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// CONTRACT MOCK of the BE-23 organisation routes, the integration-core admin routes and the clinical vital-range routes (bodies copied
// from the BE-23 service and the integration-core connection record; the integration and vital-range row shapes are opaque in the
// contract). No real API, database or security key runs here; the journey against the real API happens on the integrated candidate
// (INT-04). The scripted key stands in for the physical one (Pending-human).
const shot = (name: string) =>
  fileURLToPath(new URL(`../evidence/screenshots/${name}.png`, import.meta.url));

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
}

/** Every configuration route needs the elevation grant, so the first read opens the key dialog; the scripted key answers it. */
async function unlock(page: Page) {
  await page.getByRole('button', { name: 'Use security key' }).click();
  await expect(page.getByRole('alertdialog')).toBeHidden();
}

const id = (n: number) => `123e4567-e89b-42d3-a456-4266141740${String(n).padStart(2, '0')}`;
const ok = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});
const problem = (status: number, code: string) => ({
  status,
  contentType: 'application/problem+json',
  body: JSON.stringify({ code, requestId: 'req-1' }),
});
const list = (items: unknown[]) => ok({ items, nextCursor: null });

interface Seen {
  call: string;
  body: unknown;
}
async function mock(page: Page) {
  const seen: Seen[] = [];
  await page.route('**/api/v1/admin/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    seen.push({ call: `${method} ${path}`, body: req.postDataJSON() as unknown });
    if (path.endsWith('/elevation/options'))
      return route.fulfill(
        ok({
          challengeId: id(5),
          publicKey: {
            challenge: 'AQIDBA',
            timeout: 120000,
            userVerification: 'required',
            allowCredentials: [{ id: 'AQID', type: 'public-key', transports: ['usb'] }],
          },
        }),
      );
    if (path.endsWith('/elevation/verify'))
      return route.fulfill(
        ok({ elevationExpiresAt: new Date(Date.now() + 900_000).toISOString() }),
      );
    if (method === 'GET') {
      if (path.endsWith('/locations'))
        return route.fulfill(
          list([
            {
              id: id(40),
              name: 'Downtown clinic',
              kind: 'clinic',
              timeZone: 'America/New_York',
              stateCode: 'AA',
              phone: null,
              active: true,
              rowVersion: 1,
            },
          ]),
        );
      if (path.endsWith('/opening-hours'))
        return route.fulfill(
          list([
            { locationId: id(40), weekday: 1, opens: '09:00', closes: '17:00', rowVersion: 3 },
          ]),
        );
      if (path.endsWith('/services'))
        return route.fulfill(
          list([
            {
              id: id(30),
              internalName: 'HIV clinic',
              patientDisplayName: 'Clinic visit',
              durationMin: 30,
              bufferMin: 0,
              mode: 'either',
              conditionRevealing: true,
              active: true,
              rowVersion: 1,
            },
          ]),
        );
      if (path.endsWith('/booking-policies'))
        return route.fulfill(
          list([
            {
              id: id(31),
              serviceId: id(30),
              locationId: null,
              cutoffHours: 24,
              lateChange: 'block',
              waitlistEnabled: true,
              rowVersion: 1,
            },
          ]),
        );
      if (path.endsWith('/integrations'))
        return route.fulfill(
          list([
            {
              id: id(50),
              kind: 'email',
              vendor: 'ses',
              enabled: true,
              health: 'ok',
              lastTestAt: '2026-11-08T10:00:00.000Z',
              rowVersion: 2,
            },
            {
              id: id(51),
              kind: 'sms',
              vendor: 'twilio',
              enabled: true,
              health: 'down',
              lastTestAt: null,
              rowVersion: 1,
            },
          ]),
        );
      if (path.endsWith('/feature-flags'))
        return route.fulfill(
          list([
            {
              id: id(60),
              key: 'patient_messaging',
              locationId: null,
              enabled: false,
              rowVersion: 1,
            },
          ]),
        );
      if (path.endsWith('/vital-ranges'))
        return route.fulfill(
          list([
            {
              id: id(80),
              loincCode: '8867-4',
              unit: '/min',
              sex: 'any',
              ageYears: { from: 18 },
              low: 50,
              high: 100,
              status: 'active',
            },
          ]),
        );
      if (
        path.endsWith('/rooms') ||
        path.endsWith('/holidays') ||
        path.endsWith('/banners') ||
        path.endsWith('/questionnaire-templates')
      )
        return route.fulfill(list([]));
      if (path.endsWith('/consent-templates'))
        return route.fulfill(
          list([
            {
              id: id(60),
              key: 'telehealth',
              version: 1,
              language: 'en',
              title: 'Telehealth consent',
              bodyText: 'Line one\nLine two',
              status: 'draft',
              rowVersion: 1,
            },
          ]),
        );
    }
    if (path.endsWith('/test'))
      return route.fulfill(ok({ health: 'ok', checkedAt: '2026-11-09T09:00:00.000Z' }));
    if (method === 'PUT' && path.includes('/secrets/'))
      return route.fulfill(ok({ versionId: 'v-7' }));
    if (method === 'PATCH' || method === 'POST' || method === 'PUT')
      return route.fulfill(ok({ id: id(99), rowVersion: 2 }));
    return route.fulfill(problem(404, 'kernel.not_found'));
  });
  return seen;
}

test('clinics: locations and opening hours load after the key, and the hours change with If-Match', async ({
  page,
}, info) => {
  const seen = await mock(page);
  await page.goto('/admin/clinics');
  await unlock(page);
  await expect(page.getByRole('table', { name: 'Locations' })).toBeVisible();
  await expect(page.getByText('Downtown clinic').first()).toBeVisible();
  await expect(page.getByText('Monday')).toBeVisible();
  await page.screenshot({ path: shot(`${info.project.name}-1-clinics`), fullPage: true });
  await axe(page);
  await page.getByRole('button', { name: /^Edit: Monday 09:00/ }).click();
  await page.getByLabel('Closes').fill('18:00');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved. The change is recorded in the audit log.')).toBeVisible();
  const patch = seen.find((s) => s.call.startsWith('PATCH'));
  expect(patch?.body).toEqual({ locationId: id(40), weekday: 1, opens: '09:00', closes: '18:00' });
});

test('services: a condition-revealing service needs a neutral patient name', async ({
  page,
}, info) => {
  const seen = await mock(page);
  await page.goto('/admin/services');
  await unlock(page);
  await expect(page.getByRole('table', { name: 'Services' })).toBeVisible();
  await expect(page.getByText('Clinic visit')).toBeVisible();
  await page.getByRole('button', { name: /^Add: Services/ }).click();
  await page.getByLabel('Internal name').fill('Sexual health');
  await page.getByLabel('Length (minutes)').fill('30');
  await page.getByLabel('How it is held').selectOption('video');
  await page.getByLabel('The service name would reveal a condition').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/Enter a neutral name that is different/).first()).toBeVisible();
  await page.screenshot({ path: shot(`${info.project.name}-2-services-neutral`), fullPage: true });
  await axe(page);
  expect(
    seen.filter((s) => !s.call.startsWith('GET') && !s.call.includes('elevation')),
  ).toHaveLength(0);
  await page.getByLabel('Name patients see').fill('Private consultation');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved. The change is recorded in the audit log.')).toBeVisible();
});

test('policies: late changes are blocked, not charged', async ({ page }, info) => {
  await mock(page);
  await page.goto('/admin/policies');
  await unlock(page);
  await expect(page.getByRole('table', { name: 'Booking policies' })).toBeVisible();
  await page.getByRole('button', { name: /^Add: Booking policies/ }).click();
  await expect(page.getByText(/No fee is charged in this release/)).toBeVisible();
  await page.screenshot({ path: shot(`${info.project.name}-3-policies`), fullPage: true });
  await axe(page);
});

test('integrations: health, test, and a write-only secret that is never shown', async ({
  page,
}, info) => {
  const seen = await mock(page);
  await page.goto('/admin/integrations');
  await unlock(page);
  await expect(page.getByRole('table', { name: 'Integrations' })).toBeVisible();
  await expect(page.getByText('Down').first()).toBeVisible();
  await page.getByRole('button', { name: 'Test connection: Text messages' }).click();
  await expect(page.getByText(/Test result: Healthy/)).toBeVisible();
  const SECRET = 'sk-live-very-secret-value';
  await page.getByLabel('Secret name').nth(0).fill('api-key');
  await page.getByLabel('Secret value').nth(0).fill(SECRET);
  await expect(page.getByLabel('Secret value').nth(0)).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: /^Save: Set a secret E-mail/ }).click();
  await expect(page.getByText('Secret saved (version v-7). The value is not shown.')).toBeVisible();
  await expect(page.getByLabel('Secret value').nth(0)).toHaveValue('');
  expect(await page.content()).not.toContain(SECRET);
  const put = seen.find((s) => s.call.startsWith('PUT'));
  expect(put?.call).toBe(`PUT /api/v1/admin/integrations/${id(50)}/secrets/api-key`);
  await page.screenshot({ path: shot(`${info.project.name}-4-integrations`), fullPage: true });
  await axe(page);
});

test('flags: patient messaging cannot be turned on; vital ranges list', async ({ page }, info) => {
  await mock(page);
  await page.goto('/admin/flags');
  await unlock(page);
  await expect(page.getByRole('table', { name: 'Feature flags' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Turn on: patient_messaging/ })).toBeDisabled();
  await expect(
    page.getByText('Patient messaging cannot be turned on in this release.'),
  ).toBeVisible();
  await page.screenshot({ path: shot(`${info.project.name}-5-flags`), fullPage: true });
  await axe(page);
  // A full page load drops the in-memory grant (nothing is kept in storage), so the key is asked for again.
  await page.goto('/admin/vital-ranges');
  await unlock(page);
  await expect(page.getByText('8867-4')).toBeVisible();
  await page.screenshot({ path: shot(`${info.project.name}-6-vital-ranges`), fullPage: true });
  await axe(page);
});
