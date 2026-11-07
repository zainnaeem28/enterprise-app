import { useRef, useState } from 'react';
import { Banner, Button } from '@ehr/ui';
import { newKey, waitlistWindow } from '../api.js';
import type { Failure } from '../api.js';
import { useBooking, useHeadingFocus, usePageTitle } from '../context.js';
import { isRefusal, Problem, Refusal } from '../components/Problem.js';
import { SummaryRow } from '../components/Summary.js';

/** PP-18: join the waitlist for the visit chosen so far (service, place, doctor, type). */
export function WaitlistPage() {
  const { api, go, draft, patientId, services, places } = useBooking();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [joined, setJoined] = useState(false);
  const key = useRef(newKey());
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Waitlist');

  const service = services.find((s) => s.id === draft.serviceId);
  const place = places.find((p) => p.id === draft.locationId);

  async function join() {
    if (busy || draft.serviceId === undefined) return;
    setBusy(true);
    const r = await api.joinWaitlist(
      {
        patientId,
        serviceId: draft.serviceId,
        ...waitlistWindow(),
        ...(draft.locationId ? { locationId: draft.locationId } : {}),
        ...(draft.clinicianId ? { clinicianId: draft.clinicianId } : {}),
      },
      key.current,
    );
    setBusy(false);
    if (r.ok) return setJoined(true);
    setFailure(r);
  }

  if (draft.serviceId === undefined) {
    return (
      <section aria-labelledby="wl-h" className="ehr-card booking">
        <h1 id="wl-h" ref={heading} tabIndex={-1}>
          Join the waitlist
        </h1>
        <p>Choose a service first.</p>
        <Button variant="primary" onClick={() => go('/book')}>
          Choose a service
        </Button>
      </section>
    );
  }

  if (joined) {
    return (
      <section aria-labelledby="wl-h" className="ehr-card booking">
        <h1 id="wl-h" ref={heading} tabIndex={-1}>
          You are on the waitlist
        </h1>
        <Banner tone="info">
          If a time opens up we will send you an offer. You will have a short time to accept it. You
          can still book any other time that is open.
        </Banner>
        <p className="booking-actions">
          <Button variant="primary" onClick={() => go('/appointments')}>
            Back to appointments
          </Button>
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="wl-h" className="ehr-card booking">
      <h1 id="wl-h" ref={heading} tabIndex={-1}>
        Join the waitlist
      </h1>
      <p>We will offer you a time if one opens up for this visit.</p>
      <dl className="booking-summary">
        <SummaryRow term="Visit">{service?.name ?? 'Appointment'}</SummaryRow>
        <SummaryRow term="Type">{draft.mode === 'video' ? 'Video visit' : 'In person'}</SummaryRow>
        {place !== undefined && <SummaryRow term="Where">{place.name}</SummaryRow>}
      </dl>
      {failure !== undefined &&
        (isRefusal(failure) ? (
          <Refusal failure={failure} />
        ) : (
          <Problem failure={failure} onRetry={() => void join()} />
        ))}
      <p className="booking-actions">
        <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => void join()}>
          Join the waitlist
        </Button>{' '}
        <Button onClick={() => go('/book/time')}>Back to times</Button>
      </p>
    </section>
  );
}
