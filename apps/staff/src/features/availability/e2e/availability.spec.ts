import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// CONTRACT MOCK of scheduling.yaml and calendar-sync.yaml, with response shapes copied from the API controllers on the BE-12 and BE-14
// branches. No real API, database or Google service runs in this check; the real journey is for integration.
const LOC = '11111111-1111-4111-8111-111111111111';
const ME = '88888888-8888-4888-8888-888888888888';
const TPL = '33333333-3333-4333-8333-333333333333';
const shot = (name: string) =>
  fileURLToPath(new URL(`../evidence/screenshots/${name}.png`, import.meta.url));

const PERMS = [
  'scheduling.booking.own_schedule',
  'scheduling.template.manage',
  'scheduling.blocked_time.manage',
  'calendar.link.own',
];

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function mockApi(page: Page, link: Record<string, unknown> = { status: 'not_linked' }) {
  const tomorrow = new Date(Date.now() + 86_400_000);
  const day = tomorrow.getUTCDay();
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    expect(req.headers()['x-client-release']).toMatch(/^r[1-9][0-9]*\.[0-9a-f]{12}$/);
    const ok = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: status >= 400 ? 'application/problem+json' : 'application/json',
        body: JSON.stringify(body),
      });
    if (path === '/api/v1/auth/session')
      return ok(200, {
        principalId: ME,
        displayName: 'Dr Lee',
        audience: 'staff',
        realm: 'google',
        csrfToken: 't',
        idleExpiresAt: '2099-01-01T00:00:00.000Z',
        roles: [{ key: 'doctor', locationId: LOC }],
        permissions: PERMS,
        patients: [],
      });
    if (path.endsWith('/availability-templates'))
      return ok(200, {
        items: [
          {
            id: TPL,
            clinicianId: ME,
            locationId: LOC,
            validFrom: '2020-01-01',
            validTo: null,
            status: 'active',
            version: 3,
            rules: [day, (day + 1) % 7].map((weekday) => ({
              id: `r${weekday}`,
              weekday,
              startLocal: '09:00',
              endLocal: '17:00',
              serviceIds: null,
              mode: 'either',
              roomId: null,
              overbookable: false,
            })),
          },
        ],
        nextCursor: null,
      });
    if (path.endsWith('/schedule')) {
      const date = url.searchParams.get('date');
      return ok(200, {
        timeZone: 'UTC',
        items:
          date === ymd(tomorrow)
            ? [
                {
                  reservationId: 'x',
                  patientId: 'p',
                  patientName: null,
                  mrn: null,
                  serviceId: 's',
                  mode: 'in_person',
                  status: 'confirmed',
                  startsAt: `${ymd(tomorrow)}T10:00:00.000Z`,
                  endsAt: `${ymd(tomorrow)}T10:30:00.000Z`,
                  checkedInAt: null,
                  queueStage: null,
                },
              ]
            : [],
      });
    }
    if (path.endsWith('/blocked-times') && req.method() === 'GET')
      return ok(200, {
        items: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            clinicianId: ME,
            startsAt: '2031-07-01T00:00:00.000Z',
            endsAt: '2031-07-08T00:00:00.000Z',
            kind: 'leave',
            note: 'Annual leave',
            version: 1,
          },
        ],
        nextCursor: null,
      });
    if (path.endsWith('/blocked-times') && req.method() === 'POST')
      return ok(200, {
        saved: false,
        conflicts: { total: 3, held: 1, confirmed: 1, checked_in: 1 },
      });
    if (path === '/api/v1/calendar-link' && req.method() === 'GET') return ok(200, link);
    if (path === '/api/v1/calendar-link/start')
      return ok(200, { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' });
    return ok(404, { code: 'kernel.not_found' });
  });
}

for (const [i, link] of [
  { status: 'not_linked' },
  { status: 'active', lastSyncedAt: '2031-06-10T09:00:00.000Z', lastErrorCode: null },
  { status: 'token_revoked', lastSyncedAt: null, lastErrorCode: 'invalid_grant' },
  { status: 'error', lastSyncedAt: null, lastErrorCode: 'vendor_unavailable' },
].entries()) {
  test(`DR-13 calendar connection: ${link.status}`, async ({ page }, info) => {
    await mockApi(page, link);
    await page.goto('/');
    await page.getByRole('tab', { name: 'Google Calendar' }).click();
    await expect(page.getByText('What you are agreeing to')).toBeVisible();
    await expect(page.getByText(/Busy-only sync/)).toBeVisible();
    await axe(page);
    await page.screenshot({
      path: shot(`${info.project.name}-${i + 4}-calendar-${link.status}`),
      fullPage: true,
    });
  });
}

test('DR-13 return from Google: denied', async ({ page }, info) => {
  await mockApi(page);
  await page.goto('/?calendar=denied');
  await expect(page.getByText(/You did not approve access at Google/)).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-8-calendar-denied`), fullPage: true });
});

test('DR-13 connect goes to Google only', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Google Calendar' }).click();
  await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
  await expect(page.locator('body')).toHaveAttribute(
    'data-went-to',
    /^https:\/\/accounts\.google\.com\//,
  );
});

test('DR-11 weekly hours: list, editor and affected appointments before saving', async ({
  page,
}, info) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByText('From 2020-01-01, no end date')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-1-hours-list`), fullPage: true });

  await page.getByRole('button', { name: 'Change hours' }).click();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-2-hours-editor`), fullPage: true });

  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    new Date(Date.now() + 86_400_000).getUTCDay()
  ] as string;
  await page.getByRole('button', { name: `Remove hours 1 on ${day}` }).click();
  await page.getByRole('button', { name: 'Check affected appointments' }).click();
  await expect(page.getByText('1 upcoming appointment falls outside these hours.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save hours' })).toBeDisabled();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-3-hours-affected`), fullPage: true });
});

test('DR-12 leave and blocked time: affected appointments before saving', async ({
  page,
}, info) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Leave and blocked time' }).click();
  await page.getByLabel('From').fill('2031-07-01T08:00');
  await page.getByLabel('Until').fill('2031-07-03T17:00');
  await page.getByRole('button', { name: 'Check affected appointments' }).click();
  await expect(page.getByText(/3 appointments are booked in this period/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-9-leave-affected`), fullPage: true });
});
