import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// CONTRACT MOCK of scheduling.yaml, clinical.yaml and patient.yaml, with response shapes copied from the API controllers on the
// prerequisite branches. No real API, database or identity provider runs in this check; the real journey is for integration.
const LOC = '11111111-1111-4111-8111-111111111111';
const PAT = '22222222-2222-4222-8222-222222222222';
const PAT2 = '33333333-3333-4333-8333-333333333333';
const RES = '44444444-4444-4444-8444-444444444444';
const RES2 = '44444444-4444-4444-8444-444444444445';
const MERGE = '55555555-5555-4555-8555-555555555555';
const shot = (name: string) =>
  fileURLToPath(new URL(`../evidence/screenshots/${name}.png`, import.meta.url));

const FRONT_DESK = [
  'scheduling.check_in',
  'scheduling.queue.manage',
  'patient.read',
  'patient.match',
  'patient.register',
  'clinical.referral.manage',
];
const NURSE = [
  'scheduling.queue.manage',
  'clinical.vitals.record',
  'clinical.triage.record',
  'clinical.chart.read_previsit',
  'patient.read',
];
const LEAD = [...FRONT_DESK, 'patient.merge.request', 'patient.merge.approve'];

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
}

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

interface Model {
  arrivals: Record<string, unknown>[];
  queue: Record<string, unknown>[];
  seen: string[];
  allergies: unknown;
  triage: Record<string, unknown> | null;
  flag: boolean;
}

const arrival = (over: Record<string, unknown>) => ({
  reservationId: RES,
  patientId: PAT,
  patientName: 'Amira Okafor',
  mrn: 'MRN-0000123',
  serviceId: 's',
  clinicianId: 'c',
  mode: 'in_person',
  status: 'confirmed',
  startsAt: iso(-20),
  endsAt: iso(-50),
  checkedInAt: null,
  method: null,
  queueStage: null,
  previsit: null,
  noShowCandidate: false,
  flaggedForStaff: false,
  version: 3,
  ...over,
});

async function mockApi(page: Page, perms: string[], over: Partial<Model> = {}): Promise<Model> {
  const m: Model = {
    arrivals: [
      arrival({
        checkedInAt: iso(25),
        method: 'qr',
        queueStage: 'waiting',
        previsit: { questionnaire: true, consents: false, insurance: true },
        startsAt: iso(30),
        version: 4,
      }),
      arrival({
        reservationId: RES2,
        patientId: PAT2,
        patientName: 'Ben Hartley',
        mrn: 'MRN-0000124',
        startsAt: iso(-15),
        version: 7,
      }),
      arrival({
        reservationId: '44444444-4444-4444-8444-444444444446',
        patientName: 'Chidi Mensah',
        mrn: 'MRN-0000125',
        startsAt: iso(40),
        noShowCandidate: true,
        version: 2,
      }),
    ],
    queue: [
      {
        id: RES,
        patientId: PAT,
        patientName: 'Amira Okafor',
        stage: 'waiting',
        triageCategory: null,
        enteredAt: iso(25),
        stageChangedAt: iso(25),
        waitSeconds: 25 * 60,
        assignedClinicianId: null,
        roomId: null,
        version: 2,
      },
      {
        id: RES2,
        patientId: PAT2,
        patientName: 'Ben Hartley',
        stage: 'triage',
        triageCategory: 'urgent',
        enteredAt: iso(8),
        stageChangedAt: iso(3),
        waitSeconds: 8 * 60,
        assignedClinicianId: 'c',
        roomId: null,
        version: 5,
      },
    ],
    seen: [],
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
    triage: null,
    flag: false,
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
  const banner = () => ({
    patientId: PAT,
    displayName: 'Amira Okafor',
    dateOfBirth: '1984-03-27',
    mrn: 'MRN-0000123',
    allergies: m.allergies,
  });
  const patient = (id: string, mrn: string, given: string) => ({
    id,
    mrn,
    givenName: given,
    familyName: 'Okafor',
    dateOfBirth: '1984-03-27',
    status: 'active',
  });

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    m.seen.push(`${method} ${path}`);
    expect(req.headers()['x-client-release']).toMatch(/^r[1-9][0-9]*\.[0-9a-f]{12}$/);
    const body =
      req.postData() === null
        ? undefined
        : (JSON.parse(req.postData() as string) as Record<string, unknown>);

    if (path === '/api/v1/auth/session')
      return reply(route, 200, {
        displayName: 'Dana',
        audience: 'staff',
        realm: 'google',
        csrfToken: 't',
        idleExpiresAt: iso(-30),
        roles: [{ key: 'front_desk', locationId: LOC }],
        permissions: perms,
        patients: [],
      });
    if (path.endsWith('/arrivals'))
      return reply(route, 200, { items: m.arrivals, nextCursor: null });
    if (path.endsWith('/check-in-qr'))
      return reply(route, 200, {
        token: 'q7Zk3Vn9Lw2Xc8Rb5TgYhA',
        localDate: new Date().toISOString().slice(0, 10),
      });
    if (path.endsWith('/check-in') && method === 'POST') {
      const id = path.split('/')[4];
      m.arrivals = m.arrivals.map((a) =>
        a['reservationId'] === id
          ? {
              ...a,
              checkedInAt: iso(0),
              method: 'desk',
              queueStage: 'waiting',
              previsit: { questionnaire: false, consents: false, insurance: false },
              version: 4,
            }
          : a,
      );
      return reply(route, 200, {
        reservationId: id,
        patientId: PAT2,
        locationId: LOC,
        method: 'desk',
        checkedInAt: iso(0),
        queueEntryId: id,
        previsit: { questionnaire: false, consents: false, insurance: false },
        alreadyCheckedIn: false,
      });
    }
    if (path.endsWith('/no-show')) return reply(route, 200, {});
    if (path.endsWith('/queue')) return reply(route, 200, { items: m.queue, nextCursor: null });
    if (path.startsWith('/api/v1/queue-entries/') && method === 'PUT') {
      const id = path.split('/')[4];
      const e = m.queue.find((q) => q['id'] === id);
      if (e !== undefined) Object.assign(e, { stage: body?.['stage'], version: 99 });
      return reply(route, 200, e);
    }
    if (path === `/api/v1/patients/${PAT}/banner`)
      return reply(route, 200, { patientBanner: banner() });
    if (path.endsWith('/vitals') && method === 'POST') {
      const vitals = (
        (body?.['vitals'] as { loincCode: string; value: number; unit: string }[]) ?? []
      ).map((v, i) => ({
        vitalId: `v${i}`,
        loincCode: v.loincCode,
        value: v.value,
        unit: v.unit,
        measuredAt: iso(0),
        rangeStatus:
          v.loincCode === '8867-4'
            ? 'out_of_range'
            : v.loincCode === '2708-6'
              ? 'in_range'
              : 'no_range',
        rangeLow: v.loincCode === '8867-4' ? 50 : v.loincCode === '2708-6' ? 94 : null,
        rangeHigh: v.loincCode === '8867-4' ? 110 : null,
        correctsId: null,
        enteredInError: false,
      }));
      return reply(route, 201, {
        vitals,
        outOfRange: vitals.filter((v) => v.rangeStatus === 'out_of_range').map((v) => v.loincCode),
        patientBanner: banner(),
      });
    }
    if (path.endsWith('/triage') && method === 'GET')
      return reply(
        route,
        200,
        m.triage === null ? { triage: null } : { triage: m.triage, patientBanner: banner() },
        { ETag: m.triage === null ? 'W/"0"' : 'W/"1"' },
      );
    if (path.endsWith('/triage') && method === 'POST') {
      const redFlag = body?.['category'] === 'emergency';
      m.triage = {
        id: 't1',
        checkInId: RES,
        patientId: PAT,
        category: body?.['category'],
        symptoms: null,
        notes: null,
        redFlag,
        alertId: redFlag ? 'al-1' : null,
        byPrincipalId: 'p',
        assessedAt: iso(0),
        supersedesId: null,
      };
      return reply(
        route,
        201,
        {
          category: body?.['category'],
          redFlag,
          ...(redFlag ? { alertId: 'al-1', advice: 'Call emergency services now.' } : {}),
          triage: m.triage,
          patientBanner: banner(),
        },
        { ETag: 'W/"1"' },
      );
    }
    if (path === `/api/v1/patients/${PAT}/consents`)
      return reply(route, 200, {
        items: [
          {
            id: 'c1',
            patientId: PAT,
            templateKey: 'telehealth',
            templateVersion: 2,
            status: 'pending',
            signedAt: null,
          },
          {
            id: 'c2',
            patientId: PAT,
            templateKey: 'privacy',
            templateVersion: 1,
            status: 'signed',
            signedAt: iso(9999),
          },
          {
            id: 'c3',
            patientId: PAT,
            templateKey: 'photo',
            templateVersion: 1,
            status: 'withdrawn',
            signedAt: iso(9999),
          },
        ],
        nextCursor: null,
      });
    if (path === `/api/v1/patients/${PAT}/questionnaire-responses`)
      return reply(route, 200, {
        items: [
          {
            id: 'q1',
            patientId: PAT,
            reservationId: RES,
            templateKey: 'previsit',
            status: 'submitted',
            submittedAt: iso(60),
            redFlag: false,
          },
        ],
        nextCursor: null,
      });
    if (path.endsWith('/follow-ups') && method === 'GET')
      return reply(route, 200, {
        items: [
          {
            id: 'fu1',
            patientId: PAT,
            locationId: LOC,
            dueOn: '2020-01-01',
            reason: 'Call about missed lab visit',
            status: 'open',
            ownerPrincipalId: null,
            version: 3,
          },
          {
            id: 'fu2',
            patientId: PAT2,
            locationId: LOC,
            dueOn: new Date().toISOString().slice(0, 10),
            reason: 'Referral letter to be sent',
            status: 'open',
            ownerPrincipalId: null,
            version: 1,
          },
        ],
        nextCursor: null,
      });
    if (path === '/api/v1/patients/search')
      return reply(route, 200, { items: [patient(PAT, 'MRN-0000123', 'Amira')], nextCursor: null });
    if (path === '/api/v1/patients/match')
      return reply(route, 200, {
        matchCheckId: 'mc-1',
        candidates: [
          {
            candidateRef: 'r1',
            strength: 'exact',
            matchedFields: ['familyName', 'dateOfBirth'],
            inScope: true,
            display: {
              patientId: PAT,
              mrn: 'MRN-0000123',
              givenName: 'Amira',
              familyName: 'Okafor',
              dateOfBirth: '1984-03-27',
            },
          },
          { candidateRef: 'r2', strength: 'probable', matchedFields: ['phone'], inScope: false },
        ],
      });
    if (path === '/api/v1/patients' && method === 'POST')
      return reply(route, 201, { patientId: PAT2, mrn: 'MRN-0000777', duplicateFlags: 1 });
    if (path === '/api/v1/duplicate-flags')
      return reply(route, 200, {
        items: [
          {
            id: 'f1',
            patientId: PAT,
            candidatePatientId: PAT2,
            strength: 'exact',
            source: 'front_desk',
            status: 'open',
            createdAt: iso(600),
          },
          {
            id: 'f2',
            patientId: PAT,
            candidatePatientId: null,
            strength: 'probable',
            source: 'self_registration',
            status: 'open',
            createdAt: iso(1200),
          },
        ],
        nextCursor: null,
      });
    if (path === `/api/v1/patients/${PAT}`)
      return reply(route, 200, patient(PAT, 'MRN-0000123', 'Amira'));
    if (path === `/api/v1/patients/${PAT2}`)
      return reply(route, 200, patient(PAT2, 'MRN-0000124', 'Amyra'));
    if (path === '/api/v1/patient-merges' && method === 'POST')
      return reply(route, 200, { id: MERGE, status: 'requested' });
    if (path === `/api/v1/patient-merges/${MERGE}`)
      return reply(route, 200, {
        id: MERGE,
        status: 'requested',
        survivorId: null,
        mergedId: null,
        reason: null,
        createdAt: iso(10),
        decidedAt: null,
        failureCode: null,
        counts: null,
      });
    return reply(route, 404, { code: 'kernel.not_found', requestId: 'req-404' });
  });
  return m;
}

// The patient banner is sticky; in a full-page capture it would float over the middle of the page, so captures draw it in flow.
const flow = (page: Page) =>
  page.addStyleTag({ content: '.ehr-patient-banner { position: static !important; }' });
const go = (page: Page, path: string, extra = '') =>
  page.goto(`/?path=${encodeURIComponent(path)}${extra}`);
const prefix = (testInfo: { project: { name: string } }) => testInfo.project.name;

test('arrivals board: pre-visit items, check-in from the board, and an accessible page', async ({
  page,
}, info) => {
  const m = await mockApi(page, FRONT_DESK);
  await go(page, '/arrivals');
  const table = page.getByRole('table', { name: 'Arrivals today' });
  await expect(table.getByText('Amira Okafor')).toBeVisible();
  await expect(table.getByText('Consents: to do')).toBeVisible();
  await expect(table.getByText('Past the grace period')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${prefix(info)}-1-arrivals`), fullPage: true });

  await page.getByRole('button', { name: 'Check in: Ben Hartley' }).click();
  await expect(page.getByText('Ben Hartley is checked in and in the queue.')).toBeVisible();
  expect(m.seen).toContain(`POST /api/v1/appointments/${RES2}/check-in`);
  await page.screenshot({ path: shot(`${prefix(info)}-2-checked-in`), fullPage: true });
});

test('check in: patient search, and the daily QR code', async ({ page }, info) => {
  await mockApi(page, FRONT_DESK);
  await go(page, '/arrivals');
  await page.getByRole('tab', { name: 'Check in' }).click();
  await page.getByLabel('Name').fill('Okafor');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('MRN-0000123 · 1984-03-27')).toBeVisible();
  await page.getByRole('button', { name: /^Show visits: Amira Okafor/ }).click();
  await expect(page.getByText('Visits today: Amira Okafor')).toBeVisible();
  await page.getByRole('button', { name: 'Show the QR code' }).click();
  const qr = page.getByRole('img', { name: "Today's check-in QR code" });
  await expect(qr).toBeVisible();
  await expect(page.getByText('q7Zk3Vn9Lw2Xc8Rb5TgYhA')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${prefix(info)}-3-check-in-qr`), fullPage: true });
});

test('queue: waiting time and stage; then triage with vitals, out-of-range text and the red-flag bar', async ({
  page,
}, info) => {
  await mockApi(page, NURSE);
  await go(page, '/triage');
  const table = page.getByRole('table', { name: 'Queue' });
  await expect(table.getByText('25 min')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${prefix(info)}-4-queue`), fullPage: true });

  await table.getByLabel('Move to').first().selectOption('vitals');
  await table.getByRole('button', { name: 'Move: Amira Okafor' }).click();
  await expect(page.getByText('Amira Okafor moved to Vitals.')).toBeVisible();

  await table.getByRole('button', { name: 'Open triage' }).first().click();
  await expect(page.getByRole('heading', { name: 'Triage and vitals' })).toBeVisible();
  await expect(page.getByText('Penicillin')).toBeVisible();
  if (info.project.name === 'phone') {
    // UI-UX 9: triage entry is not offered under 600 px.
    await expect(
      page.getByText('Open this on a tablet or computer to enter vitals and triage.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save vitals' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Save triage' })).toBeHidden();
    await flow(page);
    await page.screenshot({ path: shot(`${prefix(info)}-5-triage-phone-note`), fullPage: true });
    return;
  }
  await page.getByLabel(/Heart rate/).fill('130');
  await page.getByLabel(/Oxygen saturation/).fill('97');
  await page.getByLabel(/Body temperature/).fill('37.1');
  await page.getByRole('button', { name: 'Save vitals' }).click();
  const list = page.getByRole('list', { name: 'Recorded vitals' });
  await expect(list.getByText('Out of range')).toBeVisible();
  await expect(list.getByText('Range 50-110 /min')).toBeVisible();
  await expect(list.getByText('No reference range set')).toBeVisible();
  await axe(page);
  await flow(page);
  await page.screenshot({ path: shot(`${prefix(info)}-5-vitals`), fullPage: true });

  await page.getByLabel('Triage category').selectOption('emergency');
  await page.getByRole('button', { name: 'Save triage' }).click();
  const bar = page.locator('[data-alert-state="raised"]');
  await expect(bar).toHaveText('Red flag raised. The on-duty doctor has been alerted.');
  await expect(bar.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('Call emergency services now.')).toBeVisible();
  await axe(page);
  await flow(page);
  await page.screenshot({ path: shot(`${prefix(info)}-6-red-flag`), fullPage: true });
});

test('allergy block shows "not shown" for a role without the chart read, never "none"', async ({
  page,
}, info) => {
  await mockApi(page, NURSE, { allergies: null });
  await go(page, '/triage', '&visit=1');
  await expect(page.locator('[data-allergy-state="not-shown"]')).toBeVisible();
  await expect(page.getByText('No allergies recorded')).toHaveCount(0);
  await flow(page);
  await page.screenshot({ path: shot(`${prefix(info)}-7-allergy-hidden`), fullPage: true });
});

test('forms review: to do, done and withdrawn in words', async ({ page }, info) => {
  await mockApi(page, FRONT_DESK);
  await go(page, '/forms', '&visit=1');
  await expect(page.getByText('telehealth v2')).toBeVisible();
  await expect(page.locator('.ehr-chip', { hasText: /^.?Not signed$/ })).toBeVisible();
  await expect(page.locator('.ehr-chip', { hasText: /^.?Withdrawn$/ })).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${prefix(info)}-8-forms`), fullPage: true });
});

test('registration: duplicate warning shows only visible fields and needs a reason to create anyway', async ({
  page,
}, info) => {
  await mockApi(page, FRONT_DESK);
  await go(page, '/arrivals');
  await page.getByRole('tab', { name: 'Register a patient' }).click();
  await page.getByLabel('Given name').fill('Amira');
  await page.getByLabel('Family name').fill('Okafor');
  await page.getByLabel('Date of birth').fill('1984-03-27');
  await page.getByLabel('State').fill('AA');
  await page.getByRole('button', { name: 'Check for an existing record' }).click();
  await expect(
    page.getByText('A record may already exist. Check before creating a new one.'),
  ).toBeVisible();
  await expect(
    page.getByText('A matching record exists outside your locations. Details are not shown.'),
  ).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${prefix(info)}-9-duplicate-warning`), fullPage: true });
  await page.getByRole('button', { name: 'Create anyway (reason required)' }).click();
  await page.getByRole('button', { name: 'Create the new record' }).click();
  await expect(page.getByText('Enter why this is a different person.').first()).toBeVisible();
  await page
    .getByLabel('Why is this a different person?')
    .fill('Different date of birth on the card');
  await page.getByRole('button', { name: 'Create the new record' }).click();
  await expect(page.getByText('Patient registered. MRN MRN-0000777.')).toBeVisible();
});

test('merge: an unauthorised user sees no merge action; a lead requests and a second person approves', async ({
  page,
}, info) => {
  await mockApi(page, FRONT_DESK);
  await go(page, '/arrivals');
  await expect(page.getByRole('tab', { name: 'Merge' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Possible duplicates' }).click();
  await expect(page.locator('.ehr-chip', { hasText: 'Exact' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request a merge' })).toHaveCount(0);
  await page.screenshot({ path: shot(`${prefix(info)}-10-duplicates-no-merge`), fullPage: true });

  await page.unroute('**/api/v1/**');
  await mockApi(page, LEAD);
  await go(page, '/arrivals');
  await page.getByRole('tab', { name: 'Possible duplicates' }).click();
  await page.getByRole('button', { name: 'Request a merge' }).click();
  await expect(page.getByText('Amira Okafor · MRN-0000123 · 1984-03-27')).toBeVisible();
  await page.getByLabel('MRN of the record to keep').fill('MRN-0000123');
  await page.getByLabel('Reason for the merge').fill('Same person registered twice');
  await axe(page);
  await page.screenshot({ path: shot(`${prefix(info)}-11-merge-request`), fullPage: true });
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(
    page.getByText('Merge request sent. A second staff member must approve it.'),
  ).toBeVisible();

  await page.getByLabel('Merge request reference').fill(MERGE);
  await page.getByRole('button', { name: 'Open request' }).click();
  await expect(page.getByText('Waiting for approval')).toBeVisible();
  await page.getByRole('button', { name: 'Approve merge' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.screenshot({ path: shot(`${prefix(info)}-12-merge-approve`), fullPage: true });
});

test('follow-ups and no-shows', async ({ page }, info) => {
  await mockApi(page, FRONT_DESK);
  await go(page, '/follow-ups');
  await expect(page.getByText('Overdue')).toBeVisible();
  await expect(page.getByText('Due today')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${prefix(info)}-13-follow-ups`), fullPage: true });
  await page.getByRole('tab', { name: 'No-shows' }).click();
  await expect(page.getByText('Chidi Mensah')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${prefix(info)}-14-no-shows`), fullPage: true });
});
