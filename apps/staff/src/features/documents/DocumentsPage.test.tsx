// CONTRACT MOCK of documents.yaml (no real API). Permission visibility only; flows are tested in @ehr/app-shell.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ReleaseStore, createApiClient } from '@ehr/app-shell';
import type { Runtime } from '../../runtime.js';
import { DocumentsPage } from './DocumentsPage.js';

afterEach(cleanup);

const PATIENT = '22222222-2222-4222-8222-222222222222';
const doc = {
  id: '99999999-9999-4999-8999-999999999991',
  patientId: PATIENT,
  classification: 'insurance_card',
  suggestedClassification: 'id_document',
  status: 'clean',
  uploadChannel: 'staff',
  uploadedAt: '2031-06-10T14:00:00.000Z',
  confirmedAt: null,
  contentType: 'application/pdf',
  sizeBytes: 1024,
  onLegalHold: false,
};

function mount(permissions: string[]) {
  const calls: string[] = [];
  const clientRelease = 'r1.000000000000';
  const runtime: Runtime = {
    clientRelease,
    releases: new ReleaseStore({ clientRelease }),
    api: createApiClient({
      clientRelease,
      baseUrl: 'http://portal.test',
      fetch: async (request) => {
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response(JSON.stringify({ items: [doc], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    }),
  };
  render(<DocumentsPage runtime={runtime} patientId={PATIENT} permissions={permissions} />);
  return { calls };
}

describe('DocumentsPage', () => {
  it('shows upload, list and the confirm control to a classifier', async () => {
    mount(['documents.read', 'documents.upload', 'documents.classify']);
    expect(await screen.findByRole('button', { name: /^confirm classification/i })).toBeVisible();
    expect(screen.getByLabelText(/choose a file/i)).toBeVisible();
  });

  it('shows a read-only list to a reader: no upload, no confirm', async () => {
    mount(['documents.read']);
    await screen.findByRole('list', { name: 'Documents' });
    expect(screen.queryByLabelText(/choose a file/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /confirm classification/i })).toBeNull();
    expect(screen.getByText(/permission to upload/i)).toBeVisible();
  });

  it('makes no call without documents.read', () => {
    const m = mount([]);
    expect(screen.getByText(/permission to view documents/i)).toBeVisible();
    expect(m.calls).toEqual([]);
  });
});
