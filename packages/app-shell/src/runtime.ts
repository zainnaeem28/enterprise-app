import { createApiClient } from './api/client.js';
import { ReleaseStore } from './release/release-store.js';
import { extendSession, signOutSession } from './session/actions.js';
import { SessionStore } from './session/session-store.js';

export interface ShellRuntimeOptions {
  clientRelease: string;
  /** Navigate to sign-in after sign-out. */
  afterSignOut?: () => void;
  baseUrl?: string;
  fetch?: (request: Request) => Promise<Response>;
}

export interface SessionInfo {
  displayName: string;
  audience: string;
  realm: string;
  permissions: readonly string[];
}

/**
 * One typed client, one release store and one session store per page, wired together: every response
 * feeds the idle deadline, a 401 `auth.session_expired` ends the session, a 400
 * `kernel.client_release_unsupported` opens the blocking release dialog. The CSRF token lives in this
 * closure only (never storage, URL or log).
 */
export function createShellRuntime(options: ShellRuntimeOptions) {
  let csrf: string | undefined;
  const releases = new ReleaseStore({ clientRelease: options.clientRelease });
  // eslint-disable-next-line prefer-const -- `api` and `session` refer to each other
  let session: SessionStore;
  const api = createApiClient({
    clientRelease: options.clientRelease,
    onReleaseRefused: ({ requestId }) => releases.refuse(requestId),
    onIdleExpiresAt: (iso) => session.setIdleExpiresAt(iso),
    onSessionExpired: () => session.end(),
    getCsrfToken: () => csrf,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  session = new SessionStore({
    extend: extendSession(api),
    signOut: async () => {
      await signOutSession(api)();
      csrf = undefined;
    },
    ...(options.afterSignOut === undefined ? {} : { afterSignOut: options.afterSignOut }),
  });

  /** `GET /auth/session`: keeps the CSRF token in memory and starts the idle clock. Undefined when signed out. */
  async function loadSession(): Promise<SessionInfo | undefined> {
    const { data } = await api.GET('/api/v1/auth/session', { params: { header: api.header } });
    if (data === undefined) return undefined;
    csrf = data.csrfToken;
    session.setIdleExpiresAt(data.idleExpiresAt);
    return {
      displayName: data.displayName,
      audience: data.audience,
      realm: data.realm,
      permissions: data.permissions,
    };
  }

  return { clientRelease: options.clientRelease, api, releases, session, loadSession };
}
export type ShellRuntime = ReturnType<typeof createShellRuntime>;
