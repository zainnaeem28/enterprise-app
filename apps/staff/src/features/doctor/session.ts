import { useEffect, useState } from 'react';
import type { ShellRuntime } from '@ehr/app-shell';

export interface DoctorSession {
  principalId: string;
  displayName: string;
  permissions: readonly string[];
  roleKeys: readonly string[];
  locationIds: readonly string[];
}
export type DoctorSessionLoad =
  { kind: 'loading' } | { kind: 'ready'; session: DoctorSession } | { kind: 'error' };

/** Reads who the doctor is, the permissions and the role locations once from `GET /auth/session`. They decide what is drawn only. */
export function useDoctorSession(runtime: Pick<ShellRuntime, 'api'>): DoctorSessionLoad {
  const [state, setState] = useState<DoctorSessionLoad>({ kind: 'loading' });
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
          session: {
            principalId: data.principalId,
            displayName: data.displayName,
            permissions: data.permissions,
            roleKeys: data.roles.map((r) => r.key),
            locationIds: [...ids],
          },
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
