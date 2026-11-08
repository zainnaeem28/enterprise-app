import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorState, LoadingState } from '@ehr/ui';
import type { PatientRuntime } from '../../app/runtime.js';
import { useAccount } from '../profile/lib/hooks.js';
import { Problem } from '../profile/lib/Problem.js';
import type { Failure } from '../profile/lib/core.js';
import { createPrevisitApi } from './api.js';
import { PrevisitContext } from './ctx.js';
import { ConsentsPage } from './pages/ConsentsPage.js';
import { EmergencyPage } from './pages/EmergencyPage.js';
import { HubPage } from './pages/HubPage.js';
import { InsurancePage } from './pages/InsurancePage.js';
import { QuestionnairePage } from './pages/QuestionnairePage.js';
import { matchPrevisitRoute } from './routes.js';
import type { Previsit } from './types.js';
import './previsit.css';

/**
 * Pre-visit forms: status of the three items (PP-25..27), the questionnaire, consents to read and sign, insurance card upload and
 * the emergency advice screen (PP-22). Mounted by the app for the paths of `isPrevisitPath`.
 */
export function PrevisitRoutes({
  runtime,
  path,
  go,
  patientId: given,
}: {
  runtime: PatientRuntime;
  path: string;
  go: (to: string) => void;
  /** Whose visit this is when the portal acts for someone else (PP-09). Defaults to the signed-in person. */
  patientId?: string;
}) {
  const api = useMemo(() => createPrevisitApi(runtime), [runtime]);
  const route = matchPrevisitRoute(path);
  const [attempt, setAttempt] = useState(0);
  const { account, failure: accountFailure } = useAccount(runtime, attempt);
  const [previsit, setPrevisit] = useState<Previsit | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [advice, setAdvice] = useState<string | undefined>();
  const reservationId = route?.reservationId;

  useEffect(() => {
    if (reservationId === undefined) return;
    let live = true;
    setFailure(undefined);
    void api.previsit(reservationId).then((r) => {
      if (!live) return;
      if (r.ok) setPrevisit(r.data);
      else setFailure(r);
    });
    return () => {
      live = false;
    };
  }, [api, reservationId, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  if (route === undefined)
    return <ErrorState kind="not-found" homeHref="/appointments" headingLevel={1} />;
  const bad = accountFailure ?? failure;
  if (bad !== undefined) return <Problem failure={bad} onRetry={reload} />;
  if (account === undefined || previsit === undefined)
    return <LoadingState label="Loading" lines={4} />;
  const patientId = given ?? account.selfId ?? account.people[0]?.patientId;
  if (patientId === undefined)
    return <ErrorState kind="not-found" homeHref="/appointments" headingLevel={1} />;

  return (
    <PrevisitContext.Provider
      value={{
        runtime,
        api,
        go,
        reservationId: route.reservationId,
        patientId,
        previsit,
        reload,
        advice,
        setAdvice,
      }}
    >
      {route.name === 'hub' && <HubPage />}
      {route.name === 'questionnaire' && <QuestionnairePage />}
      {route.name === 'consents' && <ConsentsPage />}
      {route.name === 'insurance' && <InsurancePage />}
      {route.name === 'emergency' && <EmergencyPage />}
    </PrevisitContext.Provider>
  );
}
