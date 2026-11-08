import { useCallback, useEffect, useRef, useState } from 'react';
import type { Failure, Outcome } from './http.js';

export type Loaded<T> =
  | { kind: 'loading' }
  | { kind: 'error'; failure: Failure }
  | {
      kind: 'ready';
      data: T;
      etag?: number;
      updatedAt: Date;
      refreshing: boolean;
      failure?: Failure;
    };

/**
 * Loads once on mount and again on `reload()`, never on a timer: staff routes are interactive, so passive polling would look like
 * activity to the idle clock (ARCHITECTURE 26.2). A reload keeps the old content on screen (UI-UX 6, loading refresh).
 * `deps` restarts the load from scratch (a different location or patient).
 */
export function useLoad<T>(
  load: () => Promise<Outcome<T>>,
  deps: readonly unknown[],
  enabled = true,
): { state: Loaded<T>; reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const first = useRef(true);

  useEffect(() => {
    first.current = true;
    setState({ kind: 'loading' });
  }, deps); // deps are the caller's identity of the resource

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState((s) => (s.kind === 'ready' ? { ...s, refreshing: true } : s));
    void loadRef.current().then((o) => {
      if (!live) return;
      first.current = false;
      if (o.ok)
        setState({
          kind: 'ready',
          data: o.data,
          ...(o.etag === undefined ? {} : { etag: o.etag }),
          updatedAt: new Date(),
          refreshing: false,
        });
      else
        setState((s) =>
          s.kind === 'ready'
            ? { ...s, refreshing: false, failure: o }
            : { kind: 'error', failure: o },
        );
    });
    return () => {
      live = false;
    };
  }, [tick, enabled, ...deps]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { state, reload };
}
