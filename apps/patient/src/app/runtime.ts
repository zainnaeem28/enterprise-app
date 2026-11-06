import { createShellRuntime } from '@ehr/app-shell';
import { problemCodeOf, requestIdOf } from '../features/auth/problems.js';
import type { Problem } from '../features/auth/problems.js';

export interface PatientRuntimeOptions {
  clientRelease: string;
  navigate: (to: string) => void;
  baseUrl?: string;
  fetch?: (request: Request) => Promise<Response>;
}

const SESSION_PATH = '/api/v1/auth/session';

/**
 * The shell runtime (typed client, release and session stores) plus the reason the last `GET /auth/session` was
 * refused, which `loadSession` does not expose. Only the code and request id are kept, never the body.
 */
export function createPatientRuntime(options: PatientRuntimeOptions) {
  let lastSessionProblem: Problem | undefined;
  const send = options.fetch ?? ((request: Request) => globalThis.fetch(request));
  const shell = createShellRuntime({
    clientRelease: options.clientRelease,
    afterSignOut: () => options.navigate('/'),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    fetch: async (request) => {
      const response = await send(request);
      if (new URL(request.url, 'http://placeholder.invalid').pathname === SESSION_PATH) {
        if (response.ok) lastSessionProblem = undefined;
        else {
          const body: unknown = await response
            .clone()
            .json()
            .catch(() => undefined);
          const requestId = requestIdOf(body);
          lastSessionProblem = {
            code: problemCodeOf(response.status, body),
            ...(requestId === undefined ? {} : { requestId }),
          };
        }
      }
      return response;
    },
  });
  return {
    ...shell,
    navigate: options.navigate,
    lastSessionProblem: () => lastSessionProblem,
  };
}
export type PatientRuntime = ReturnType<typeof createPatientRuntime>;
