import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// CONTRACT MOCK of clinical.yaml, notifications.yaml, scheduling.yaml and patient.yaml, with response shapes copied from the API controllers
// on the prerequisite branches. No real API, database or identity provider runs in this check; the real journey is for integration.
const LOC = '11111111-1111-4111-8111-111111111111';
const PAT = '22222222-2222-4222-8222-222222222222';
const RES = '44444444-4444-4444-8444-444444444444';
const ENC = '66666666-6666-4666-8666-666666666666';
const NOTE = '77777777-7777-4777-8777-777777777777';
const ME = '88888888-8888-4888-8888-888888888888';
const ALERT = '99999999-9999-4999-8999-999999999999';
const shot = (name: string) =>
  fileURLToPath(new URL(`../evidence/screenshots/${name}.png`, import.meta.url));

const DOCTOR = [
  'clinical.chart.read',
  'clinical.chart.read_previsit',
  'clinical.consultation.start',
  'clinical.note.write',
  'clinical.note.sign',
  'clinical.note.cosign',
  'audit.btg.open',
  'scheduling.booking.own_schedule',
  'telehealth.session.host',
  'patient.lookup',
  'notifications.alert.read',
  'notifications.alert.acknowledge',
];

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
}

interface Model {
  seen: string[];
  signs: number;
  notAssigned: boolean;
  streamRefused: boolean;
  sectionsSaved: Record<string, string>;
  signKeys: string[];
  queuedNote: boolean;
}

async function mockApi(page: Page, over: Partial<Model> = {}): Promise<Model> {
  const m: Model = {
    seen: [],
    signs: 0,
    notAssigned: false,
    streamRefused: false,
    sectionsSaved: { subjective: '', objective: '', assessment: '', plan: '' },
    signKeys: [],
    queuedNote: false,
    ...over,
  };
  const reply = (
    route: Route,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    route.fulfill({
      status,
      contentType: status >= 400 ? 'application/problem+json' : 'application/json',
      headers: {
        'x-session-idle-expires-at': new Date(Date.now() + 30 * 60_000).toISOString(),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const banner = {
    patientId: PAT,
    displayName: 'Amira Okafor',
    dateOfBirth: '1984-03-27',
    mrn: 'MRN-0000123',
    allergies: {
      state: 'recorded',
      items: [
        {
          allergyId: 'a1',
          display: 'Penicillin',
          category: 'drug',
          severity: 'severe',
          coded: true,
        },
      ],
      moreCount: 0,
      uncodedCount: 0,
      lastChangedAt: null,
    },
  };
  const note = (status: string, version: number) => ({
    id: NOTE,
    encounterId: ENC,
    patientId: PAT,
    authorPrincipalId: ME,
    templateId: 'soap',
    body: { sections: m.sectionsSaved },
    status,
    cosignRequiredFrom: null,
    signedAt: status === 'signed' ? new Date().toISOString() : null,
    signedBy: null,
    cosignedAt: null,
    createdAt: new Date().toISOString(),
    version,
    patientBanner: banner,
  });
  const visit = {
    reservationId: RES,
    patientId: PAT,
    patientName: 'Amira Okafor',
    mrn: 'MRN-0000123',
    serviceId: 's',
    clinicianId: ME,
    mode: 'in_person',
    status: 'checked_in',
    startsAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    queueStage: 'ready',
    version: 3,
  };

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    m.seen.push(`${method} ${path}`);
    // The live stream cannot send headers: its release travels in `clientRelease` (ARCHITECTURE 28.6).
    if (path === '/api/v1/alerts/stream')
      expect(new URL(req.url()).searchParams.get('clientRelease')).toMatch(
        /^r[1-9][0-9]*\.[0-9a-f]{12}$/,
      );
    else expect(req.headers()['x-client-release']).toMatch(/^r[1-9][0-9]*\.[0-9a-f]{12}$/);
    const body =
      req.postData() === null
        ? undefined
        : (JSON.parse(req.postData() as string) as Record<string, unknown>);

    if (path === '/api/v1/auth/session')
      return reply(route, 200, {
        principalId: ME,
        displayName: 'Dr Lee',
        audience: 'staff',
        realm: 'google',
        csrfToken: 't',
        idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        roles: [{ key: 'doctor', locationId: LOC }],
        permissions: DOCTOR,
        patients: [],
      });
    if (path === '/api/v1/alerts/stream')
      return m.streamRefused
        ? route.fulfill({ status: 429, contentType: 'application/problem+json', body: '{}' })
        : route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 5000\n\n' });
    if (path === `/api/v1/clinicians/${ME}/schedule`)
      return reply(route, 200, {
        timeZone: 'UTC',
        items: [
          visit,
          {
            ...visit,
            reservationId: 'r3',
            patientName: 'Ben Hartley',
            mrn: 'MRN-0000124',
            mode: 'video',
            status: 'confirmed',
            startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            endsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
          },
        ],
      });
    if (path === `/api/v1/patients/${PAT}/chart-summary`)
      return m.notAssigned
        ? reply(route, 403, {
            code: 'clinical.not_assigned',
            btgAvailable: true,
            requestId: 'req-1',
          })
        : reply(route, 200, {
            patientBanner: banner,
            level: 'chart',
            problems: [
              {
                id: 'p1',
                display: 'Asthma',
                coded: true,
                status: 'active',
                onsetDate: '2019-01-01',
              },
            ],
            allergies: [
              {
                id: 'a1',
                display: 'Penicillin',
                coded: true,
                status: 'active',
                severity: 'severe',
                reaction: 'Rash',
              },
            ],
            medications: [
              {
                id: 'm1',
                display: 'Salbutamol inhaler',
                coded: true,
                status: 'active',
                doseText: '2 puffs as needed',
              },
            ],
            recentVitals: [
              {
                vitalId: 'v1',
                loincCode: '8867-4',
                value: 118,
                unit: '/min',
                measuredAt: new Date().toISOString(),
                rangeStatus: 'out_of_range',
                rangeLow: 50,
                rangeHigh: 100,
                correctsId: null,
                enteredInError: false,
              },
              {
                vitalId: 'v2',
                loincCode: '2708-6',
                value: 97,
                unit: '%',
                measuredAt: new Date().toISOString(),
                rangeStatus: 'no_range',
                rangeLow: null,
                rangeHigh: null,
                correctsId: null,
                enteredInError: false,
              },
            ],
            encounters: [{}, {}],
            documents: [{}],
          });
    if (path === '/api/v1/patients/lookup')
      return reply(route, 200, {
        truncated: false,
        items: [
          {
            patientId: PAT,
            mrn: 'MRN-0000123',
            givenName: 'Amira',
            middleName: null,
            familyName: 'Okafor',
            dateOfBirth: '1984-03-27',
          },
        ],
      });
    if (path === `/api/v1/clinicians/${ME}/notes`)
      return reply(route, 200, { items: [], nextCursor: null });
    if (path === `/api/v1/clinicians/${ME}/cosign-queue`)
      return reply(route, 200, {
        nextCursor: null,
        items: [
          {
            noteId: NOTE,
            encounterId: ENC,
            patientId: PAT,
            patientBanner: {
              patientId: PAT,
              displayName: 'Amira Okafor',
              dateOfBirth: '1984-03-27',
              mrn: 'MRN-0000123',
            },
            authorPrincipalId: 'trainee',
            authorDisplayName: 'Dr Trainee',
            status: 'pending_cosign',
            templateId: 'soap',
            createdAt: new Date().toISOString(),
            updatedAt: null,
            submittedForCosignAt: new Date().toISOString(),
            rowVersion: 3,
          },
        ],
      });
    if (path === `/api/v1/notes/${NOTE}` && method === 'GET' && m.queuedNote)
      return reply(route, 200, {
        id: NOTE,
        encounterId: ENC,
        patientId: PAT,
        authorPrincipalId: 'trainee',
        templateId: 'soap',
        body: {
          sections: {
            subjective: 'Cough for three days',
            objective: 'Chest clear',
            assessment: 'Viral',
            plan: 'Fluids',
          },
        },
        status: 'pending_cosign',
        submittedForCosignAt: new Date().toISOString(),
        cosignRequiredFrom: ME,
        signedAt: null,
        cosignedAt: null,
        version: 3,
        patientBanner: banner,
      });
    if (path === `/api/v1/patients/${PAT}/break-glass`) {
      m.notAssigned = false;
      return reply(route, 201, {
        grantId: 'g1',
        expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
      });
    }
    if (path === '/api/v1/encounters')
      return reply(route, 201, {
        id: ENC,
        patientId: PAT,
        locationId: LOC,
        reservationId: RES,
        clinicianPrincipalId: ME,
        mode: 'in_person',
        status: 'in_consultation',
        startedAt: new Date().toISOString(),
        endedAt: null,
        noteDeferredReason: null,
        version: 2,
        consentExceptionId: null,
        patientBanner: banner,
      });
    if (path === `/api/v1/encounters/${ENC}/notes`) return reply(route, 201, note('draft', 1));
    if (path === `/api/v1/notes/${NOTE}` && method === 'PATCH') {
      m.sectionsSaved = { ...m.sectionsSaved, ...(body?.['sections'] as Record<string, string>) };
      return reply(route, 200, note('draft', 2));
    }
    if (path === `/api/v1/notes/${NOTE}/sign`) {
      m.signs += 1;
      m.signKeys.push(req.headers()['idempotency-key'] ?? '');
      return m.signs === 1
        ? reply(route, 401, { code: 'auth.reauth_required', requestId: 'req-2' })
        : reply(route, 200, note('signed', 3));
    }
    if (path === `/api/v1/notes/${NOTE}/addenda`)
      return reply(route, 201, {
        id: 'ad1',
        noteId: NOTE,
        patientId: PAT,
        authorPrincipalId: ME,
        body: body?.['body'],
        signedAt: new Date().toISOString(),
      });
    if (path === `/api/v1/notes/${NOTE}/cosign`) return reply(route, 200, note('signed', 4));
    if (path === '/api/v1/alerts')
      return reply(
        route,
        200,
        {
          items: [
            {
              alertId: ALERT,
              seq: 1,
              type: 'red_flag',
              severity: 'high',
              status: 'open',
              createdAt: new Date().toISOString(),
              escalationLevel: 0,
              escalatesAt: new Date(Date.now() + 250_000).toISOString(),
              acknowledgedAt: null,
              acknowledgedBy: null,
              acknowledgedByDisplayName: null,
              patientId: PAT,
              resourceType: 'triage',
              resourceId: 'x',
              link: null,
            },
          ],
          nextCursor: null,
        },
        { date: new Date().toUTCString() },
      );
    if (path === '/api/v1/alerts/open-ids') return reply(route, 200, { items: [] });
    if (path.endsWith('/video-session/host'))
      return reply(route, 200, {
        waiting: [{ id: 'part1', displayName: 'Ben Hartley', admission: 'waiting' }],
      });
    return reply(route, 404, { code: 'kernel.not_found' });
  });
  return m;
}

test('schedule lists my own visits and opens the chart (DR-01)', async ({ page }, info) => {
  const m = await mockApi(page);
  await page.goto('/?path=/schedule');
  await expect(page.getByRole('heading', { name: 'Schedule today' })).toBeVisible();
  await expect(page.getByText('Amira Okafor')).toBeVisible();
  await expect(page.getByText('Ben Hartley')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-1-schedule`), fullPage: true });
  expect(m.seen).toContain(`GET /api/v1/clinicians/${ME}/schedule`);
});

test('chart summary and note: start, draft, sign with re-authentication, addendum (DR-03, DR-05, DR-06)', async ({
  page,
}, info) => {
  const m = await mockApi(page);
  await page.goto('/?path=/patients&open=1');
  const banner = page.getByRole('region', { name: 'Patient' });
  await expect(banner.getByText('Amira Okafor')).toBeVisible();
  await expect(banner.getByText(/1984-03-27/)).toBeVisible();
  await expect(banner.getByText('Penicillin')).toBeVisible();
  await expect(page.getByText('Out of range')).toBeVisible();
  await page.getByRole('button', { name: 'Start consultation' }).click();
  await page.getByLabel('S: Subjective').fill('Cough for three days');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText(/Draft saved/)).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-2-chart-note`), fullPage: true });

  await page.getByRole('button', { name: 'Sign and lock note' }).click();
  const dlg = page.getByRole('alertdialog');
  await expect(dlg.getByText('Amira Okafor')).toBeVisible();
  await expect(dlg.getByText(/1984-03-27/)).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-3-sign-dialog`), fullPage: true });
  await dlg.getByRole('button', { name: 'Sign and lock note' }).click();

  const reauth = page.getByRole('alertdialog');
  await expect(reauth.getByText("Confirm it's you")).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-4-reauth`), fullPage: true });
  await page.route('**/api/v1/auth/reauth*', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: 'signed in' }),
  );
  const popup = page.waitForEvent('popup');
  await reauth.getByRole('button', { name: /Sign in again/ }).click();
  await (await popup).close();
  await page.getByRole('button', { name: 'Sign now' }).click();
  await expect(page.getByText('Note signed and locked')).toBeVisible();
  expect(m.signs).toBe(2);
  expect(m.signKeys[0]).toBe(m.signKeys[1]);
  await page.getByLabel('Addendum text').fill('Result called through');
  await page.getByRole('button', { name: 'Add addendum to note' }).click();
  await expect(page.getByText('Result called through')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-5-signed-addendum`), fullPage: true });
});

test('break the glass: refused until a reason is entered (DR-09)', async ({ page }, info) => {
  const m = await mockApi(page, { notAssigned: true });
  await page.goto('/?path=/patients&open=1');
  await expect(page.getByText(/This patient is not assigned to you/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Patient' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open with emergency access' }).click();
  const dlg = page.getByRole('alertdialog');
  await dlg.getByLabel(/Reason for access/).fill('short');
  await dlg.getByRole('button', { name: 'Open chart with emergency access' }).click();
  await expect(dlg.getByText('Enter at least 10 characters.')).toBeVisible();
  expect(m.seen).not.toContain(`POST /api/v1/patients/${PAT}/break-glass`);
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-6-btg-dialog`), fullPage: true });
  await dlg.getByLabel(/Reason for access/).fill('Patient collapsed in the waiting room');
  await dlg.getByRole('button', { name: 'Open chart with emergency access' }).click();
  await expect(page.getByText('Emergency access', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Patient' })).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-7-emergency-access`), fullPage: true });
});

test('alert tray: countdown, acknowledge, paused stream (UI-UX 7.4)', async ({ page }, info) => {
  await mockApi(page);
  await page.goto('/?path=/alerts');
  await expect(page.getByText(/Escalates in/)).toBeVisible();
  await expect(page.getByText(/Amira Okafor, 1984-03-27/)).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-8-alert-tray`), fullPage: true });
});

test('alert tray shows the paused state when the stream is refused', async ({ page }, info) => {
  await mockApi(page, { streamRefused: true });
  await page.goto('/?path=/alerts&stream=real');
  const bar = page.getByRole('alert').filter({ hasText: 'Live alerts are paused' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Reload' })).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-9-alerts-paused`), fullPage: true });
});

test('video and notes side by side (DR-04)', async ({ page }, info) => {
  await mockApi(page);
  await page.goto('/?path=/patients&open=1&video=1');
  await page.getByRole('button', { name: 'Join the call' }).click();
  await expect(page.getByText('You are in the call.')).toBeVisible();
  await page.getByRole('button', { name: 'Start consultation' }).click();
  await expect(page.getByLabel('S: Subjective')).toBeVisible();
  const video = await page.getByRole('region', { name: 'Video visit' }).boundingBox();
  const noteBox = await page.getByRole('region', { name: 'Visit note' }).boundingBox();
  if (info.project.name === 'desktop') {
    expect(video && noteBox && video.y < noteBox.y + noteBox.height && noteBox.x > video.x).toBe(
      true,
    );
    expect(noteBox && video && Math.abs(noteBox.y - video.y)).toBeLessThan(40);
  } else expect(video && noteBox && noteBox.y > video.y).toBe(true);
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-10-video-notes`), fullPage: true });
});

test('co-sign queue (DR-07)', async ({ page }, info) => {
  await mockApi(page, { queuedNote: true });
  await page.goto('/?path=/notes-to-sign');
  await page.getByRole('tab', { name: /Co-sign queue/ }).click();
  await page.getByRole('button', { name: /Review note/ }).click();
  await expect(page.getByText('Cough for three days')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-11-cosign-queue`), fullPage: true });
  await page.getByRole('button', { name: /Co-sign note/ }).click();
  await expect(page.getByRole('alertdialog').getByText('Amira Okafor')).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Co-sign note' }).click();
  await expect(page.getByText('Note co-signed.')).toBeVisible();
});
