import type { createApiClient } from '@ehr/app-shell';
import { problemCodeOf, requestIdOf } from './problems.js';
import type { Problem } from './problems.js';

type Api = ReturnType<typeof createApiClient>;

export const SIGN_IN_PATH = '/api/v1/auth/sign-in';

export type SignInStart = { kind: 'redirect' } | { kind: 'problem'; problem: Problem };

/**
 * Asks `getAuthSignIn` (generated client) to start the code flow without following the redirect, so a refusal
 * (400, 409, 429, 503, 504) becomes a page of ours instead of raw JSON in the browser. On success the caller
 * navigates the whole page to the same operation. No code, state or token is read, stored or logged here.
 */
export async function probeSignIn(api: Api, returnTo: string): Promise<SignInStart> {
  try {
    const { error, response } = await api.GET(SIGN_IN_PATH, {
      params: { query: { returnTo } },
      redirect: 'manual',
    });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
      return { kind: 'redirect' };
    const requestId = requestIdOf(error);
    return {
      kind: 'problem',
      problem: {
        code: problemCodeOf(response.status, error),
        ...(requestId === undefined ? {} : { requestId }),
      },
    };
  } catch {
    return { kind: 'problem', problem: { code: 'kernel.unavailable' } };
  }
}

/** The URL of `getAuthSignIn` with the checked `returnTo`; the only place the portal builds it. */
export function signInUrl(returnTo: string): string {
  return `${SIGN_IN_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
}
