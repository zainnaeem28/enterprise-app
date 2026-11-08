import { useMemo } from 'react';
import { ErrorState } from '@ehr/ui';
import type { PatientRuntime } from '../../app/runtime.js';
import { createTelehealthApi } from './api.js';
import { JoinPage } from './JoinPage.js';
import type { JoinPageProps } from './JoinPage.js';
import { matchTelehealthRoute } from './routes.js';
import './telehealth.css';

/** Device check, location confirmation, waiting room and join (PP-21, PP-23). Mounted by the app for the paths of `isTelehealthPath`. */
export function TelehealthRoutes({
  runtime,
  path,
  ...rest
}: { runtime: PatientRuntime; path: string } & Omit<JoinPageProps, 'api' | 'reservationId'>) {
  const api = useMemo(() => createTelehealthApi(runtime), [runtime]);
  const route = matchTelehealthRoute(path);
  if (route === undefined)
    return <ErrorState kind="not-found" homeHref="/appointments" headingLevel={1} />;
  return <JoinPage api={api} reservationId={route.reservationId} {...rest} />;
}
