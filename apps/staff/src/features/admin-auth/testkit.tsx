// CONTRACT MOCK of identity.yaml (POST /admin/auth/sign-in/{options,verify}, POST /admin/auth/elevation/{options,verify}); body
// shapes are copied from the admin controller and ceremony on the BE-05 branch (`{challengeId, publicKey}`, `{elevationExpiresAt}`,
// `{principalId, csrfToken, idleExpiresAt}`). No real API, database or security key runs in these tests.
import { createShellRuntime } from '@ehr/app-shell';
import type { KeyOutcome, SecurityKey } from './webauthn.js';

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });

export const CHALLENGE = '5d1b9a58-3b4b-4c0c-8f2e-1c1f4a6a9b01';
export const optionsBody = {
  challengeId: CHALLENGE,
  publicKey: {
    challenge: 'AQIDBA',
    timeout: 120000,
    rpId: 'staff.clinic.test',
    userVerification: 'required',
    allowCredentials: [{ id: 'cred_1-A', type: 'public-key', transports: ['usb'] }],
  },
};
export const assertion = {
  id: 'cred_1-A',
  rawId: 'cred_1-A',
  type: 'public-key' as const,
  response: { clientDataJSON: 'Y2Q', authenticatorData: 'YWQ', signature: 'c2ln' },
};

export interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

export function mockRuntime(handler: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const runtime = createShellRuntime({
    clientRelease: 'r5.bbbbbbbbbbbb',
    baseUrl: 'http://portal.test',
    fetch: async (request) => {
      const text = await request.clone().text();
      const s: Seen = {
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: text === '' ? undefined : JSON.parse(text),
      };
      seen.push(s);
      return handler(s);
    },
  });
  return { runtime, seen };
}

export function fakeKey(...outcomes: KeyOutcome[]) {
  const calls: unknown[] = [];
  const key: SecurityKey = {
    async get(options, signal) {
      calls.push({ options, signal });
      return outcomes.shift() ?? { kind: 'ok', assertion };
    },
  };
  return { key, calls };
}
