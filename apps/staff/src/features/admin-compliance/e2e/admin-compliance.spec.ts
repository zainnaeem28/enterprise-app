import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// CONTRACT MOCK of audit.yaml, identity.yaml and privacy.yaml admin routes (bodies copied from the BE-24, BE-05 and BE-20
// controllers). No real API, database or security key runs here; the journey against the real API happens on the integrated
// candidate (INT-04). The scripted key stands in for the physical one (Pending-human).
const shot = (name: string) =>
  fileURLToPath(new URL(`../evidence/screenshots/${name}.png`, import.meta.url));

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
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
const event = (n: number, over: Record<string, unknown> = {}) => ({
  eventId: id(n),
  occurredAt: '2026-11-08T10:00:00.000Z',
  actorPersonId: id(90),
  action: 'view',
  resourceType: 'clinical.chart',
  resourceId: id(n + 10),
  patientId: id(70),
  outcome: 'allowed',
  denialReason: null,
  ...over,
});
const grant = {
  id: id(1),
  holderPersonId: id(80),
  patientId: id(70),
  reason: 'Patient collapsed in waiting room',
  openedAt: '2026-11-08T09:00:00.000Z',
  expiresAt: '2026-11-08T13:00:00.000Z',
  revokedAt: null,
  reviewStatus: 'pending',
  review: null,
};

async function mock(page: Page, opts: { selfReview?: boolean } = {}) {
  const seen: string[] = [];
  let polls = 0;
  await page.route('**/api/v1/admin/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const call = `${req.method()} ${path}`;
    seen.push(call);
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
    if (path.endsWith('/audit-events/search'))
      return route.fulfill(
        ok({
          items: [
            event(1),
            event(2, {
              outcome: 'denied',
              action: 'read',
              actorPersonId: null,
              denialReason: 'forbidden',
            }),
          ],
          truncated: false,
        }),
      );
    if (req.method() === 'POST' && path.endsWith('/audit-exports'))
      return route.fulfill(ok({ id: id(50), status: 'queued' }));
    if (path.endsWith(`/audit-exports/${id(50)}`)) {
      polls += 1;
      return route.fulfill(
        ok(
          polls < 2
            ? { id: id(50), status: 'running', rowCount: null, expiresAt: null }
            : { id: id(50), status: 'ready', rowCount: 2, expiresAt: '2030-01-01T00:00:00Z' },
        ),
      );
    }
    if (path.endsWith('/btg-grants'))
      return route.fulfill(ok({ items: [grant], nextCursor: null }));
    if (path.endsWith('/review'))
      return route.fulfill(
        opts.selfReview === true
          ? problem(403, 'audit.self_review')
          : ok({ id: id(1), reviewStatus: 'not_justified' }),
      );
    if (path.endsWith('/principals'))
      return route.fulfill(
        ok({
          items: [
            {
              principalId: id(1),
              realm: 'admin_pool',
              handle: 'admin.one',
              status: 'active',
              displayName: 'Admin One',
            },
          ],
          nextCursor: null,
        }),
      );
    if (path.endsWith('/roles'))
      return route.fulfill(
        ok({
          items: [
            {
              key: 'compliance_officer',
              realm: 'admin_pool',
              privileged: true,
              locationBound: false,
              description: '',
              permissions: [],
            },
          ],
          nextCursor: null,
        }),
      );
    if (path.endsWith('/role-change-requests'))
      return route.fulfill(
        ok({
          id: id(60),
          status: 'requested',
          subjectPrincipalId: id(1),
          requesterPersonId: id(91),
          approverPersonId: null,
          add: [{ roleKey: 'compliance_officer' }],
          remove: [],
          before: [],
          expiresAt: '2030-01-01T00:00:00Z',
          decidedAt: null,
        }),
      );
    if (path.endsWith('/approve')) return route.fulfill(problem(403, 'identity.self_approval'));
    if (path.endsWith('/privacy-requests'))
      return route.fulfill(
        ok({
          items: [
            {
              id: id(3),
              patientId: id(70),
              kind: 'export',
              channel: 'portal',
              status: 'received',
              detail: null,
              verificationMethod: null,
              verifiedAt: null,
              decidedAt: null,
              decisionReason: null,
              dueAt: '2026-12-01T00:00:00.000Z',
              legalHold: null,
              package: null,
              createdAt: '2026-11-07T08:00:00.000Z',
              version: 1,
            },
          ],
          nextCursor: null,
        }),
      );
    return route.fulfill(problem(404, 'kernel.not_found'));
  });
  return seen;
}

test('audit log: filters, allowed and denied in words, export with job state and the ready notice', async ({
  page,
}, info) => {
  const seen = await mock(page);
  await page.goto('/admin/audit');
  await expect(
    page.getByText('Administrator sign-in. Clinical data is not available here.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByRole('table', { name: 'Audit log' })).toBeVisible();
  await expect(page.getByText('Denied')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-1-audit-log`), fullPage: true });

  await page
    .getByLabel('Why do you need this export?')
    .fill('Quarterly access review for the board');
  await page.getByRole('button', { name: 'Request export' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Confirm with your security key' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Export the audit log');
  await dialog.getByRole('button', { name: 'Use security key' }).click();
  await expect(page.getByText('Export requested. It is waiting to start.')).toBeVisible();
  await page.screenshot({ path: shot(`${info.project.name}-2-export-queued`), fullPage: true });
  await expect(page.getByText(/Your export is ready/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Download export' })).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-3-export-ready`), fullPage: true });
  expect(seen.filter((c) => c.includes('/elevation/'))).toHaveLength(2);
});

test('audit log: a period over 31 days is refused before any call', async ({ page }) => {
  const seen = await mock(page);
  await page.goto('/admin/audit');
  await page.getByLabel('From').fill('2026-01-01T00:00');
  await page.getByLabel('To').fill('2026-11-01T00:00');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(
    page.getByRole('alert').getByText('Choose a period of 31 days or less.'),
  ).toBeVisible();
  expect(seen.filter((c) => c.includes('audit-events'))).toHaveLength(0);
  await axe(page);
});

test('break-the-glass review: decision needs a note, the key, and a second person', async ({
  page,
}, info) => {
  await mock(page);
  await page.goto('/admin/btg');
  await expect(page.getByText('Patient collapsed in waiting room').first()).toBeVisible();
  await page.getByRole('button', { name: /^Review: access opened/ }).click();
  await page.getByRole('button', { name: 'Record decision' }).click();
  await expect(page.getByText('Choose justified or not justified.').first()).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-4-btg-review`), fullPage: true });
  await page.getByLabel('Not justified').check();
  await page.getByLabel('Note').fill('No treating relationship found');
  await page.getByRole('button', { name: 'Record decision' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Use security key' }).click();
  await expect(page.getByText('Decision recorded: Not justified.')).toBeVisible();
  await page.screenshot({ path: shot(`${info.project.name}-5-btg-decided`), fullPage: true });
});

test('break-the-glass review: the holder is told they cannot review their own access', async ({
  page,
}) => {
  await mock(page, { selfReview: true });
  await page.goto('/admin/btg');
  await page.getByRole('button', { name: /^Review: access opened/ }).click();
  await page.getByLabel('Justified', { exact: true }).check();
  await page.getByLabel('Note').fill('Looks right to me, sure');
  await page.getByRole('button', { name: 'Record decision' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Use security key' }).click();
  await expect(page.getByText(/you cannot review it/)).toBeVisible();
  await axe(page);
});

test('users & roles: request a change, then the approval screen blocks your own request', async ({
  page,
}, info) => {
  await mock(page);
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Request a role change: Admin One' }).click();
  await expect(
    page.getByText(
      'A different administrator must approve this. You cannot approve your own request.',
    ),
  ).toBeVisible();
  await page
    .getByLabel(/compliance_officer/)
    .first()
    .check();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-6-role-change-form`), fullPage: true });
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Use security key' }).click();
  await expect(page.getByText(/Sent for approval/)).toBeVisible();
  await page.getByLabel('Request reference').fill(id(60));
  await expect(
    page.getByText('You asked for this. A different administrator must approve it.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await axe(page);
  await page.screenshot({
    path: shot(`${info.project.name}-7-approval-own-request`),
    fullPage: true,
  });
  await page.getByLabel('Request reference').fill(id(61));
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(
    page.getByText(/cannot approve your own request. Ask a different administrator/),
  ).toBeVisible();
});

test('privacy requests: queue and decision panel', async ({ page }, info) => {
  await mock(page);
  await page.goto('/admin/privacy');
  await page.getByRole('button', { name: /^Review: Export request/ }).click();
  await expect(page.getByText('Check the requester’s identity before you approve.')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${info.project.name}-8-privacy-request`), fullPage: true });
});
