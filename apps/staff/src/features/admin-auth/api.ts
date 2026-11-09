import type { ShellRuntime } from '@ehr/app-shell';
import { parseRequestOptions } from './webauthn.js';
import type { RequestOptionsJson, SecurityKey } from './webauthn.js';

type Api = ShellRuntime['api'];

/** Handle format of ARCH 26.1 (B2-6), checked after lower-casing; the server checks it again. */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
export const normaliseHandle = (raw: string): string => raw.trim().toLowerCase();

export type Failure =
  | { ok: false; reason: 'rejected' | 'cancelled' | 'unsupported' | 'unavailable' }
  | { ok: false; reason: 'rate_limited'; retryAfterSeconds: number };
export type Ceremony<T> = { ok: true; value: T } | Failure;

const retryAfter = (r: Response): number => {
  const n = Number(r.headers.get('Retry-After'));
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 5;
};

/** Map a non-2xx answer: 429 and 5xx are told apart (retry later), everything else is one "rejected" (ARCH 26.1). */
function refusal(response: Response): Failure {
  if (response.status === 429)
    return { ok: false, reason: 'rate_limited', retryAfterSeconds: retryAfter(response) };
  if (response.status >= 500) return { ok: false, reason: 'unavailable' };
  return { ok: false, reason: 'rejected' };
}

/** Options from the server, then the key, as one step shared by sign-in and elevation. */
async function askKey(
  fetchOptions: () => Promise<{ data?: unknown; response: Response }>,
  key: SecurityKey,
  signal: AbortSignal | undefined,
) {
  const { data, response } = await fetchOptions();
  if (!response.ok) return refusal(response);
  const body = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const options: RequestOptionsJson | undefined = parseRequestOptions(body['publicKey']);
  const challengeId = body['challengeId'];
  if (options === undefined || typeof challengeId !== 'string')
    return { ok: false, reason: 'rejected' } as const;
  const outcome = await key.get(options, signal);
  if (outcome.kind === 'cancelled' || outcome.kind === 'unsupported')
    return { ok: false, reason: outcome.kind } as const;
  if (outcome.kind === 'error') return { ok: false, reason: 'rejected' } as const;
  return { ok: true, challengeId, assertion: outcome.assertion } as const;
}

export interface SignedIn {
  csrfToken: string;
  idleExpiresAt: string;
}

/** `POST /admin/auth/sign-in/options` → key → `POST /admin/auth/sign-in/verify`. One failure shape for every refusal. */
export async function adminSignIn(
  api: Api,
  key: SecurityKey,
  handle: string,
  signal?: AbortSignal,
): Promise<Ceremony<SignedIn>> {
  try {
    const step = await askKey(
      () =>
        api.POST('/api/v1/admin/auth/sign-in/options', {
          params: { header: api.header },
          body: { handle },
        }),
      key,
      signal,
    );
    if (!step.ok) return step;
    const { data, response } = await api.POST('/api/v1/admin/auth/sign-in/verify', {
      params: { header: api.header },
      body: { challengeId: step.challengeId, handle, assertion: { ...step.assertion } },
    });
    if (!response.ok) return refusal(response);
    const d = data as Partial<SignedIn> | undefined;
    if (typeof d?.csrfToken !== 'string' || typeof d.idleExpiresAt !== 'string')
      return { ok: false, reason: 'rejected' };
    return { ok: true, value: { csrfToken: d.csrfToken, idleExpiresAt: d.idleExpiresAt } };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** `POST /admin/auth/elevation/options` → key → `POST /admin/auth/elevation/verify` → `elevationExpiresAt` (ARCH 26.3, C1). */
export async function adminElevate(
  api: Api,
  key: SecurityKey,
  signal?: AbortSignal,
): Promise<Ceremony<{ elevationExpiresAt: string }>> {
  try {
    const step = await askKey(
      () => api.POST('/api/v1/admin/auth/elevation/options', { params: { header: api.header } }),
      key,
      signal,
    );
    if (!step.ok) return step;
    const { data, response } = await api.POST('/api/v1/admin/auth/elevation/verify', {
      params: { header: api.header },
      body: { challengeId: step.challengeId, assertion: { ...step.assertion } },
    });
    if (!response.ok) return refusal(response);
    const at = data?.elevationExpiresAt;
    if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)))
      return { ok: false, reason: 'rejected' };
    return { ok: true, value: { elevationExpiresAt: at } };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
