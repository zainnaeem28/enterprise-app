import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// CONTRACT MOCK of messaging.yaml, with response shapes copied from the BE-19 service. No real API or database runs in this check;
// the real journey is for integration.
const LOC = '11111111-1111-4111-8111-111111111111';
const ME = '88888888-8888-4888-8888-888888888888';
const OTHER = '99999999-9999-4999-8999-999999999999';
const T1 = '33333333-3333-4333-8333-333333333333';
const shot = (name: string) =>
  fileURLToPath(new URL(`../evidence/screenshots/${name}.png`, import.meta.url));

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
}

const task = (over: Record<string, unknown> = {}) => ({
  id: '55555555-5555-4555-8555-555555555555',
  patientId: null,
  title: 'Call the lab',
  detail: 'Confirm the courier time.',
  assignee: { kind: 'principal', principalId: ME },
  status: 'open',
  dueAt: '2031-06-02T09:00:00.000Z',
  source: 'manual',
  completedAt: null,
  createdAt: '2031-06-01T09:00:00.000Z',
  version: 4,
  ...over,
});

async function mockApi(page: Page) {
  let tasks = [
    task(),
    task({
      id: '66666666-6666-4666-8666-666666666666',
      title: 'Restock the front desk',
      detail: null,
      dueAt: null,
      assignee: { kind: 'role_location', roleKey: 'front_desk', locationId: LOC },
    }),
  ];
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
        permissions: ['messaging.thread.staff', 'messaging.task.manage'],
        patients: [],
      });
    if (path === '/api/v1/tasks' && req.method() === 'GET')
      return ok(200, {
        items: url.searchParams.get('status') === 'open' ? tasks : [],
        nextCursor: null,
      });
    if (path === '/api/v1/tasks' && req.method() === 'POST') {
      tasks = [
        task({ id: '77777777-7777-4777-8777-777777777777', title: 'New follow-up' }),
        ...tasks,
      ];
      return ok(201, tasks[0]);
    }
    if (path.startsWith('/api/v1/tasks/') && req.method() === 'PATCH') {
      expect(req.headers()['if-match']).toBe('W/"4"');
      tasks = tasks.filter((t) => !path.endsWith(t.id));
      return ok(200, task({ status: 'done', version: 5 }));
    }
    if (path === '/api/v1/threads' && req.method() === 'GET')
      return ok(200, {
        items: [
          {
            id: T1,
            kind: 'staff',
            patientId: null,
            subject: 'Rota change',
            status: 'open',
            locationId: LOC,
            createdAt: '2031-06-01T09:00:00.000Z',
            version: 1,
            me: { role: 'owner', lastReadAt: null },
            unread: 2,
          },
        ],
        nextCursor: null,
      });
    if (path === `/api/v1/threads/${T1}/messages` && req.method() === 'GET')
      return ok(200, {
        items: [
          {
            id: 'm2',
            threadId: T1,
            authorPrincipalId: ME,
            body: 'Thanks, that works.',
            attachmentDocumentIds: [],
            sentAt: '2031-06-01T10:00:00.000Z',
          },
          {
            id: 'm1',
            threadId: T1,
            authorPrincipalId: OTHER,
            body: 'Can you swap Friday?',
            attachmentDocumentIds: [],
            sentAt: '2031-06-01T09:30:00.000Z',
          },
        ],
        nextCursor: null,
      });
    return ok(404, { code: 'kernel.not_found' });
  });
}

test('tasks: list, create, complete', async ({ page }, info) => {
  const p = info.project.name;
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tasks & messages', level: 1 })).toBeVisible();
  await expect(page.getByText('Call the lab')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${p}-1-tasks`), fullPage: true });

  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByText('Enter a title.').first()).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${p}-2-new-task-error`), fullPage: true });
  await page.getByLabel('Title').fill('New follow-up');
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByText('Task created.')).toBeVisible();
  await expect(page.getByText('New follow-up')).toBeVisible();

  await page.getByRole('button', { name: 'Mark done: Call the lab' }).click();
  await expect(page.getByText('Task marked done.')).toBeVisible();
  await expect(page.getByText('Call the lab')).toHaveCount(0);
  await axe(page);
  await page.screenshot({ path: shot(`${p}-3-task-done`), fullPage: true });
});

test('messages: thread list, thread, new message', async ({ page }, info) => {
  const p = info.project.name;
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Secure messages' }).click();
  await expect(page.getByRole('button', { name: /Rota change/ })).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${p}-4-threads`), fullPage: true });

  await page.getByRole('button', { name: /Rota change/ }).click();
  await expect(page.getByText('Can you swap Friday?')).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${p}-5-thread-open`), fullPage: true });
  // Wide: the list stays beside the thread. Narrow: the list gives way and Back returns to it.
  const listVisible = await page.getByRole('list', { name: 'Message threads' }).isVisible();
  expect(listVisible).toBe(info.project.name === 'desktop');
  if (info.project.name === 'phone') {
    await page.getByRole('button', { name: 'Back to threads' }).click();
    await expect(page.getByRole('list', { name: 'Message threads' })).toBeVisible();
  }

  await page.getByRole('button', { name: 'New message' }).click();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Enter a subject.').first()).toBeVisible();
  await axe(page);
  await page.screenshot({ path: shot(`${p}-6-new-message-error`), fullPage: true });
});

test('no horizontal scroll at 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByText('Call the lab')).toBeVisible();
  const wide = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(wide).toBe(false);
});
