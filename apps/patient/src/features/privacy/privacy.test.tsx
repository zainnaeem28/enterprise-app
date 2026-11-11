import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from '../../app/test-helpers.js';
import { mount, OTHER, REQUEST, requestBody, sent } from '../profile/testkit.js';
import { violations } from '../../axe-helper.js';

afterEach(cleanup);
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const LIST = 'GET /api/v1/privacy-requests';

describe('PP-24 my privacy', () => {
  it('records an export request with its own idempotency key and lists it', async () => {
    let created = false;
    const m = mount('privacy', '/privacy', {
      [LIST]: () => json(200, { items: created ? [requestBody()] : [], nextCursor: null }),
      'POST /api/v1/privacy-requests': () => {
        created = true;
        return json(201, requestBody());
      },
    });
    expect(await screen.findByText('You have not made any privacy requests.')).toBeInTheDocument();
    expect(document.title).toBe('Patient portal - My privacy');
    click('Request a copy of my data');
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request my data' }));
    expect(await screen.findByText('Your request was recorded')).toBeInTheDocument();
    expect(await screen.findByText('Received')).toBeInTheDocument();
    const post = sent(m.seen, 'POST', '/api/v1/privacy-requests');
    expect(post).toHaveLength(1);
    expect(post[0]?.body).toEqual({ kind: 'export' });
    expect(post[0]?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records a deletion request without claiming anything is deleted yet', async () => {
    let created = false;
    const m = mount('privacy', '/privacy', {
      [LIST]: () =>
        json(200, {
          items: created ? [requestBody({ kind: 'deletion', status: 'blocked_d8' })] : [],
          nextCursor: null,
        }),
      'POST /api/v1/privacy-requests': () => {
        created = true;
        return json(201, requestBody({ kind: 'deletion', status: 'blocked_d8' }));
      },
    });
    await screen.findByText('You have not made any privacy requests.');
    expect(
      screen.getByText(
        /closes your account and deletes the data the law does not require us to keep/,
      ),
    ).toBeInTheDocument();
    click('Request account deletion');
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/your account is closed and cannot be used to sign in/),
    ).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Anything you want the privacy team to know/), {
      target: { value: 'please' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record my deletion request' }));
    expect(await screen.findByText('Your deletion request was recorded')).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing has been deleted yet\. The privacy team will check/),
    ).toBeInTheDocument();
    expect(await screen.findByText('Recorded, waiting for a decision')).toBeInTheDocument();
    expect(sent(m.seen, 'POST', '/api/v1/privacy-requests')[0]?.body).toEqual({
      kind: 'deletion',
      detail: 'please',
    });
  });

  it('shows the post-deletion statement: deleted, kept, why and until when, from the statement only', async () => {
    const statement = {
      version: 1,
      executedAt: '2031-07-01T10:00:00.000Z',
      accountDeactivated: true,
      deleted: [{ class: 'notification_preferences', count: 2 }],
      kept: [{ class: 'encounters', count: 5 }],
      keptReason: 'medical_record_retention',
      keptUntil: '2038-07-01',
      legalHold: { documents: 1 },
      keptByHold: [{ class: 'accepted_documents', count: 1 }],
      auditTrail: { kept: true, years: 6 },
      documentation: { kept: true, years: 6 },
    };
    mount('privacy', '/privacy', {
      [LIST]: () =>
        json(200, {
          items: [
            requestBody({
              kind: 'deletion',
              status: 'fulfilled',
              deletion: {
                executedAt: statement.executedAt,
                retainedUntil: '2038-07-01',
                heldDocuments: 1,
                purgeState: 'pending',
                purgeDeferredReason: 'legal_hold',
                statement,
              },
            }),
          ],
          nextCursor: null,
        }),
    });
    const box = await screen.findByRole('group', { name: 'Statement after account deletion' });
    expect(screen.getByText('Account closed')).toBeInTheDocument();
    expect(within(box).getByText('Notification preferences: 2')).toBeInTheDocument();
    expect(within(box).getByText('Visit records: 5')).toBeInTheDocument();
    expect(
      within(box).getByText(/kept until Jul 1, 2038 because the law requires medical records/),
    ).toBeInTheDocument();
    expect(within(box).getByText(/1 document is under a legal hold/)).toBeInTheDocument();
    expect(within(box).getByText(/on hold because a legal hold applies/)).toBeInTheDocument();
    expect(within(box).getAllByText(/kept for 6 years/)).toHaveLength(2);
    expect(await violations()).toEqual([]);
  });

  it('a double click sends one request', async () => {
    const m = mount('privacy', '/privacy', {
      'POST /api/v1/privacy-requests': async () => {
        await new Promise((r) => setTimeout(r, 30));
        return json(201, requestBody());
      },
    });
    await screen.findByText('You have not made any privacy requests.');
    click('Request a copy of my data');
    const go = within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: 'Request my data',
    });
    fireEvent.click(go);
    fireEvent.click(go);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(sent(m.seen, 'POST', '/api/v1/privacy-requests')).toHaveLength(1);
  });

  it('offers the download only when the copy is ready, and opens the short-lived URL', async () => {
    const open = vi.fn();
    const m = mount(
      'privacy',
      '/privacy',
      {
        [LIST]: () =>
          json(200, {
            items: [
              requestBody({
                status: 'fulfilled',
                package: { id: 'p1', status: 'ready', expiresAt: '2031-07-01T00:00:00.000Z' },
              }),
            ],
            nextCursor: null,
          }),
        [`POST /api/v1/privacy-requests/${REQUEST}/export/download-url`]: () =>
          json(200, {
            url: 'https://files.example.test/p/abc',
            expiresAt: '2031-06-10T12:01:00.000Z',
          }),
      },
      { open },
    );
    expect(await screen.findByText('Ready to download')).toBeInTheDocument();
    click('Download my data');
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://files.example.test/p/abc'));
    expect(
      sent(m.seen, 'POST', `/api/v1/privacy-requests/${REQUEST}/export/download-url`),
    ).toHaveLength(1);
  });

  it('says a copy is not ready when the server answers 409', async () => {
    mount('privacy', '/privacy', {
      [LIST]: () =>
        json(200, {
          items: [requestBody({ status: 'fulfilled', package: { id: 'p1', status: 'ready' } })],
          nextCursor: null,
        }),
      [`POST /api/v1/privacy-requests/${REQUEST}/export/download-url`]: () =>
        json(409, { status: 409, code: 'privacy.export_not_ready', requestId: 'r' }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Download my data' }));
    expect(await screen.findByText(/Your copy is not ready yet/)).toBeInTheDocument();
  });

  it('shows a refusal reason and never offers a download for it', async () => {
    mount('privacy', '/privacy', {
      [LIST]: () =>
        json(200, {
          items: [requestBody({ status: 'refused', decisionReason: 'We could not match you.' })],
          nextCursor: null,
        }),
    });
    expect(await screen.findByText('We could not match you.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download my data' })).not.toBeInTheDocument();
  });

  it('a proxy-only account cannot make privacy requests and no request is sent', async () => {
    const m = mount(
      'privacy',
      '/privacy',
      {},
      { patients: [{ patientId: OTHER, relation: 'proxy', scope: 'appointments' }] },
    );
    expect(
      await screen.findByText(/Privacy requests can only be made by the patient/),
    ).toBeInTheDocument();
    expect(m.seen.some((s) => s.path === '/api/v1/privacy-requests')).toBe(false);
  });

  it('shows the error state with the reference when the list fails', async () => {
    mount('privacy', '/privacy', {
      [LIST]: () => json(500, { status: 500, code: 'kernel.internal', requestId: 'req-p' }),
    });
    expect(await screen.findByText(/req-p/)).toBeInTheDocument();
  });
});
