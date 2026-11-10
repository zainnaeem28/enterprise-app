import { createPatientRuntime } from './runtime.js';

export type Respond = (request: Request) => Response | Promise<Response>;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });

export const SESSION = {
  principalId: '11111111-1111-4111-8111-111111111111',
  realm: 'patient',
  audience: 'patient',
  displayName: 'Test Patient',
  csrfToken: 'csrf-test',
  idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  roles: [],
  permissions: [],
  patients: [],
};

export function runtimeWith(respond: Respond) {
  const calls: string[] = [];
  const navigations: string[] = [];
  const runtime = createPatientRuntime({
    clientRelease: 'r5.bbbbbbbbbbbb',
    baseUrl: 'http://portal.test',
    navigate: (to) => navigations.push(to),
    fetch: async (request) => {
      // The maintenance banner read is covered in app-shell; keep this log to the calls under test.
      if (new URL(request.url).pathname === '/api/v1/banners')
        return json(200, { items: [], nextCursor: null });
      calls.push(
        `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`,
      );
      return respond(request);
    },
  });
  return { runtime, calls, navigations };
}
