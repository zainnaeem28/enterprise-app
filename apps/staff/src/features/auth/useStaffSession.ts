import { useCallback, useEffect, useState } from 'react';
import type { ShellRuntime } from '@ehr/app-shell';

export interface StaffSession {
  displayName: string;
  audience: string;
  realm: string;
  /** Role keys from `GET /auth/session`; used only to choose which links to offer. */
  roleKeys: readonly string[];
}

export type SessionLoad =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; session: StaffSession }
  | { kind: 'error' };

/**
 * Loads the session once on mount (and on `reload`), never on a timer: passive traffic must not look like
 * activity (ARCH 26.2). `loadSession` keeps the CSRF token and starts the idle clock; the roles come from the same
 * endpoint through the typed client, because the shell's `SessionInfo` does not carry them.
 */
export function useStaffSession(runtime: Pick<ShellRuntime, 'api' | 'loadSession'>) {
  const [state, setState] = useState<SessionLoad>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    const done = (s: SessionLoad) => {
      if (live) setState(s);
    };
    (async () => {
      try {
        const info = await runtime.loadSession();
        if (info === undefined) return done({ kind: 'signed-out' });
        const { data } = await runtime.api.GET('/api/v1/auth/session', {
          params: { header: runtime.api.header },
        });
        done({
          kind: 'signed-in',
          session: {
            displayName: info.displayName,
            audience: info.audience,
            realm: info.realm,
            roleKeys: data?.roles.map((r) => r.key) ?? [],
          },
        });
      } catch {
        done({ kind: 'error' });
      }
    })();
    return () => {
      live = false;
    };
  }, [runtime, attempt]);

  const reload = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  return { state, reload };
}
