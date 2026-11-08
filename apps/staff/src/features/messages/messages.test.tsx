import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import {
  ALL,
  K1,
  ME,
  OTHER,
  T1,
  json,
  message,
  mount,
  task,
  thread,
  userEvent,
  violations,
} from './testkit.js';
import type { Handler } from './testkit.js';

afterEach(() => cleanup());

const emptyPage = { items: [], nextCursor: null };
const base =
  (extra: Handler = () => undefined): Handler =>
  (r) => {
    const e = extra(r);
    if (e !== undefined) return e;
    if (r.path === '/api/v1/tasks' && r.method === 'GET')
      return json(200, { items: [task()], nextCursor: null });
    if (r.path === '/api/v1/threads' && r.method === 'GET')
      return json(200, { items: [thread()], nextCursor: null });
    if (/^\/api\/v1\/threads\/[^/]+\/messages$/.test(r.path) && r.method === 'GET')
      return json(200, {
        items: [
          message('m2', ME, 'Thanks, done', '2031-06-01T10:00:00.000Z'),
          message('m1', OTHER, 'Can you swap Friday?', '2031-06-01T09:30:00.000Z'),
        ],
        nextCursor: null,
      });
    return undefined;
  };

describe('tasks', () => {
  it('lists open tasks and completes one with the version held as If-Match', async () => {
    let done = false;
    const { seen } = mount(
      ALL,
      base((r) => {
        if (r.method === 'PATCH' && r.path === `/api/v1/tasks/${K1}`) {
          done = true;
          return json(200, task({ status: 'done', version: 5 }), { ETag: 'W/"5"' });
        }
        if (r.path === '/api/v1/tasks' && r.method === 'GET' && done) return json(200, emptyPage);
        return undefined;
      }),
    );
    expect(await screen.findByText('Call the lab')).toBeInTheDocument();
    expect(screen.getByText('Assigned to you')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark done: Call the lab' }));
    await screen.findByText('Task marked done.');
    const patch = seen.find((s) => s.method === 'PATCH');
    expect(patch?.headers.get('If-Match')).toBe('W/"4"');
    expect(patch?.body).toEqual({ status: 'done' });
    await screen.findByText('You have no open tasks.');
  });

  it('creates a task for a role at a location, with one idempotency key', async () => {
    const { seen } = mount(
      ALL,
      base((r) =>
        r.method === 'POST' && r.path === '/api/v1/tasks'
          ? json(201, task({ id: 'k2', title: 'Restock' }))
          : undefined,
      ),
    );
    await screen.findByText('Call the lab');
    await userEvent.click(screen.getByRole('button', { name: 'New task' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByText('Enter a title.')).toBeInTheDocument();
    await userEvent.set(screen.getByLabelText('Title'), 'Restock');
    await userEvent.set(screen.getByLabelText('Assign to'), 'role');
    await userEvent.set(screen.getByLabelText(/^Role/), 'front_desk');
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await screen.findByText('Task created.');
    const post = seen.find((s) => s.method === 'POST');
    expect(post?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.body).toEqual({
      title: 'Restock',
      assignee: { roleKey: 'front_desk', locationId: '11111111-1111-4111-8111-111111111111' },
    });
  });

  it('explains a stale version and reloads', async () => {
    mount(
      ALL,
      base((r) =>
        r.method === 'PATCH' ? json(412, { code: 'kernel.precondition_failed' }) : undefined,
      ),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Mark done: Call the lab' }));
    expect(await screen.findByText(/Someone changed this/)).toBeInTheDocument();
  });

  it('shows a permission note without the permission and makes no task call', async () => {
    const { seen } = mount(['messaging.thread.staff'], base());
    expect(await screen.findByText(/cannot use this part/)).toBeInTheDocument();
    expect(seen.some((s) => s.path === '/api/v1/tasks')).toBe(false);
  });

  it('has an empty state and an error state with retry', async () => {
    let fail = true;
    mount(ALL, (r) =>
      r.path === '/api/v1/tasks'
        ? fail
          ? json(503, { code: 'kernel.unavailable', requestId: 'req-1' })
          : json(200, emptyPage)
        : undefined,
    );
    const retry = await screen.findByRole('button', { name: /try again|retry/i });
    fail = false;
    await userEvent.click(retry);
    expect(await screen.findByText('You have no open tasks.')).toBeInTheDocument();
  });
});

describe('secure messages (list-detail)', () => {
  const open = async () => {
    await userEvent.click(await screen.findByRole('tab', { name: 'Secure messages' }));
  };

  it('lists threads with unread count and opens one oldest first, without author identifiers', async () => {
    mount(ALL, base());
    await open();
    const row = await screen.findByRole('button', { name: /Rota change/ });
    expect(within(row).getByText('2 unread')).toBeInTheDocument();
    await userEvent.click(row);
    const log = await screen.findByRole('list', { name: 'Messages in Rota change' });
    const items = within(log).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('A colleague');
    expect(items[0]).toHaveTextContent('Can you swap Friday?');
    expect(items[1]).toHaveTextContent('You');
    expect(log.textContent).not.toContain(OTHER);
    expect(screen.getByRole('heading', { name: 'Rota change', level: 3 })).toHaveFocus();
  });

  it('sends a reply with an idempotency key and refreshes', async () => {
    const { seen } = mount(
      ALL,
      base((r) =>
        r.method === 'POST' && r.path === `/api/v1/threads/${T1}/messages`
          ? json(201, message('m3', ME, 'On it', '2031-06-01T11:00:00.000Z'))
          : undefined,
      ),
    );
    await open();
    await userEvent.click(await screen.findByRole('button', { name: /Rota change/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Write a message before sending.')).toBeInTheDocument();
    await userEvent.set(screen.getByLabelText('Your reply'), 'On it');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Message sent.');
    const post = seen.find((s) => s.method === 'POST');
    expect(post?.body).toEqual({ body: 'On it' });
    expect(post?.headers.get('Idempotency-Key')).toBeTruthy();
  });

  it('starts a new thread, validating recipients, and opens it', async () => {
    const { seen } = mount(
      ALL,
      base((r) =>
        r.method === 'POST' && r.path === '/api/v1/threads'
          ? json(201, thread({ id: 'new', subject: 'Lunch cover', unread: 0 }))
          : undefined,
      ),
    );
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'New message' }));
    await userEvent.set(screen.getByLabelText('Subject'), 'Lunch cover');
    await userEvent.set(screen.getByLabelText('Message'), 'Who is free?');
    await userEvent.set(screen.getByLabelText('Recipients'), 'not-an-id');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText(/Enter each recipient/)).toBeInTheDocument();
    await userEvent.set(screen.getByLabelText('Recipients'), OTHER);
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByRole('heading', { name: 'Lunch cover', level: 3 });
    const post = seen.find((s) => s.method === 'POST' && s.path === '/api/v1/threads');
    expect(post?.body).toEqual({
      subject: 'Lunch cover',
      body: 'Who is free?',
      participantIds: [OTHER],
    });
  });

  it('explains a refused recipient (outside the organisation) in words', async () => {
    mount(
      ALL,
      base((r) =>
        r.method === 'POST' && r.path === '/api/v1/threads'
          ? json(404, { code: 'kernel.not_found' })
          : undefined,
      ),
    );
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'New message' }));
    await userEvent.set(screen.getByLabelText('Subject'), 'Hi');
    await userEvent.set(screen.getByLabelText('Message'), 'Hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText(/colleagues in your organisation/)).toBeInTheDocument();
  });

  it('a closed thread can be read but not replied to', async () => {
    mount(
      ALL,
      base((r) =>
        r.path === '/api/v1/threads'
          ? json(200, { items: [thread({ status: 'closed' })], nextCursor: null })
          : undefined,
      ),
    );
    await open();
    await userEvent.click(await screen.findByRole('button', { name: /Rota change/ }));
    expect(await screen.findByText(/This thread is closed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('shows the empty state', async () => {
    mount(ALL, (r) => (r.path === '/api/v1/threads' ? json(200, emptyPage) : base()(r)));
    await open();
    expect(await screen.findByText('You have no message threads yet.')).toBeInTheDocument();
  });
});

describe('axe (jsdom; contrast and target size run in the Playwright spec)', () => {
  it('tasks, new task, threads and an open thread have no violations', async () => {
    const { view } = mount(ALL, base());
    await screen.findByText('Call the lab');
    expect(await violations(view.container)).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'New task' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await screen.findByText('Enter a title.');
    expect(await violations(view.container)).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Secure messages' }));
    await userEvent.click(await screen.findByRole('button', { name: /Rota change/ }));
    await screen.findByRole('list', { name: 'Messages in Rota change' });
    await waitFor(async () => expect(await violations(view.container)).toEqual([]));
  });
});
