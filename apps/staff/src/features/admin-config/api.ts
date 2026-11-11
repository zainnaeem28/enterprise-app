import type { Api } from '../preconsult/http.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
export interface Answer {
  data?: unknown;
  error?: unknown;
  response: Response;
  /** True when no answer came back at all (offline, timeout). */
  offline?: true;
}
type LooseCall = (
  path: string,
  init: {
    params: {
      header: Record<string, string>;
      path?: Record<string, string>;
      query?: Record<string, string>;
    };
    body?: unknown;
  },
) => Promise<{ data?: unknown; error?: unknown; response: Response }>;

const ROOT = '/api/v1/admin/';
const OFFLINE: Answer = {
  response: new Response(null, { status: 503 }),
  error: { code: 'kernel.unavailable' },
  offline: true,
};

/**
 * Every call the admin configuration screens make: the BE-23 organisation routes (`organisation.yaml`), the integration routes of
 * `integration-core.yaml` and the vital-range routes of `clinical.yaml`. The generated response types of these operations are
 * opaque or absent, so they go through the same untyped seam the other staff features use. Every one of these routes needs a live
 * elevation grant, so the caller runs each inside `callPrivileged`. Nothing here keeps a value in storage, and a secret value
 * goes out in one request body and nowhere else.
 */
export function createConfigApi(api: Api) {
  const header = api.header;
  const loose = api as unknown as Record<Method, LooseCall>;
  const call = async (
    method: Method,
    path: string,
    init: {
      query?: Record<string, string>;
      pathParams?: Record<string, string>;
      body?: unknown;
      version?: number;
    } = {},
  ): Promise<Answer> => {
    try {
      return await loose[method](`${ROOT}${path}`, {
        params: {
          header:
            init.version === undefined ? header : { ...header, 'If-Match': `W/"${init.version}"` },
          ...(init.pathParams === undefined ? {} : { path: init.pathParams }),
          ...(init.query === undefined ? {} : { query: init.query }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      });
    } catch {
      return OFFLINE;
    }
  };
  return {
    list: (path: string, query: Record<string, string> = {}, cursor?: string) =>
      call('GET', path, { query: { limit: '100', ...query, ...(cursor ? { cursor } : {}) } }),
    /** POST (create), PATCH (change with `If-Match`) or PUT (upsert) on a collection path. */
    send: (method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown, version?: number) =>
      call(method, path, { body, ...(version === undefined ? {} : { version }) }),
    publish: (kind: 'consent' | 'questionnaire', id: string, body: Record<string, unknown>) =>
      call('POST', `${kind}-templates/{id}/publish`, { pathParams: { id }, body }),
    /** Ruling C item 4: the clinician's recorded licensed states (`licensedStates` only; nothing is assumed when none are recorded). */
    licensedStates: (principalId: string) =>
      call('GET', 'staff-profiles/{principalId}', { pathParams: { principalId } }),
    /** Makes the clinician's licensed states exactly this set. Booking and join checks read it on the next call. */
    setLicensedStates: (principalId: string, licensedStates: string[]) =>
      call('PUT', 'staff-profiles/{principalId}', {
        pathParams: { principalId },
        body: { licensedStates },
      }),
    testIntegration: (id: string) => call('POST', 'integrations/{id}/test', { pathParams: { id } }),
    putSecret: (id: string, name: string, value: string) =>
      call('PUT', 'integrations/{id}/secrets/{name}', {
        pathParams: { id, name },
        body: { value },
      }),
    retireRange: (id: string) =>
      call('POST', 'vital-ranges/{id}/retire', { pathParams: { id }, body: {} }),
  };
}
export type ConfigApi = ReturnType<typeof createConfigApi>;
