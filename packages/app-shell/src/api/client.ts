import createClient from 'openapi-fetch';
import type { paths } from '@ehr/contracts';
import {
  CLIENT_RELEASE_HEADER,
  RELEASE_REFUSED_CODE,
  assertClientRelease,
} from '../release/client-release.js';

export interface ReleaseRefusal {
  requestId?: string;
}

export interface ApiClientOptions {
  /** `r<n>.<sha12>` of this bundle. */
  clientRelease: string;
  /** Called when any call is refused with 400 `kernel.client_release_unsupported`. */
  onReleaseRefused?: (refusal: ReleaseRefusal) => void;
  /** Empty (same origin, relative URLs) in the browser. Tests running outside a browser need an absolute base. */
  baseUrl?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: (request: Request) => Promise<Response>;
}

/**
 * Typed client over the generated `paths` (F-08). Same origin only: relative URLs, no CORS, no
 * cross-origin credentials. Adds `X-Client-Release` to every call.
 */
export function createApiClient(options: ApiClientOptions) {
  const release = assertClientRelease(options.clientRelease);
  const base = options.fetch ?? ((request: Request) => globalThis.fetch(request));
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? '',
    credentials: 'same-origin',
    fetch: async (request: Request) => {
      request.headers.set(CLIENT_RELEASE_HEADER, release);
      const response = await base(request);
      if (response.status === 400) await inspectRefusal(response, options.onReleaseRefused);
      return response;
    },
  });
  // The generated operations declare `X-Client-Release` as a required header parameter; `header` is
  // that value for call sites, and the fetch layer above sets it again so no call can omit it.
  return Object.assign(client, {
    clientRelease: release,
    header: { 'X-Client-Release': release } as const,
  });
}

async function inspectRefusal(response: Response, notify?: (r: ReleaseRefusal) => void) {
  if (notify === undefined) return;
  try {
    const body = (await response.clone().json()) as { code?: unknown; requestId?: unknown };
    if (body.code === RELEASE_REFUSED_CODE) {
      notify(typeof body.requestId === 'string' ? { requestId: body.requestId } : {});
    }
  } catch {
    // Not a JSON problem body: not a release refusal.
  }
}

/** The SSE stream cannot send headers, so the release goes in `clientRelease` (28.6). */
export function alertStreamUrl(clientRelease: string): string {
  return `/api/v1/alerts/stream?clientRelease=${encodeURIComponent(assertClientRelease(clientRelease))}`;
}
