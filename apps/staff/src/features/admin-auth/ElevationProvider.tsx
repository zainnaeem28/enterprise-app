import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ElevationDialog } from './ElevationDialog.js';
import { isElevationRequired } from './elevation.js';
import type { Elevation, ElevationRequest } from './elevation.js';

type Answer = { response: Response; error?: unknown };

export interface ElevationApi {
  elevation: Elevation;
  /** Resolves true once a live grant exists (opens the dialog if none), false if the administrator cancels. */
  ensure(request: ElevationRequest): Promise<boolean>;
  /**
   * Run a privileged call. Asks for the key first when no grant is live; if the server still answers 403
   * `identity.elevation_required` (the grant expired or was revoked mid-form) it asks once more and retries once.
   * Resolves undefined when the administrator cancels, so the form keeps what was typed.
   */
  callPrivileged<R extends Answer>(
    request: ElevationRequest,
    run: () => Promise<R>,
  ): Promise<R | undefined>;
}

const Ctx = createContext<ElevationApi | undefined>(undefined);

export function useElevation(): ElevationApi {
  const v = useContext(Ctx);
  if (v === undefined) throw new Error('useElevation needs an ElevationProvider');
  return v;
}

export function ElevationProvider({
  elevation,
  children,
}: {
  elevation: Elevation;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<ElevationRequest | undefined>();
  // One dialog at a time: callers that arrive while it is open wait for the same answer.
  const waiting = useRef<Promise<boolean> | undefined>(undefined);
  const settle = useRef<((ok: boolean) => void) | undefined>(undefined);

  const ensure = useCallback(
    (request: ElevationRequest): Promise<boolean> => {
      if (elevation.store.isLive()) return Promise.resolve(true);
      if (waiting.current !== undefined) return waiting.current;
      const p = new Promise<boolean>((resolve) => {
        settle.current = (ok) => {
          waiting.current = undefined;
          settle.current = undefined;
          setOpen(undefined);
          resolve(ok);
        };
      });
      waiting.current = p;
      setOpen(request);
      return p;
    },
    [elevation],
  );

  const api = useMemo<ElevationApi>(
    () => ({
      elevation,
      ensure,
      async callPrivileged(request, run) {
        if (!(await ensure(request))) return undefined;
        const first = await run();
        if (!isElevationRequired(first)) return first;
        elevation.store.clear();
        if (!(await ensure(request))) return undefined;
        return run();
      },
    }),
    [elevation, ensure],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {open !== undefined && (
        <ElevationDialog
          request={open}
          elevation={elevation}
          onElevated={() => settle.current?.(true)}
          onCancel={() => settle.current?.(false)}
        />
      )}
    </Ctx.Provider>
  );
}
