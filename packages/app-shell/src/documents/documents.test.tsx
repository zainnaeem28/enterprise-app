// CONTRACT MOCK of documents.yaml: no real API, object store or scanner runs in these tests.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { createApiClient } from '../api/client.js';
import { DocumentsPanel, createDocumentsApi } from './index.js';
import type { DocumentPermissions, PutObject } from './index.js';

afterEach(cleanup);

const PATIENT = '22222222-2222-4222-8222-222222222222';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });

const doc = (over: Record<string, unknown> = {}) => ({
  id: '99999999-9999-4999-8999-999999999991',
  patientId: PATIENT,
  classification: 'patient_upload_other',
  suggestedClassification: null,
  status: 'clean',
  uploadChannel: 'patient',
  uploadedAt: '2031-06-10T14:00:00.000Z',
  confirmedAt: null,
  contentType: 'application/pdf',
  sizeBytes: 2048,
  onLegalHold: false,
  version: 2,
  ...over,
});

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}

function setup(
  respond: (seen: Seen) => Response | undefined,
  permissions: Partial<DocumentPermissions> = {},
  opts: { put?: PutObject; open?: (u: string) => boolean } = {},
) {
  const seen: Seen[] = [];
  const api = createApiClient({
    clientRelease: 'r5.bbbbbbbbbbbb',
    baseUrl: 'http://portal.test',
    getCsrfToken: () => 'csrf-test',
    fetch: async (request) => {
      const text = await request.clone().text();
      const s: Seen = {
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>),
      };
      seen.push(s);
      return respond(s) ?? json(500, { code: 'kernel.unavailable' });
    },
  });
  const view = render(
    <DocumentsPanel
      api={createDocumentsApi(api)}
      patientId={PATIENT}
      permissions={{ read: true, upload: true, classify: false, ...permissions }}
      pollMs={20}
      {...(opts.put !== undefined ? { putObject: opts.put } : {})}
      {...(opts.open !== undefined ? { openUrl: opts.open } : {})}
    />,
  );
  return { seen, ...view };
}

const list = (items: unknown[]) => json(200, { items, nextCursor: null });
const isList = (s: Seen) =>
  s.method === 'GET' && s.path === `/api/v1/patients/${PATIENT}/documents`;

describe('list and viewer', () => {
  it('opens a clean file through a short-lived URL and never offers Open before clean', async () => {
    const opened: string[] = [];
    const { seen } = setup(
      (s) => {
        if (isList(s))
          return list([
            doc(),
            doc({ id: 'a-scan', status: 'scanning', classification: 'insurance_card' }),
          ]);
        if (s.path.endsWith('/download-url'))
          return json(200, {
            url: 'https://objects.test/c/abc?sig=1',
            expiresAt: '2031-06-10T14:01:00Z',
          });
        return undefined;
      },
      {},
      { open: (u) => (opened.push(u), true) },
    );
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    const [clean, scanning] = items as [HTMLElement, HTMLElement];
    expect(within(scanning).getByText('Scanning')).toBeInTheDocument();
    expect(within(scanning).queryByRole('button', { name: /open/i })).toBeNull();
    expect(
      within(scanning).getByText(/cannot be opened until the scan finishes clean/i),
    ).toBeInTheDocument();
    fireEvent.click(within(clean).getByRole('button', { name: /open/i }));
    await waitFor(() => expect(opened).toEqual(['https://objects.test/c/abc?sig=1']));
    const call = seen.find((s) => s.path.endsWith('/download-url'));
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('X-CSRF-Token')).toBe('csrf-test');
  });

  it('shows the link when the browser blocks the pop-up, and the server refusal when not available', async () => {
    let refuse = false;
    setup(
      (s) => {
        if (isList(s)) return list([doc()]);
        if (s.path.endsWith('/download-url'))
          return refuse
            ? json(409, { code: 'documents.not_available', requestId: 'r1' })
            : json(200, { url: 'https://objects.test/c/x', expiresAt: '2031-06-10T14:01:00Z' });
        return undefined;
      },
      {},
      { open: () => false },
    );
    fireEvent.click(await screen.findByRole('button', { name: /open/i }));
    expect(await screen.findByRole('link', { name: /open file/i })).toHaveAttribute(
      'href',
      'https://objects.test/c/x',
    );
    refuse = true;
    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    expect(await screen.findByText(/not available yet/i)).toBeInTheDocument();
  });

  it('shows a quarantined file with its reason and no way to open it', async () => {
    setup((s) => (isList(s) ? list([doc({ status: 'quarantined' })]) : undefined));
    expect(await screen.findByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText(/did not pass the safety scan/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open/i })).toBeNull();
  });

  it('shows empty, load failure with retry, and permission states', async () => {
    let fail = true;
    setup((s) =>
      isList(s) ? (fail ? json(503, { code: 'kernel.unavailable' }) : list([])) : undefined,
    );
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /refresh list/i }));
    expect(await screen.findByText('No documents yet.')).toBeInTheDocument();
  });

  it('hides upload and list controls the caller lacks permission for', async () => {
    const { seen } = setup(() => undefined, { read: false, upload: false });
    expect(screen.queryByLabelText(/choose a file/i)).toBeNull();
    expect(screen.getAllByText(/permission/i).length).toBeGreaterThan(0);
    expect(seen).toHaveLength(0);
  });

  it('refreshes by itself while a file is scanning and shows it clean afterwards', async () => {
    let n = 0;
    setup((s) => {
      if (!isList(s)) return undefined;
      n += 1;
      return list([doc({ status: n < 3 ? 'scanning' : 'clean' })]);
    });
    expect(await screen.findByText('Scanning')).toBeInTheDocument();
    expect(await screen.findByText('Clean')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open/i })).toBeInTheDocument();
  });
});

describe('upload', () => {
  const file = (name = 'card.pdf', type = 'application/pdf') =>
    new File([new Uint8Array(2048)], name, { type });

  it('creates, transfers with progress, completes, then shows the scan state', async () => {
    let scanned = false;
    const progress: number[] = [];
    let release: () => void = () => undefined;
    const put: PutObject = (url, headers, _f, onProgress) =>
      new Promise((resolve) => {
        expect(url).toBe('https://objects.test/q/abc?sig=2');
        expect(headers).toEqual({ 'Content-Type': 'application/pdf' });
        onProgress(0.4);
        progress.push(0.4);
        release = () => resolve({ ok: true, status: 200 });
      });
    const { seen } = setup(
      (s) => {
        if (isList(s)) return list(scanned ? [doc({ status: 'scanning' })] : []);
        if (s.path.endsWith('/document-uploads'))
          return json(201, {
            documentId: '99999999-9999-4999-8999-999999999991',
            uploadUrl: 'https://objects.test/q/abc?sig=2',
            uploadHeaders: { 'Content-Type': 'application/pdf' },
            expiresAt: '2031-06-10T14:05:00Z',
          });
        if (s.path.endsWith('/complete')) {
          scanned = true;
          return json(202, { status: 'scanning' });
        }
        return undefined;
      },
      {},
      { put },
    );
    await screen.findByText('No documents yet.');
    fireEvent.change(screen.getByLabelText('Document type'), {
      target: { value: 'insurance_card' },
    });
    fireEvent.change(screen.getByLabelText(/choose a file/i), { target: { files: [file()] } });
    expect(await screen.findByText('Uploading 40%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: /card\.pdf: Uploading 40%/ })).toHaveAttribute(
      'value',
      '40',
    );
    release();
    expect(await screen.findByText('Scanning')).toBeInTheDocument();
    const create = seen.find((s) => s.path.endsWith('/document-uploads'));
    expect(create?.body).toMatchObject({
      contentType: 'application/pdf',
      sizeBytes: 2048,
      classification: 'insurance_card',
    });
    expect(create?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    const complete = seen.find((s) => s.path.endsWith('/complete'));
    expect(complete?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(complete?.headers.get('Idempotency-Key')).not.toBe(
      create?.headers.get('Idempotency-Key'),
    );
  });

  it('refuses a disallowed type without calling the API', async () => {
    const { seen } = setup((s) => (isList(s) ? list([]) : undefined));
    await screen.findByText('No documents yet.');
    fireEvent.change(screen.getByLabelText(/choose a file/i), {
      target: { files: [file('x.exe', 'application/x-msdownload')] },
    });
    expect(await screen.findByText(/only pdf, jpeg and png/i)).toBeInTheDocument();
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('retries from the failed step with the same idempotency key', async () => {
    let attempts = 0;
    const put: PutObject = async () => ({ ok: true, status: 200 });
    const { seen } = setup(
      (s) => {
        if (isList(s)) return list([]);
        if (s.path.endsWith('/document-uploads'))
          return json(201, {
            documentId: '99999999-9999-4999-8999-999999999991',
            uploadUrl: 'https://objects.test/q/abc',
            uploadHeaders: {},
            expiresAt: '2031-06-10T14:05:00Z',
          });
        if (s.path.endsWith('/complete')) {
          attempts += 1;
          return attempts === 1
            ? json(503, { code: 'kernel.unavailable', requestId: 'req-9' })
            : json(202, { status: 'scanning' });
        }
        return undefined;
      },
      {},
      { put },
    );
    await screen.findByText('No documents yet.');
    fireEvent.change(screen.getByLabelText(/choose a file/i), { target: { files: [file()] } });
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    await waitFor(() => expect(attempts).toBe(2));
    const completes = seen.filter((s) => s.path.endsWith('/complete'));
    expect(completes[0]?.headers.get('Idempotency-Key')).toBe(
      completes[1]?.headers.get('Idempotency-Key'),
    );
    expect(seen.filter((s) => s.path.endsWith('/document-uploads'))).toHaveLength(1);
  });

  it('shows the server refusal for a file that is too large', async () => {
    setup((s) => {
      if (isList(s)) return list([]);
      if (s.path.endsWith('/document-uploads')) return json(422, { code: 'documents.too_large' });
      return undefined;
    });
    await screen.findByText('No documents yet.');
    fireEvent.change(screen.getByLabelText(/choose a file/i), { target: { files: [file()] } });
    expect(await screen.findByText(/too large/i)).toBeInTheDocument();
  });
});

describe('classification confirm (staff)', () => {
  const suggested = doc({ suggestedClassification: 'insurance_card' });

  it('shows the suggestion as a suggestion, sends classify then confirm with If-Match, and updates the row', async () => {
    const { seen } = setup(
      (s) => {
        if (isList(s)) return list([suggested]);
        if (s.method === 'PUT')
          return json(200, doc({ classification: 'insurance_card', version: 3 }), {
            ETag: 'W/"3"',
          });
        if (s.path.endsWith('/confirm'))
          return json(
            200,
            doc({
              classification: 'insurance_card',
              status: 'confirmed',
              confirmedAt: '2031-06-10T15:00:00Z',
              version: 4,
            }),
            { ETag: 'W/"4"' },
          );
        return undefined;
      },
      { classify: true },
    );
    expect(await screen.findByText(/suggestion only/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Classification')).toHaveValue('insurance_card');
    fireEvent.click(screen.getByRole('button', { name: /^confirm classification/i }));
    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
    const put = seen.find((s) => s.method === 'PUT');
    expect(put?.headers.get('If-Match')).toBe('W/"2"');
    expect(put?.body).toEqual({ classification: 'insurance_card' });
    const confirm = seen.find((s) => s.path.endsWith('/confirm'));
    expect(confirm?.headers.get('If-Match')).toBe('W/"3"');
    expect(screen.queryByRole('button', { name: /^confirm classification/i })).toBeNull();
  });

  it('skips classify when staff accept the current class and refreshes on a stale version', async () => {
    let lists = 0;
    const { seen } = setup(
      (s) => {
        if (isList(s)) {
          lists += 1;
          return list([doc()]);
        }
        if (s.path.endsWith('/confirm')) return json(412, { code: 'kernel.precondition_failed' });
        return undefined;
      },
      { classify: true },
    );
    fireEvent.click(await screen.findByRole('button', { name: /^confirm classification/i }));
    expect(await screen.findByText(/someone else changed/i)).toBeInTheDocument();
    expect(seen.some((s) => s.method === 'PUT')).toBe(false);
    await waitFor(() => expect(lists).toBeGreaterThan(1));
  });

  it('offers no confirm control without the classify permission', async () => {
    setup((s) => (isList(s) ? list([suggested]) : undefined));
    await screen.findAllByRole('listitem');
    expect(screen.queryByRole('button', { name: /confirm classification/i })).toBeNull();
    expect(screen.queryByText(/suggested by text recognition/i)).toBeNull();
  });
});

describe('accessibility (axe, jsdom)', () => {
  it('has no violations with every state on screen', async () => {
    const { container } = setup(
      (s) =>
        isList(s)
          ? list([
              doc({ suggestedClassification: 'insurance_card' }),
              doc({ id: 'b', status: 'scanning' }),
              doc({ id: 'c', status: 'quarantined' }),
              doc({ id: 'd', status: 'confirmed', confirmedAt: '2031-06-10T15:00:00Z' }),
            ])
          : undefined,
      { classify: true },
    );
    await screen.findAllByRole('listitem');
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
