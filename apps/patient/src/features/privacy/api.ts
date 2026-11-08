import type { PatientRuntime } from '../../app/runtime.js';
import { asRecord, guard } from '../profile/lib/core.js';
import type { Outcome } from '../profile/lib/core.js';
import { parseDownload, parseRequest } from './types.js';
import type { DownloadUrl, PrivacyRequest } from './types.js';

export type PrivacyApi = ReturnType<typeof createPrivacyApi>;

/** The calls of PP-24 over the shell's typed client. Requests are the patient's own; a proxy has none (D-7). */
export function createPrivacyApi(runtime: PatientRuntime) {
  const { api } = runtime;
  const header = api.header;
  return {
    list: (): Promise<Outcome<PrivacyRequest[]>> =>
      guard(
        () => api.GET('/api/v1/privacy-requests', { params: { header, query: {} } }),
        (d) => {
          const items = asRecord(d)['items'];
          if (!Array.isArray(items)) return undefined;
          const out = items.map(parseRequest);
          return out.every((x) => x !== undefined) ? (out as PrivacyRequest[]) : undefined;
        },
      ),

    /** A deletion request is recorded and routed to compliance; nothing is deleted (D-8). */
    create: (
      kind: 'export' | 'deletion',
      key: string,
      detail?: string,
    ): Promise<Outcome<PrivacyRequest>> =>
      guard(
        () =>
          api.POST('/api/v1/privacy-requests', {
            params: { header: { ...header, 'Idempotency-Key': key } },
            body: detail === undefined || detail === '' ? { kind } : { kind, detail },
          }),
        (d) => parseRequest(d),
      ),

    /** A 60-second URL; the server audits the download. */
    downloadUrl: (id: string): Promise<Outcome<DownloadUrl>> =>
      guard(
        () =>
          api.POST('/api/v1/privacy-requests/{id}/export/download-url', {
            params: { header, path: { id } },
          }),
        (d) => parseDownload(d),
      ),
  };
}
