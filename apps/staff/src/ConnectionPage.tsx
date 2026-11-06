import { useCallback, useEffect, useState } from 'react';
import { Button } from '@ehr/ui';
import type { createApiClient } from '@ehr/app-shell';

type Api = ReturnType<typeof createApiClient>;
type State =
  | { kind: 'loading' }
  | { kind: 'signed-in' }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string; requestId?: string };

/**
 * Proves the same-origin typed path: `getAuthSession` (GET /api/v1/auth/session, ruling healthz-class-ruling rev a7c6c37e) is called on load and on "Check again" only (never on a timer), through the client
 * generated from the F-08 contract. `/healthz` is outside the generated catalogue (28.6 exempt).
 */
export function ConnectionPage({ api }: { api: Api }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const { data, error, response } = await api.GET('/api/v1/auth/session', {
        params: { header: api.header },
      });
      if (response.status === 401) return setState({ kind: 'signed-out' });
      if (data !== undefined) {
        // The body carries csrfToken: never shown, stored or logged.
        return setState({ kind: 'signed-in' });
      }
      const e = error as { title?: unknown; requestId?: unknown } | undefined;
      setState({
        kind: 'error',
        message:
          typeof e?.title === 'string' ? e.title : 'The server could not answer this request.',
        ...(typeof e?.requestId === 'string' ? { requestId: e.requestId } : {}),
      });
    } catch {
      setState({ kind: 'error', message: 'The server could not be reached.' });
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="ehr-card" aria-labelledby="conn-h">
      <h2 id="conn-h">Server connection</h2>
      <div aria-live="polite">
        {state.kind === 'loading' && <p>Checking the server…</p>}
        {state.kind === 'signed-out' && <p>The server answered. You are not signed in.</p>}
        {state.kind === 'signed-in' && <p>The server answered. You are signed in.</p>}
        {state.kind === 'error' && (
          <p>
            {state.message}
            {state.requestId !== undefined && (
              <>
                {' '}
                Reference for support: <code>{state.requestId}</code>
              </>
            )}
          </p>
        )}
      </div>
      <Button onClick={() => void load()}>Check again</Button>
    </section>
  );
}
