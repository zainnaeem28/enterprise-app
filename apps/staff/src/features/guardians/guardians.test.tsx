// CONTRACT MOCK of identity.yaml (proxy-grants, guardian-links, revoke) and documents.yaml (no real API or database).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReleaseStore, createApiClient } from '@ehr/app-shell';
import type { Runtime } from '../../runtime.js';
import { GuardianPanel } from './GuardianPanel.js';

afterEach(cleanup);

const PATIENT = '22222222-2222-4222-8222-222222222222';
const DOC = '99999999-9999-4999-8999-999999999991';
const GRANT = '88888888-8888-4888-8888-888888888888';
const doc = (over: Record<string, unknown> = {}) => ({
  id: DOC,
  patientId: PATIENT,
  classification: 'id_document',
  suggestedClassification: null,
  status: 'clean',
  uploadChannel: 'staff',
  uploadedAt: '2031-06-10T14:00:00.000Z',
  confirmedAt: null,
  contentType: 'application/pdf',
  sizeBytes: 1024,
  onLegalHold: false,
  ...over,
});
const grant = (over: Record<string, unknown> = {}) => ({
  id: GRANT,
  patientId: PATIENT,
  relationship: 'parent',
  scope: 'appointments',
  scopes: ['appointments', 'messages'],
  effectiveScopes: ['appointments'],
  guardian: true,
  patientDisplayName: 'Kim P',
  status: 'active',
  inviteeHint: 'g***@example.com',
  validUntil: '2040-01-01',
  ...over,
});

const VERIFY = 'identity.proxy.verify';
const REVOKE = 'identity.proxy.revoke';

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}
function mount(
  permissions: string[],
  answers: Record<string, () => Response> = {},
  docs: unknown[] = [doc()],
  grants: unknown[] = [grant()],
) {
  const seen: Seen[] = [];
  const clientRelease = 'r1.000000000000';
  const runtime: Runtime = {
    clientRelease,
    releases: new ReleaseStore({ clientRelease }),
    api: createApiClient({
      clientRelease,
      baseUrl: 'http://portal.test',
      fetch: async (request) => {
        const text = request.method === 'GET' ? '' : await request.clone().text();
        const path = new URL(request.url).pathname;
        seen.push({
          method: request.method,
          path,
          headers: request.headers,
          body: text === '' ? undefined : JSON.parse(text),
        });
        const hit = answers[`${request.method} ${path}`];
        if (hit !== undefined) return hit();
        const body = path.endsWith('/proxy-grants')
          ? { items: grants, nextCursor: null }
          : path.endsWith('/documents')
            ? { items: docs, nextCursor: null }
            : {};
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    }),
  };
  render(<GuardianPanel runtime={runtime} patientId={PATIENT} permissions={permissions} />);
  return { seen };
}
const res = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const POST = `/api/v1/patients/${PATIENT}/guardian-links`;

describe('staff guardian link and revoke (ruling C item 3)', () => {
  it('draws nothing and calls nothing without the verify permission', () => {
    const m = mount([]);
    expect(screen.queryByRole('heading', { name: /guardians/i })).toBeNull();
    expect(m.seen).toHaveLength(0);
  });

  it('lists proxies with granted and in-force scopes, as text', async () => {
    mount([VERIFY]);
    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Guardian link')).toBeInTheDocument();
    expect(
      screen.getByText(/Granted: Appointments, Messages\. In force today: Appointments\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('refuses to send without the e-mail, the document and the confirmation', async () => {
    const m = mount([VERIFY]);
    await screen.findByRole('button', { name: 'Send invitation' });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText(/enter it like name@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/choose the document you checked/)).toBeInTheDocument();
    expect(screen.getByText(/Confirm that you checked the document/)).toBeInTheDocument();
    expect(m.seen.filter((s) => s.method === 'POST')).toHaveLength(0);
  });

  it('lists only checked relationship documents, and says so when there are none', async () => {
    mount([VERIFY], {}, [
      doc({ id: 'a', status: 'scanning' }),
      doc({ id: 'b', classification: 'insurance_card' }),
    ]);
    expect(
      await screen.findByText(/no checked document that can show a relationship/),
    ).toBeInTheDocument();
    const select = screen.getByLabelText('Relationship document you checked') as HTMLSelectElement;
    expect(select.options).toHaveLength(1);
  });

  it('sends the link with an idempotency key and the chosen document, then reloads', async () => {
    const m = mount([VERIFY], { [`POST ${POST}`]: () => res(201, grant({ status: 'invited' })) });
    await screen.findByText('Active');
    fireEvent.change(screen.getByLabelText("Guardian's email address"), {
      target: { value: 'g@example.com' },
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Relationship document you checked') as HTMLSelectElement).options
          .length,
      ).toBe(2),
    );
    fireEvent.change(screen.getByLabelText('Relationship document you checked'), {
      target: { value: DOC },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Messages' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /I checked that this document/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText(/The guardian was invited/)).toBeInTheDocument();
    const post = m.seen.find((s) => s.method === 'POST' && s.path === POST);
    expect(post?.body).toEqual({
      email: 'g@example.com',
      relationship: 'parent',
      documentId: DOC,
      scopes: ['appointments', 'messages'],
    });
    expect(post?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      m.seen.filter((s) => s.method === 'GET' && s.path.endsWith('/proxy-grants')).length,
    ).toBe(2);
  });

  it('says why a refused link was refused, with no value from the form', async () => {
    mount([VERIFY], {
      [`POST ${POST}`]: () =>
        res(422, { status: 422, code: 'identity.proxy_not_allowed', requestId: 'req-7' }),
    });
    await screen.findByText('Active');
    fireEvent.change(screen.getByLabelText("Guardian's email address"), {
      target: { value: 'g@example.com' },
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Relationship document you checked') as HTMLSelectElement).options
          .length,
      ).toBe(2),
    );
    fireEvent.change(screen.getByLabelText('Relationship document you checked'), {
      target: { value: DOC },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /I checked that this document/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(
      await screen.findByText(/Guardian links are for patients under the age of majority/),
    ).toBeInTheDocument();
    expect(screen.getByText('req-7')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('g@example.com');
  });

  it('revokes only after the confirm dialog and says it ended at once', async () => {
    const m = mount([VERIFY, REVOKE], {
      [`POST /api/v1/patients/${PATIENT}/proxies/${GRANT}/revoke`]: () =>
        new Response(null, { status: 204 }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(m.seen.some((s) => s.path.endsWith('/revoke'))).toBe(false);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke now' }));
    expect(await screen.findByText(/Access was revoked/)).toBeInTheDocument();
    expect(m.seen.filter((s) => s.path.endsWith('/revoke'))).toHaveLength(1);
  });
});
