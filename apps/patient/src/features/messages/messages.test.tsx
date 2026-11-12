import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { json } from '../../app/test-helpers.js';
import { ME, mount, OTHER, PRINCIPAL, sent, THREAD } from '../profile/testkit.js';
import { matchMessagesRoute } from './MessagesRoutes.js';

afterEach(cleanup);
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const LIST = `GET /api/v1/patients/${ME}/threads`;

const thread = (over = {}) => ({
  id: THREAD,
  kind: 'patient',
  patientId: ME,
  subject: 'Question about my visit',
  status: 'open',
  createdAt: '2031-06-10T12:00:00.000Z',
  version: 1,
  me: { role: 'owner', lastReadAt: null },
  unread: 1,
  messages: [
    {
      id: 'm1',
      threadId: THREAD,
      authorPrincipalId: PRINCIPAL,
      body: 'Hello there',
      attachmentDocumentIds: [],
      sentAt: '2031-06-10T12:00:00.000Z',
    },
    {
      id: 'm2',
      threadId: THREAD,
      authorPrincipalId: OTHER,
      body: 'We got your note',
      attachmentDocumentIds: [],
      sentAt: '2031-06-10T13:00:00.000Z',
    },
  ],
  ...over,
});

const NOTE =
  'Secure messaging with your care team is not part of this release. For questions, call the practice. If it is urgent, call emergency services.';

describe('PP-37 messages (flag patient_messaging)', () => {
  it('matches only its own paths', () => {
    expect(matchMessagesRoute('/messages')).toEqual({ name: 'list' });
    expect(matchMessagesRoute('/messages/new')).toEqual({ name: 'new' });
    expect(matchMessagesRoute('/messages/' + THREAD)).toEqual({ name: 'thread', id: THREAD });
    expect(matchMessagesRoute('/messages/x')).toBeUndefined();
  });

  it('with the flag off (404) reads as a page that does not exist and reveals nothing about the flag', async () => {
    mount('messages', '/messages', {
      [LIST]: () => json(404, { status: 404, code: 'kernel.not_found', requestId: 'r' }),
    });
    expect(
      await screen.findByText(/We can.t find this, or it isn.t available to you/),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/flag|patient_messaging|disabled/i);
  });

  it('lists threads with unread counts and opens one, telling "You" from the care team', async () => {
    mount('messages', '/messages', {
      [LIST]: () => json(200, { items: [thread()], nextCursor: null }),
    });
    expect(await screen.findByText('1 new')).toBeInTheDocument();
    expect(screen.getByText(/not for emergencies/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Question about my visit' }));
    expect(
      await screen.findByRole('heading', { name: 'Question about my visit' }),
    ).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Care team')).toBeInTheDocument();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(screen.queryByText(/not available yet/)).not.toBeInTheDocument();
    expect(document.title).toBe('Patient portal - Messages');
  });

  it('shows the empty state', async () => {
    mount('messages', '/messages');
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write a message' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/No messages yet/);
  });

  it('offers "Write a message" on the inbox only when recipients are known', async () => {
    mount('messages', '/messages', {}, { recipients: [OTHER] });
    expect(await screen.findByText('You have no messages.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Write a message' })).toBeInTheDocument();
  });

  it('does not offer to write a message when no recipients are known', async () => {
    mount('messages', '/messages/new');
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
  });

  it('sends a new message with the recipients and an idempotency key, then opens the thread', async () => {
    const m = mount(
      'messages',
      '/messages/new',
      {
        [`POST /api/v1/patients/${ME}/threads`]: () => json(201, thread()),
        [LIST]: () => json(200, { items: [thread()], nextCursor: null }),
      },
      { recipients: [OTHER] },
    );
    fireEvent.change(await screen.findByLabelText('Subject'), {
      target: { value: 'Question about my visit' },
    });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello there' } });
    click('Send message');
    expect(await screen.findByText('We got your note')).toBeInTheDocument();
    const post = sent(m.seen, 'POST', `/api/v1/patients/${ME}/threads`)[0];
    expect(post?.body).toEqual({
      subject: 'Question about my visit',
      body: 'Hello there',
      recipientPrincipalIds: [OTHER],
    });
    expect(post?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('requires a subject and a message before sending', async () => {
    const m = mount('messages', '/messages/new', {}, { recipients: [OTHER] });
    await screen.findByLabelText('Subject');
    click('Send message');
    expect(await screen.findByRole('alert')).toHaveTextContent('Subject: enter a short subject.');
    expect(sent(m.seen, 'POST', `/api/v1/patients/${ME}/threads`)).toHaveLength(0);
  });

  it('a proxy-only account sees a permission note and no thread call', async () => {
    const m = mount(
      'messages',
      '/messages',
      {},
      { patients: [{ patientId: OTHER, relation: 'proxy', scope: 'appointments' }] },
    );
    expect(await screen.findByText(/Messages belong to the patient/)).toBeInTheDocument();
    expect(m.seen.some((s) => s.path.endsWith('/threads'))).toBe(false);
  });
});
