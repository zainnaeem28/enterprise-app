import { Banner, Button } from '@ehr/ui';
import { useBooking, useHeadingFocus, usePageTitle } from '../context.js';
import { BookingSteps } from '../components/BookingSteps.js';
import { VisitSummary } from '../components/Summary.js';
import { downloadIcs } from '../ics.js';

/** PP-14: booked (or changed), with add to calendar. */
export function BookedPage({ id }: { id: string }) {
  const { booked, go, reset } = useBooking();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Booked');
  const a = booked?.appointment;
  if (a === undefined || a.id !== id) {
    // Opened from a bookmark or after a refresh: the confirmation is not kept, the appointment is.
    return (
      <section aria-labelledby="done-h" className="ehr-card booking">
        <h1 id="done-h" ref={heading} tabIndex={-1}>
          Your appointments
        </h1>
        <p>
          <Button variant="primary" onClick={() => go(`/appointments/${id}`)}>
            Open this appointment
          </Button>
        </p>
      </section>
    );
  }
  const changed = booked?.kind === 'changed';
  return (
    <section aria-labelledby="done-h" className="ehr-card booking">
      {!changed && <BookingSteps current="done" />}
      <h1 id="done-h" ref={heading} tabIndex={-1}>
        {changed ? 'Your appointment was changed' : 'Your appointment is booked'}
      </h1>
      <Banner tone="info">We will remind you before your visit.</Banner>
      <VisitSummary
        serviceId={a.serviceId}
        locationId={a.locationId}
        startsAt={a.startsAt}
        mode={a.mode}
        timeZone={a.locationTimeZone}
      />
      <p className="booking-actions">
        <Button variant="primary" onClick={() => downloadIcs(a)}>
          Add to calendar
        </Button>{' '}
        <Button onClick={() => go(`/appointments/${a.id}`)}>View appointment</Button>{' '}
        <Button
          onClick={() => {
            reset();
            go('/appointments');
          }}
        >
          Back to appointments
        </Button>
      </p>
    </section>
  );
}
