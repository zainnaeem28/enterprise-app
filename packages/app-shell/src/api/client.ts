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

export const SESSION_EXPIRES_HEADER = 'X-Session-Idle-Expires-At';
export const CSRF_HEADER = 'X-CSRF-Token';
export const SESSION_EXPIRED_CODE = 'auth.session_expired';

export interface ApiClientOptions {
  /** `r<n>.<sha12>` of this bundle. */
  clientRelease: string;
  /** Called when any call is refused with 400 `kernel.client_release_unsupported`. */
  onReleaseRefused?: (refusal: ReleaseRefusal) => void;
  /** Called with the `X-Session-Idle-Expires-At` value of every response that carries it (26.2). */
  onIdleExpiresAt?: (iso: string) => void;
  /** Called when a call is answered 401 `auth.session_expired`. */
  onSessionExpired?: () => void;
  /** CSRF token from `GET /auth/session`, held in memory by the caller; sent on state-changing calls (26.2). */
  getCsrfToken?: () => string | undefined;
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
      if (!SAFE_METHODS.has(request.method)) {
        const csrf = options.getCsrfToken?.();
        if (csrf !== undefined) request.headers.set(CSRF_HEADER, csrf);
      }
      const response = await base(request);
      const idle = response.headers.get(SESSION_EXPIRES_HEADER);
      if (idle !== null) options.onIdleExpiresAt?.(idle);
      if (response.status === 400) await inspectRefusal(response, options.onReleaseRefused);
      if (response.status === 401) await inspectExpiry(response, options.onSessionExpired);
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

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function inspectExpiry(response: Response, notify?: () => void) {
  if (notify === undefined) return;
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    if (body.code === SESSION_EXPIRED_CODE) notify();
  } catch {
    // Not a JSON problem body.
  }
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
