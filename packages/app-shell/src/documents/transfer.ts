import type { DocumentsApi, Failure, Outcome } from './api.js';
import { newKey } from './api.js';
import { ALLOWED_CONTENT_TYPES } from './types.js';
import type { Classification } from './types.js';

/** PUT of the file bytes to the pre-signed URL. Injected so tests and other hosts need no XHR. */
export type PutObject = (
  url: string,
  headers: Record<string, string>,
  file: Blob,
  onProgress: (fraction: number) => void,
) => Promise<{ ok: boolean; status: number }>;

/** Browser default: XHR, because `fetch` cannot report upload progress. No cookies are sent to the object store. */
export const xhrPutObject: PutObject = (url, headers, file, onProgress) =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = false;
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status });
    xhr.onerror = () => resolve({ ok: false, status: 0 });
    xhr.onabort = () => resolve({ ok: false, status: 0 });
    xhr.send(file);
  });

export type TransferStep = 'create' | 'put' | 'complete';

/** Progress of one file through create → put → complete. Resumable from the step that failed, with the same keys. */
export interface Transfer {
  id: string;
  name: string;
  file: File;
  classification?: Classification;
  fraction: number;
  step: TransferStep;
  state: 'running' | 'done' | 'failed';
  failure?: Failure | { ok: false; status: number; code: 'documents.type_not_allowed' };
  createKey: string;
  completeKey: string;
  ticket?: { documentId: string; uploadUrl: string; uploadHeaders: Record<string, string> };
}

export function newTransfer(file: File, classification?: Classification): Transfer {
  return {
    id: newKey(),
    name: file.name,
    file,
    ...(classification !== undefined ? { classification } : {}),
    fraction: 0,
    step: 'create',
    state: 'running',
    createKey: newKey(),
    completeKey: newKey(),
  };
}

const fail = (t: Transfer, f: Transfer['failure']): Transfer => ({
  ...t,
  state: 'failed',
  failure: f,
});

/**
 * Runs the remaining steps of a transfer and returns its final state. `onChange` receives every intermediate state.
 * The file name is sent for validation only (the server discards it); the content type is the browser's.
 */
export async function runTransfer(
  api: DocumentsApi,
  put: PutObject,
  patientId: string,
  start: Transfer,
  onChange: (t: Transfer) => void,
): Promise<Transfer> {
  let t: Transfer = { ...start, state: 'running' };
  delete t.failure;
  const emit = (next: Transfer) => {
    t = next;
    onChange(t);
  };
  emit(t);

  if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(t.file.type)) {
    emit(fail(t, { ok: false, status: 422, code: 'documents.type_not_allowed' }));
    return t;
  }

  if (t.step === 'create') {
    const made: Outcome<NonNullable<Transfer['ticket']>> = await api.createUpload(
      patientId,
      t.createKey,
      {
        contentType: t.file.type,
        sizeBytes: t.file.size,
        fileName: t.file.name,
        ...(t.classification !== undefined ? { classification: t.classification } : {}),
      },
    );
    if (!made.ok) {
      emit(fail(t, made));
      return t;
    }
    emit({ ...t, ticket: made.data, step: 'put', fraction: 0 });
  }

  if (t.step === 'put' && t.ticket !== undefined) {
    const sent = await put(t.ticket.uploadUrl, t.ticket.uploadHeaders, t.file, (fraction) =>
      emit({ ...t, fraction }),
    );
    if (!sent.ok) {
      emit(fail(t, { ok: false, status: sent.status, code: 'kernel.unavailable' }));
      return t;
    }
    emit({ ...t, step: 'complete', fraction: 1 });
  }

  if (t.step === 'complete' && t.ticket !== undefined) {
    const done = await api.completeUpload(t.ticket.documentId, t.completeKey);
    if (!done.ok) {
      emit(fail(t, done));
      return t;
    }
    emit({ ...t, state: 'done' });
  }
  return t;
}
