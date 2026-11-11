import { useCallback, useEffect, useState } from 'react';
import { Button, LoadingState, Icon } from '@ehr/ui';
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
    <section className="patient-dashboard" aria-labelledby="landing-h">
      <div className="patient-welcome">
        <div>
          <p className="ehr-eyebrow">Your health, your space</p>
          <h1 id="landing-h">Welcome back.</h1>
          <p>Signed in as {state.session.displayName}.</p>
        </div>
        <span className="patient-welcome__art" aria-hidden="true">
          <Icon name="heart" size={52} />
        </span>
      </div>
      {!state.linked && (
        <div className="ehr-card">
          <p>Your account is not linked to a patient record yet. The clinic can link it for you.</p>
        </div>
      )}
      {state.linked && (
        <>
          <div className="ehr-section-heading">
            <div>
              <h2>What would you like to do?</h2>
              <p>A little less admin. A little more peace of mind.</p>
            </div>
          </div>
          <nav aria-label="Appointments" className="patient-actions-grid">
            {[
              [
                '/book',
                'Book an appointment',
                'Find a service, choose your doctor, and pick a time that works for you.',
                'plus',
              ],
              [
                '/appointments',
                'My appointments',
                'See your visits, complete pre-visit steps, or update your booking.',
                'calendar',
              ],
              [
                '/profile',
                'My profile',
                'Keep your contact information and personal details up to date.',
                'people',
              ],
              [
                '/privacy',
                'Privacy requests',
                'Manage requests relating to your personal information.',
                'shield',
              ],
            ].map(([to, label, description, icon]) => (
              <a
                key={to}
                className="patient-action-card"
                aria-label={label}
                href={to}
                onClick={(e) => {
                  if (!e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    go(to!);
                  }
                }}
              >
                <span className="ehr-feature-icon">
                  <Icon name={icon!} size={23} />
                </span>
                <h3>{label}</h3>
                <p>{description}</p>
                <span className="patient-action-card__arrow">
                  <Icon name="arrow" />
                </span>
              </a>
            ))}
          </nav>
          <aside className="patient-tip">
            <span className="ehr-feature-icon">
              <Icon name="notes" />
            </span>
            <div>
              <h3>Get ready for your next visit</h3>
              <p>
                Review your details and complete any requested forms from your appointment page.
              </p>
            </div>
            <a
              href="/appointments"
              onClick={(e) => {
                e.preventDefault();
                go('/appointments');
              }}
            >
              View appointments <Icon name="arrow" size={16} />
            </a>
          </aside>
        </>
      )}
      <div className="patient-signout">
        <span>Finished for now?</span>
        <Button onClick={() => void runtime.session.signOut()}>Sign out</Button>
      </div>
    </section>
  );
}
