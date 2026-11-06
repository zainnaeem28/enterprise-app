import type { createApiClient } from '../api/client.js';
import type { ExtendResult } from './session-store.js';

type Api = ReturnType<typeof createApiClient>;

/** Extend through the generated operation (no hand-written URL). */
export function extendSession(api: Api) {
  return async (): Promise<ExtendResult> => {
    try {
      const { data, response } = await api.POST('/api/v1/auth/session/extend', {
        params: { header: api.header },
      });
      if (data !== undefined) return { ok: true, idleExpiresAt: data.idleExpiresAt };
      return { ok: false, expired: response.status === 401 };
    } catch {
      return { ok: false, expired: false };
    }
  };
}

export function signOutSession(api: Api) {
  return async (): Promise<boolean> => {
    try {
      const { response } = await api.POST('/api/v1/auth/sign-out', {
        params: { header: api.header },
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}
