import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// CONTRACT MOCK of the scheduling API (scheduling.yaml, organisation.yaml, identity.yaml). No real API or database runs in
// this check: the catalogue, waitlist and calendar routes are not mounted in the API yet (README, "What is not proven").
// The mock keeps one slot that "another patient" can take, to show the booking race from the patient's side.
const PATIENT = '22222222-2222-4222-8222-222222222222';
const SERVICE = '33333333-3333-4333-8333-333333333333';
const PLACE = '44444444-4444-4444-8444-444444444444';
const DOCTOR = '55555555-5555-4555-8555-555555555555';
const RES = '66666666-6666-4666-8666-666666666666';

const soon = (days: number, hour: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const slot = (hour: number) => ({
  startsAt: soon(2, hour),
  endsAt: soon(2, hour + 1),
  clinicianId: DOCTOR,
  locationId: PLACE,
  mode: 'in_person',
});
const appt = (over = {}) => ({
  id: RES,
  patientId: PATIENT,
  serviceId: SERVICE,
  locationId: PLACE,
  locationTimeZone: 'America/New_York',
  clinicianId: DOCTOR,
  mode: 'in_person',
  status: 'confirmed',
  startsAt: soon(2, 14),
  endsAt: soon(2, 15),
  version: 3,
  ...over,
});

interface Mock {
  seen: string[];
  takeNext: { value: boolean };
}

async function mockApi(
  page: Page,
  opts: { slots?: unknown[]; waitlist?: number } = {},
): Promise<Mock> {
  const seen: string[] = [];
  const takeNext = { value: false };
  const ok = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
    route.fulfill({
      status,
      contentType: status >= 400 ? 'application/problem+json' : 'application/json',
      headers: {
        'x-session-idle-expires-at': new Date(Date.now() + 30 * 60_000).toISOString(),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    seen.push(`${req.method()} ${path}`);
    const key = `${req.method()} ${path}`;
    switch (key) {
      case 'GET /api/v1/auth/session':
        return ok(route, {
          principalId: '11111111-1111-4111-8111-111111111111',
          realm: 'patient',
          audience: 'patient',
          displayName: 'Test Patient',
          csrfToken: 'csrf-e2e',
          idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          roles: [],
          permissions: [],
          patients: [{ patientId: PATIENT, relation: 'self', scope: 'full' }],
        });
      case 'GET /api/v1/services':
        return ok(route, {
          items: [
            { id: SERVICE, patientDisplayName: 'General visit', durationMin: 30, mode: null },
            {
              id: '88888888-8888-4888-8888-888888888888',
              patientDisplayName: 'Follow-up visit',
              durationMin: 15,
              mode: null,
            },
          ],
          nextCursor: null,
        });
      case 'GET /api/v1/locations':
        return ok(route, {
          items: [{ id: PLACE, name: 'Main Street Clinic', timeZone: 'America/New_York' }],
          nextCursor: null,
        });
      case 'GET /api/v1/clinicians':
        return ok(route, { items: [{ clinicianId: DOCTOR, displayName: 'Dr. Example' }] });
      case 'POST /api/v1/availability/search':
        return ok(route, {
          slots: opts.slots ?? [slot(14), slot(15), slot(16)],
          availabilityStale: false,
        });
      case 'POST /api/v1/holds':
        expect(req.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
        expect(req.headers()['x-csrf-token']).toBe('csrf-e2e');
        if (takeNext.value) {
          takeNext.value = false;
          return ok(
            route,
            {
              status: 409,
              code: 'scheduling.slot_taken',
              requestId: 'req-race',
              errors: [
                { path: '/alternatives/0', code: slot(15).startsAt },
                { path: '/alternatives/1', code: slot(16).startsAt },
              ],
            },
            409,
          );
        }
        return ok(
          route,
          {
            reservationId: RES,
            expiresAt: new Date(Date.now() + 9 * 60_000 + 42_000).toISOString(),
          },
          201,
          {
            date: new Date().toUTCString(),
          },
        );
      case `POST /api/v1/appointments/${RES}/confirm`:
        return ok(route, appt());
      case `POST /api/v1/appointments/${RES}/cancel`:
        return ok(route, appt({ status: 'cancelled_patient', version: 4 }));
      case `GET /api/v1/patients/${PATIENT}/appointments`:
        return ok(route, { items: [appt()], nextCursor: null });
      case `GET /api/v1/appointments/${RES}`:
        return ok(route, appt());
      case 'POST /api/v1/waitlist-entries':
        if (opts.waitlist !== undefined)
          return ok(
            route,
            { status: opts.waitlist, code: 'scheduling.waitlist_disabled' },
            opts.waitlist,
          );
        return ok(route, {});
      default:
        return ok(route, { status: 404, code: 'kernel.not_found', requestId: 'req-e2e' }, 404);
    }
  });
  return { seen, takeNext };
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
}

const shots = fileURLToPath(new URL('../evidence/screenshots/', import.meta.url));
const shot = (page: Page, name: string, project: string) =>
  page.screenshot({ path: `${shots}${project}-${name}.png`, fullPage: true });

async function toTime(page: Page) {
  await page.goto('/book');
  await page.getByRole('radio', { name: /General visit/ }).check();
  await axe(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Place').selectOption(PLACE);
  await expect(page.getByLabel('Doctor')).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a date and time' })).toBeVisible();
}

test.describe('PP-10..PP-14', () => {
  test('book a visit end to end with axe on every screen', async ({ page }, info) => {
    const m = await mockApi(page);
    await toTime(page);
    await expect(
      page.getByRole('button', { name: /2:00 PM|10:00 AM|9:00 AM|11:00 AM|12:00 PM/ }).first(),
    ).toBeVisible();
    await axe(page);
    await shot(page, 'pp12-time', info.project.name);
    await page
      .getByRole('button', { name: /\d:00 [AP]M/ })
      .first()
      .click();
    await expect(page.getByRole('timer')).toHaveText(/Held for 09:4\d|Held for 09:3\d/);
    await axe(page);
    await shot(page, 'pp12-held', info.project.name);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Check and confirm' })).toBeVisible();
    await axe(page);
    await shot(page, 'pp13-confirm', info.project.name);
    await page.getByRole('button', { name: 'Confirm appointment' }).click();
    await expect(page.getByRole('heading', { name: 'Your appointment is booked' })).toBeVisible();
    await axe(page);
    await shot(page, 'pp14-booked', info.project.name);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Add to calendar' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('appointment.ics');
    const text = await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8');
    expect(text).toMatch(/^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
    expect(text).toContain('SUMMARY:Appointment\r\n');
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(m.seen.filter((s) => s === 'POST /api/v1/holds')).toHaveLength(1);
  });

  test('booking race: slot taken shows alternatives and the waitlist, and an alternative can be held', async ({
    page,
  }, info) => {
    const m = await mockApi(page);
    await toTime(page);
    m.takeNext.value = true;
    await page
      .getByRole('button', { name: /\d:00 [AP]M/ })
      .first()
      .click();
    await expect(page.getByText('That time was just taken')).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Times near that' }).getByRole('list').getByRole('button'),
    ).toHaveCount(2);
    await expect(
      page.getByRole('button', { name: 'Join the waitlist for this visit' }),
    ).toBeVisible();
    await expect(page.getByText('Choose another time to continue.').first()).toBeVisible();
    await axe(page);
    await shot(page, 'x02-slot-taken', info.project.name);
    await page.getByRole('region', { name: 'Times near that' }).getByRole('button').first().click();
    await expect(page.getByRole('timer')).toBeVisible();
    await expect(page.getByText('That time was just taken')).toHaveCount(0);
  });
});

test.describe('PP-15..PP-19', () => {
  test('appointments, detail, cancel with policy text, no fee', async ({ page }, info) => {
    await mockApi(page);
    await page.goto('/appointments');
    await expect(page.getByRole('heading', { name: 'Your appointments' })).toBeVisible();
    await axe(page);
    await shot(page, 'pp15-list', info.project.name);
    await page.getByRole('button', { name: 'View details' }).click();
    await expect(page.getByRole('heading', { name: 'Appointment details' })).toBeVisible();
    await axe(page);
    await shot(page, 'pp15-detail', info.project.name);
    await page.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(page.getByRole('heading', { name: 'Cancel this appointment?' })).toBeVisible();
    await expect(page.getByText(/Cancellation policy/)).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(/\bfee\b|charged|\$/i);
    await axe(page);
    await shot(page, 'pp17-cancel', info.project.name);
    await page.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await axe(page);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(
      page.getByRole('heading', { name: 'Your appointment was cancelled' }),
    ).toBeVisible();
  });

  test('change time and waitlist screens pass axe', async ({ page }, info) => {
    await mockApi(page, { slots: [] });
    await page.goto('/appointments/' + RES + '/change');
    await expect(page.getByRole('heading', { name: 'Choose a new time' })).toBeVisible();
    await axe(page);
    await shot(page, 'pp16-change', info.project.name);
    await page.goto('/book');
    await page.getByRole('radio', { name: /General visit/ }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Place').selectOption(PLACE);
    await expect(page.getByLabel('Doctor')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'join the waitlist' }).click();
    await expect(page.getByRole('heading', { name: 'Join the waitlist' })).toBeVisible();
    await axe(page);
    await shot(page, 'pp18-waitlist', info.project.name);
    await page.getByRole('button', { name: 'Join the waitlist' }).click();
    await expect(page.getByRole('heading', { name: 'You are on the waitlist' })).toBeVisible();
    await page.goto(
      '/waitlist/offers/' +
        RES +
        '?expires=' +
        encodeURIComponent(new Date(Date.now() + 600_000).toISOString()),
    );
    await expect(page.getByRole('timer')).toBeVisible();
    await axe(page);
    await shot(page, 'pp19-offer', info.project.name);
  });
});
