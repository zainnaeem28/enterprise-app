import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorState, LoadingState } from '@ehr/ui';
import type { PatientRuntime } from '../../app/runtime.js';
import { createBookingApi } from './api.js';
import type { Failure } from './api.js';
import { BookingContext, emptyDraft } from './context.js';
import type { Booked, CancellationPolicy, Draft, Pending } from './context.js';
import { Problem } from './components/Problem.js';
import { matchBookingRoute } from './routes.js';
import { AppointmentsPage } from './pages/AppointmentsPage.js';
import { BookedPage } from './pages/BookedPage.js';
import { CancelPage } from './pages/CancelPage.js';
import { ChangePage } from './pages/ChangePage.js';
import { ConfirmStep } from './pages/ConfirmStep.js';
import { DetailPage } from './pages/DetailPage.js';
import { DoctorStep } from './pages/DoctorStep.js';
import { OfferPage } from './pages/OfferPage.js';
import { ServiceStep } from './pages/ServiceStep.js';
import { TimeStep } from './pages/TimeStep.js';
import { WaitlistPage } from './pages/WaitlistPage.js';
import type { PatientRef, Place, Service } from './types.js';
import './booking.css';

interface Loaded {
  patients: PatientRef[];
  services: Service[];
  places: Place[];
}

/**
 * The booking and appointment screens of the patient portal (PP-10..PP-19). Mounted by the app for the paths of
 * `isBookingPath`; the app owns the shell, the session dialogs and the history-based `go`.
 */
export function BookingRoutes({
  runtime,
  path,
  params,
  go,
  policy = {},
}: {
  runtime: PatientRuntime;
  path: string;
  params: URLSearchParams;
  go: (to: string) => void;
  /** The cancellation policy to quote. Defaults to the block-only text without a number (D-3). */
  policy?: CancellationPolicy;
}) {
  const api = useMemo(() => createBookingApi(runtime), [runtime]);
  const [loaded, setLoaded] = useState<Loaded | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [attempt, setAttempt] = useState(0);
  const [patientId, setPatientId] = useState<string>();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [pending, setPending] = useState<Pending | undefined>();
  const [booked, setBooked] = useState<Booked | undefined>();

  useEffect(() => {
    let live = true;
    setFailure(undefined);
    void (async () => {
      // The shell keeps the CSRF token and the idle clock from `GET /auth/session`; without this call (a page opened
      // directly, not through the sign-in landing) every POST below would go out without its CSRF token.
      await runtime.loadSession().catch(() => undefined);
      const [patients, services, places] = await Promise.all([
        api.patients(),
        api.services(),
        api.locations(),
      ]);
      if (!live) return;
      if (!patients.ok) return setFailure(patients);
      // The catalogue is a convenience for names; the screens still work with generic wording when it fails.
      setLoaded({
        patients: patients.data,
        services: services.ok ? services.data : [],
        places: places.ok ? places.data : [],
      });
      setPatientId((current) => {
        const own = patients.data.find((p) => p.relation === 'self') ?? patients.data[0];
        return current ?? own?.patientId;
      });
    })();
    return () => {
      live = false;
    };
  }, [api, runtime, attempt]);

  const reset = useCallback(() => {
    setDraft(emptyDraft);
    setPending(undefined);
    setBooked(undefined);
  }, []);

  const route = matchBookingRoute(path);
  if (route === undefined)
    return <ErrorState kind="not-found" homeHref="/appointments" headingLevel={1} />;
  if (failure !== undefined)
    return <Problem failure={failure} onRetry={() => setAttempt((n) => n + 1)} />;
  if (loaded === undefined || patientId === undefined) {
    if (loaded !== undefined && loaded.patients.length === 0)
      return (
        <section className="ehr-card">
          <h1>Booking is not available yet</h1>
          <p>Your account is not linked to a patient record yet. The clinic can link it for you.</p>
        </section>
      );
    return <LoadingState label="Loading" lines={3} />;
  }

  let page;
  switch (route.name) {
    case 'appointments':
      page = <AppointmentsPage />;
      break;
    case 'detail':
      page = <DetailPage id={route.id} />;
      break;
    case 'change':
      page = <ChangePage id={route.id} />;
      break;
    case 'change-confirm':
      page = <ConfirmStep />;
      break;
    case 'cancel':
      page = <CancelPage id={route.id} />;
      break;
    case 'service':
      page = <ServiceStep />;
      break;
    case 'doctor':
      page = <DoctorStep />;
      break;
    case 'time':
      page = <TimeStep backTo="/book/doctor" nextTo="/book/confirm" />;
      break;
    case 'confirm':
      page = <ConfirmStep />;
      break;
    case 'done':
      page = <BookedPage id={route.id} />;
      break;
    case 'waitlist':
      page = <WaitlistPage />;
      break;
    case 'offer':
      page = <OfferPage offerId={route.id} expires={params.get('expires')} />;
      break;
  }

  return (
    <BookingContext.Provider
      value={{
        api,
        go,
        patients: loaded.patients,
        patientId,
        setPatientId,
        draft,
        setDraft,
        pending,
        setPending,
        booked,
        setBooked,
        services: loaded.services,
        places: loaded.places,
        policy,
        reset,
      }}
    >
      {page}
    </BookingContext.Provider>
  );
}
