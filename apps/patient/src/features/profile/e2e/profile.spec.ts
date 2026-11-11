import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// CONTRACT MOCK of the patient, identity, privacy and messaging APIs (patient.yaml, identity.yaml, privacy.yaml, messaging.yaml).
// No real API or database runs in this check. It shows the screens, their states and the requests they send, not the server.
const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '77777777-7777-4777-8777-777777777777';
const GRANT = '88888888-8888-4888-8888-888888888888';
const REQ = '99999999-9999-4999-8999-999999999999';
const THREAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ME_PRINCIPAL = '11111111-1111-4111-8111-111111111111';

const profile = {
  id: ME,
  givenName: 'Sam',
  familyName: 'Example',
  dateOfBirth: '1990-04-12',
  phone: '+15550100100',
  email: 'sam@example.test',
  address: { line1: '1 Test Street', city: 'Testville', postalCode: '10001' },
  stateCode: 'AA',
  preferredLanguage: 'en',
  preferredPharmacy: { name: 'Corner Pharmacy' },
  version: 3,
  contacts: [
    {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      kind: 'emergency',
      name: 'Alex Example',
      relationship: 'sibling',
      phone: '+15550100200',
      email: null,
      rowVersion: 2,
    },
  ],
};
const request = (over = {}) => ({
  id: REQ,
  patientId: ME,
  kind: 'export',
  channel: 'portal',
  status: 'received',
  detail: null,
  decisionReason: null,
  dueAt: '2031-07-10T12:00:00.000Z',
  createdAt: '2031-06-10T12:00:00.000Z',
  package: null,
  version: 1,
  ...over,
});

interface Opts {
  proxies?: unknown[];
  people?: unknown[];
  requests?: unknown[];
  messagingOn?: boolean;
  proxyRules?: boolean;
}
interface Mock {
  seen: { key: string; body: unknown; headers: Record<string, string> }[];
}

async function mockApi(page: Page, opts: Opts = {}): Promise<Mock> {
  const seen: Mock['seen'] = [];
  let requests = opts.requests ?? [];
  const reply = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
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
    const key = `${req.method()} ${path}`;
    const text = req.postData();
    seen.push({ key, body: text ? JSON.parse(text) : undefined, headers: req.headers() });
    switch (key) {
      case 'GET /api/v1/auth/session':
        return reply(route, {
          principalId: ME_PRINCIPAL,
          realm: 'patient',
          audience: 'patient',
          displayName: 'Test Patient',
          csrfToken: 'csrf-e2e',
          idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          roles: [],
          permissions: [],
          patients: opts.people ?? [{ patientId: ME, relation: 'self', scope: 'full' }],
        });
      case `GET /api/v1/patients/${ME}/profile`:
        return reply(route, profile, 200, { etag: 'W/"3"' });
      case `PATCH /api/v1/patients/${ME}/profile`:
        expect(req.headers()['if-match']).toBe('W/"3"');
        expect(req.headers()['x-csrf-token']).toBe('csrf-e2e');
        return reply(
          route,
          { ...profile, ...(JSON.parse(text ?? '{}') as object), version: 4 },
          200,
          { etag: 'W/"4"' },
        );
      case `GET /api/v1/patients/${ME}/communication-preferences`:
        return reply(
          route,
          {
            patientId: ME,
            channels: ['email', 'in_app'],
            reminderChannel: null,
            language: 'en',
            quietHours: null,
            marketingOptIn: false,
            stored: true,
            rowVersion: 4,
          },
          200,
          { etag: 'W/"4"' },
        );
      case `PUT /api/v1/patients/${ME}/communication-preferences`:
        return reply(
          route,
          {
            patientId: ME,
            ...(JSON.parse(text ?? '{}') as object),
            marketingOptIn: false,
            stored: true,
            rowVersion: 5,
          },
          200,
          { etag: 'W/"5"' },
        );
      case `GET /api/v1/patients/${ME}/proxies`:
        return reply(route, { items: opts.proxies ?? [], nextCursor: null });
      case `DELETE /api/v1/patients/${ME}/proxies/${GRANT}`:
        return reply(route, {});
      case `POST /api/v1/patients/${ME}/proxy-requests`:
        expect(req.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
        return opts.proxyRules
          ? reply(route, {}, 201)
          : reply(
              route,
              { status: 422, code: 'identity.proxy_rules_not_configured', requestId: 'req-d7' },
              422,
            );
      case 'GET /api/v1/privacy-requests':
        return reply(route, { items: requests, nextCursor: null });
      case 'POST /api/v1/privacy-requests': {
        const body = JSON.parse(text ?? '{}') as { kind: string };
        const made = request({
          kind: body.kind,
          status: body.kind === 'deletion' ? 'blocked_d8' : 'received',
        });
        requests = [made, ...requests];
        return reply(route, made, 201);
      }
      case `GET /api/v1/patients/${ME}/threads`:
        if (!opts.messagingOn)
          return reply(
            route,
            { status: 404, code: 'kernel.not_found', requestId: 'req-flag' },
            404,
          );
        return reply(route, {
          items: [
            {
              id: THREAD,
              kind: 'patient',
              patientId: ME,
              subject: 'Question about my visit',
              status: 'open',
              unread: 1,
              version: 1,
              messages: [
                {
                  id: 'm1',
                  authorPrincipalId: ME_PRINCIPAL,
                  body: 'Hello there',
                  sentAt: '2031-06-10T12:00:00.000Z',
                },
                {
                  id: 'm2',
                  authorPrincipalId: OTHER,
                  body: 'We got your note',
                  sentAt: '2031-06-10T13:00:00.000Z',
                },
              ],
            },
          ],
          nextCursor: null,
        });
      default:
        return reply(route, { status: 404, code: 'kernel.not_found', requestId: 'req-e2e' }, 404);
    }
  });
  return { seen };
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

test.describe('PP-35 profile', () => {
  test('edit a detail, see what changed, with axe', async ({ page }, info) => {
    const m = await mockApi(page);
    await page.goto('/profile');
    await expect(page.getByRole('heading', { name: 'Your details' })).toBeVisible();
    await axe(page);
    await shot(page, 'pp35-profile', info.project.name);
    await page.getByLabel('Phone number').fill('555 010 0999');
    await page.getByRole('button', { name: 'Save my details' }).click();
    await expect(page.getByText('Your details were saved')).toBeVisible();
    await expect(page.getByText(/Changed: Phone number/)).toBeVisible();
    await axe(page);
    await shot(page, 'pp35-saved', info.project.name);
    expect(m.seen.find((s) => s.key.startsWith('PATCH'))?.body).toEqual({ phone: '555 010 0999' });
  });

  test('a bad email shows the summary and inline error, with axe', async ({ page }, info) => {
    await mockApi(page);
    await page.goto('/profile');
    await page.getByLabel('Email address').fill('nope');
    await page.getByRole('button', { name: 'Save my details' }).click();
    await expect(page.getByRole('alert')).toContainText('Email address: enter it like');
    await axe(page);
    await shot(page, 'pp35-error', info.project.name);
  });
});

test.describe('PP-36 notification preferences', () => {
  test('the portal channel is locked on; save keeps it', async ({ page }, info) => {
    const m = await mockApi(page);
    await page.goto('/profile/notifications');
    const portal = page.getByRole('checkbox', { name: 'In the patient portal' });
    await expect(portal).toBeChecked();
    await expect(portal).toBeDisabled();
    await axe(page);
    await shot(page, 'pp36-preferences', info.project.name);
    await page.getByRole('checkbox', { name: 'Email' }).uncheck();
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByText('Your preferences were saved')).toBeVisible();
    expect(
      (m.seen.find((s) => s.key.startsWith('PUT'))?.body as { channels: string[] }).channels,
    ).toEqual(['in_app']);
    await axe(page);
  });
});

test.describe('PP-06..PP-09 family and proxies', () => {
  test('list with status, remove access with confirmation, axe', async ({ page }, info) => {
    const m = await mockApi(page, {
      proxies: [
        {
          id: GRANT,
          patientId: ME,
          relationship: 'parent',
          scope: 'appointments',
          patientDisplayName: 'Pat P',
          status: 'requested',
        },
      ],
      people: [
        { patientId: ME, relation: 'self', scope: 'full' },
        { patientId: OTHER, relation: 'proxy', scope: 'appointments', displayName: 'Jo K' },
      ],
    });
    await page.goto('/family');
    await expect(page.getByText('Waiting for the clinic to check')).toBeVisible();
    await expect(page.getByText(/can see your appointments only/).first()).toBeVisible();
    await axe(page);
    await shot(page, 'pp06-family', info.project.name);
    await page.getByRole('button', { name: 'Remove access' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await axe(page);
    await shot(page, 'pp08-remove', info.project.name);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove access' }).click();
    await expect(page.getByText(/Access was removed/)).toBeVisible();
    expect(m.seen.some((s) => s.key.startsWith('DELETE'))).toBe(true);
  });

  test('PP-07 while D-7 is not configured: not open yet, never "sent"', async ({ page }, info) => {
    await mockApi(page);
    await page.goto('/family/add');
    await page.getByLabel('Their name').fill('Pat P');
    await axe(page);
    await shot(page, 'pp07-add', info.project.name);
    await page.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByText('Linking family members is not open yet')).toBeVisible();
    await expect(page.getByText('Request sent')).toHaveCount(0);
    await axe(page);
    await shot(page, 'pp07-not-open', info.project.name);
  });
});

test.describe('PP-24 my privacy', () => {
  test('export and deletion are recorded without promising deletion', async ({ page }, info) => {
    const m = await mockApi(page);
    await page.goto('/privacy');
    await expect(page.getByText('You have not made any privacy requests.')).toBeVisible();
    await axe(page);
    await shot(page, 'pp24-privacy', info.project.name);
    await page.getByRole('button', { name: 'Request account deletion' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('It does not delete anything now');
    await axe(page);
    await shot(page, 'pp24-deletion-dialog', info.project.name);
    await dialog.getByRole('button', { name: 'Record my deletion request' }).click();
    await expect(page.getByText('Your deletion request was recorded')).toBeVisible();
    await expect(page.getByText('Recorded, waiting for a decision')).toBeVisible();
    await axe(page);
    await shot(page, 'pp24-deletion-recorded', info.project.name);
    expect(m.seen.find((s) => s.key === 'POST /api/v1/privacy-requests')?.body).toEqual({
      kind: 'deletion',
    });
    await page.getByRole('button', { name: 'Request a copy of my data' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Request my data' }).click();
    await expect(page.getByText('Your request was recorded')).toBeVisible();
    await axe(page);
  });
});

test.describe('PP-37 messages (flagged)', () => {
  test('flag off: reads as a page that does not exist', async ({ page }, info) => {
    await mockApi(page, { messagingOn: false });
    await page.goto('/messages');
    await expect(page.getByText(/We can.t find this, or it isn.t available to you/)).toBeVisible();
    await axe(page);
    await shot(page, 'pp37-flag-off', info.project.name);
  });

  test('flag on: list and thread', async ({ page }, info) => {
    await mockApi(page, { messagingOn: true });
    await page.goto('/messages');
    await expect(page.getByText('1 new')).toBeVisible();
    await axe(page);
    await shot(page, 'pp37-list', info.project.name);
    await page.getByRole('link', { name: 'Question about my visit' }).click();
    await expect(page.getByText('Care team')).toBeVisible();
    await axe(page);
    await shot(page, 'pp37-thread', info.project.name);
  });
});
