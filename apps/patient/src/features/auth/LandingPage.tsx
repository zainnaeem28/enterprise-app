import { useCallback, useEffect, useState } from 'react';
import { Button, LoadingState } from '@ehr/ui';
import type { SessionInfo } from '@ehr/app-shell';
import type { PatientRuntime } from '../../app/runtime.js';
import { ProblemPage } from './ProblemPage.js';
import { problemCodeOf, requestIdOf, type Problem } from './problems.js';

type State =
  | { kind: 'loading' }
  | { kind: 'signed-in'; session: SessionInfo; linked: boolean }
  | { kind: 'problem'; problem: Problem };

/**
 * Where the API-owned callback sends the patient. Starts the session through the shell (`GET /auth/session`),
 * then asks `GET /me`. A session with no linked patient is a neutral state: self-registration is not called.
 */
export function LandingPage({
  runtime,
  onSignIn,
  go,
}: {
  runtime: PatientRuntime;
  onSignIn: () => void;
  /** In-app navigation (History API) to the booking screens. */
  go: (to: string) => void;
}) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const session = await runtime.loadSession();
      if (session === undefined) {
        return setState({
          kind: 'problem',
          problem: runtime.lastSessionProblem() ?? { code: 'identity.sign_in_failed' },
        });
      }
      const { data, error, response } = await runtime.api.GET('/api/v1/me', {
        params: { header: runtime.api.header },
      });
      if (error !== undefined || !response.ok) {
        const requestId = requestIdOf(error);
        return setState({
          kind: 'problem',
          problem: {
            code: problemCodeOf(response.status, error),
            ...(requestId === undefined ? {} : { requestId }),
          },
        });
      }
      // Assumption (FE03-R1-02): `getMe` is an opaque object in the contract; we read only an optional
      // `patients` array. The displayed name is the session principal (`/auth/session` displayName).
      const patients = (data as { patients?: unknown } | undefined)?.patients;
      setState({
        kind: 'signed-in',
        session,
        linked: Array.isArray(patients) && patients.length > 0,
      });
    } catch {
      setState({ kind: 'problem', problem: { code: 'kernel.unavailable' } });
    }
  }, [runtime]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') return <LoadingState label="Checking your sign-in" lines={3} />;
  if (state.kind === 'problem')
    return <ProblemPage problem={state.problem} onRetry={() => void load()} onSignIn={onSignIn} />;
  return (
    <section className="ehr-card" aria-labelledby="landing-h">
      <h1 id="landing-h">You are signed in</h1>
      <p>Signed in as {state.session.displayName}.</p>
      {!state.linked && (
        <p>Your account is not linked to a patient record yet. The clinic can link it for you.</p>
      )}
      {state.linked && (
        <nav aria-label="Appointments">
          <ul>
            {[
              ['/book', 'Book an appointment'],
              ['/appointments', 'My appointments'],
            ].map(([to, label]) => (
              <li key={to}>
                <a
                  href={to}
                  onClick={(e) => {
                    e.preventDefault();
                    go(to ?? '/');
                  }}
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <Button onClick={() => void runtime.session.signOut()}>Sign out</Button>
    </section>
  );
}
