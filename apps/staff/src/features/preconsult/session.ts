import { useEffect, useState } from 'react';
import type { ShellRuntime } from '@ehr/app-shell';

export interface DeskSession {
  permissions: readonly string[];
  /** Locations the roles are bound to. A role with no `locationId` is organisation-wide: the desk then asks the API per location it is given. */
  locationIds: readonly string[];
}

export type DeskSessionLoad =
  { kind: 'loading' } | { kind: 'ready'; session: DeskSession } | { kind: 'error' };

/** Reads permissions and role locations once from `GET /auth/session`. They decide what is drawn; the server decides what is allowed. */
export function useDeskSession(runtime: Pick<ShellRuntime, 'api'>): DeskSessionLoad {
  const [state, setState] = useState<DeskSessionLoad>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { data } = await runtime.api.GET('/api/v1/auth/session', {
          params: { header: runtime.api.header },
        });
        if (!live) return;
        if (data === undefined) return setState({ kind: 'error' });
        const ids = new Set<string>();
        for (const r of data.roles) if (typeof r.locationId === 'string') ids.add(r.locationId);
        setState({
          kind: 'ready',
          session: { permissions: data.permissions, locationIds: [...ids] },
        });
      } catch {
        if (live) setState({ kind: 'error' });
      }
    })();
    return () => {
      live = false;
    };
  }, [runtime]);
  return state;
}
