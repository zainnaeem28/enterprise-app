import type { createApiClient } from '../api/client.js';
import { parseDocument } from './types.js';
import type { Classification, DocumentRecord } from './types.js';

type Api = ReturnType<typeof createApiClient>;

/** A refused or failed call reduced to what the screens use. `status` 0 is a network failure. */
export interface Failure {
  ok: false;
  status: number;
  code: string;
  requestId?: string;
}
export type Outcome<T> = { ok: true; data: T } | Failure;

export interface UploadTicket {
  documentId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

function failureOf(response: Response | undefined, body: unknown): Failure {
  const b = rec(body);
  return {
    ok: false,
    status: response?.status ?? 0,
    code: typeof b['code'] === 'string' ? b['code'] : 'kernel.unavailable',
    ...(typeof b['requestId'] === 'string' ? { requestId: b['requestId'] } : {}),
  };
}

const NETWORK: Failure = { ok: false, status: 0, code: 'kernel.unavailable' };
const UNREADABLE = (r: Response): Failure => ({
  ok: false,
  status: r.status,
  code: 'kernel.unavailable',
});

export const newKey = (): string => crypto.randomUUID();
/**
 * The contract requires If-Match but no response lists a version (FE06-F01), so an unknown version sends no
 * header (the server answers 428, shown to the user) rather than a made-up value that would answer 412.
 */
const matchHeader = (version: number | undefined): { 'If-Match': string } =>
  (version === undefined ? {} : { 'If-Match': `W/"${version}"` }) as { 'If-Match': string };

/** Every call the documents screens make, over the shell's typed client (CSRF and release headers added by the shell). */
export function createDocumentsApi(api: Api) {
  const header = api.header;

  async function guard<T>(
    run: () => Promise<{ data?: unknown; error?: unknown; response: Response }>,
    read: (data: unknown, response: Response) => T | undefined,
  ): Promise<Outcome<T>> {
    try {
      const { data, error, response } = await run();
      if (!response.ok) return failureOf(response, error);
      const value = read(data, response);
      return value === undefined ? UNREADABLE(response) : { ok: true, data: value };
    } catch {
      return NETWORK;
    }
  }

  const versionOf = (response: Response): number | undefined => {
    const m = /(\d+)"?$/.exec(response.headers.get('ETag') ?? '');
    return m === null ? undefined : Number(m[1]);
  };

  return {
    list: (patientId: string): Promise<Outcome<DocumentRecord[]>> =>
      guard(
        () =>
          api.GET('/api/v1/patients/{patientId}/documents', {
            params: { header, path: { patientId }, query: {} },
          }),
        (d) => {
          const items = rec(d)['items'];
          if (!Array.isArray(items)) return undefined;
          const docs = items.map((i) => parseDocument(i));
          return docs.every((x) => x !== undefined)
            ? (docs as DocumentRecord[]).filter((x) => x.status !== 'deleted')
            : undefined;
        },
      ),

    createUpload: (
      patientId: string,
      key: string,
      input: {
        contentType: string;
        sizeBytes: number;
        fileName?: string;
        classification?: Classification;
      },
    ): Promise<Outcome<UploadTicket>> =>
      guard(
        () =>
          api.POST('/api/v1/patients/{patientId}/document-uploads', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { patientId } },
            body: input,
          }),
        (d) => {
          const t = rec(d);
          if (typeof t['documentId'] !== 'string' || typeof t['uploadUrl'] !== 'string')
            return undefined;
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(rec(t['uploadHeaders'])))
            if (typeof v === 'string') headers[k] = v;
          return { documentId: t['documentId'], uploadUrl: t['uploadUrl'], uploadHeaders: headers };
        },
      ),

    completeUpload: (documentId: string, key: string): Promise<Outcome<true>> =>
      guard(
        () =>
          api.POST('/api/v1/document-uploads/{documentId}/complete', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { documentId } },
          }),
        () => true as const,
      ),

    /** A 60-second link for a clean file; the server answers 409 `documents.not_available` otherwise. */
    downloadUrl: (documentId: string): Promise<Outcome<{ url: string; expiresAt: string }>> =>
      guard(
        () =>
          api.POST('/api/v1/documents/{documentId}/download-url', {
            params: { header, path: { documentId } },
          }),
        (d) => {
          const r = rec(d);
          return typeof r['url'] === 'string' && typeof r['expiresAt'] === 'string'
            ? { url: r['url'], expiresAt: r['expiresAt'] }
            : undefined;
        },
      ),

    classify: (
      id: string,
      version: number | undefined,
      classification: Classification,
    ): Promise<Outcome<DocumentRecord>> =>
      guard(
        () =>
          api.PUT('/api/v1/documents/{id}/classification', {
            params: { header: { ...header, ...matchHeader(version) }, path: { id } },
            body: { classification },
          }),
        (d, r) => parseDocument(d, versionOf(r)),
      ),

    confirm: (id: string, version: number | undefined): Promise<Outcome<DocumentRecord>> =>
      guard(
        () =>
          api.POST('/api/v1/documents/{id}/confirm', {
            params: { header: { ...header, ...matchHeader(version) }, path: { id } },
          }),
        (d, r) => parseDocument(d, versionOf(r)),
      ),
  };
}
export type DocumentsApi = ReturnType<typeof createDocumentsApi>;
