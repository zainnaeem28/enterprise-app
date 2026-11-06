import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShellRuntime } from './runtime.js';

const T0 = Date.parse('2026-01-01T09:00:00Z');
const MIN = 60_000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function make(handler: (r: Request) => Response) {
  const calls: Request[] = [];
  const rt = createShellRuntime({
    clientRelease: 'r3.cccccccccccc',
    baseUrl: 'http://portal.test',
    fetch: async (r) => {
      calls.push(r.clone());
      return handler(r);
    },
  });
  return { rt, calls };
}

const session = {
  principalId: '8d3c1c52-7a56-4a5b-8a2f-3c9a1f0a1111',
  realm: 'staff',
  audience: 'google',
  displayName: 'Dr Sample',
  csrfToken: 'csrf-1',
  idleExpiresAt: new Date(T0 + 15 * MIN).toISOString(),
  roles: [],
  permissions: ['note.read'],
  patients: [],
};

describe('shell runtime', () => {
  it('loadSession starts the idle clock and keeps the CSRF token for later writes only', async () => {
    const { rt, calls } = make((r) =>
      r.url.endsWith('/auth/session')
        ? json(200, session)
        : json(200, { idleExpiresAt: session.idleExpiresAt }),
    );
    const info = await rt.loadSession();
    expect(info).toMatchObject({ displayName: 'Dr Sample', audience: 'google' });
    expect(JSON.stringify(info)).not.toContain('csrf-1');
    vi.advanceTimersByTime(13 * MIN);
    expect(rt.session.getSnapshot().phase).toBe('warning');
    await rt.session.extend();
    expect(calls[0]!.headers.get('X-CSRF-Token')).toBeNull();
    const ext = calls[1]!;
    expect(ext.method).toBe('POST');
    expect(new URL(ext.url).pathname).toBe('/api/v1/auth/session/extend');
    expect(ext.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(ext.headers.get('X-Client-Release')).toBe('r3.cccccccccccc');
  });

  it('every response header moves the deadline, passive or not', async () => {
    const { rt } = make(() =>
      json(200, session, { 'X-Session-Idle-Expires-At': new Date(T0 + 5 * MIN).toISOString() }),
    );
    await rt.api.GET('/api/v1/auth/session', { params: { header: rt.api.header } });
    vi.advanceTimersByTime(3 * MIN);
    expect(rt.session.getSnapshot().phase).toBe('warning');
  });

  it('401 auth.session_expired ends the session; 401 auth.unauthenticated does not', async () => {
    let code = 'auth.unauthenticated';
    const { rt } = make(() => json(401, { code }));
    await rt.api.GET('/api/v1/auth/session', { params: { header: rt.api.header } });
    expect(rt.session.getSnapshot().phase).toBe('active');
    code = 'auth.session_expired';
    await rt.api.GET('/api/v1/auth/session', { params: { header: rt.api.header } });
    expect(rt.session.getSnapshot().phase).toBe('ended');
  });

  it('a refused release opens the release dialog state', async () => {
    const { rt } = make(() =>
      json(400, { code: 'kernel.client_release_unsupported', requestId: 'q' }),
    );
    await rt.api.GET('/api/v1/auth/session', { params: { header: rt.api.header } });
    expect(rt.releases.getSnapshot()).toMatchObject({ refused: true, requestId: 'q' });
  });

  it('sign-out calls the generated operation and forgets the token', async () => {
    const afterSignOut = vi.fn();
    const calls: Request[] = [];
    const rt = createShellRuntime({
      clientRelease: 'r3.cccccccccccc',
      baseUrl: 'http://portal.test',
      afterSignOut,
      fetch: async (r) => {
        calls.push(r.clone());
        return r.url.endsWith('/auth/session')
          ? json(200, session)
          : new Response(null, { status: 204 });
      },
    });
    await rt.loadSession();
    await rt.session.signOut();
    expect(new URL(calls[1]!.url).pathname).toBe('/api/v1/auth/sign-out');
    expect(calls[1]!.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(afterSignOut).toHaveBeenCalledOnce();
  });
});
