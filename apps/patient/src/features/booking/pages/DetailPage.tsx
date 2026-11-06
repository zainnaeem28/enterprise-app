import { useCallback, useEffect, useState } from 'react';
import { Button, LoadingState } from '@ehr/ui';
import type { Failure } from '../api.js';
import { useBooking, useHeadingFocus, usePageTitle } from '../context.js';
import { Problem } from '../components/Problem.js';
import { PolicyText, statusChip, VisitSummary } from '../components/Summary.js';
import { downloadIcs } from '../ics.js';
import type { Appointment } from '../types.js';

/** Loads one appointment; a 404 reads the same for "missing" and "not yours" (CN-04). */
export function useAppointment(id: string) {
  const { api } = useBooking();
  const [appointment, setAppointment] = useState<Appointment | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const load = useCallback(async () => {
    setFailure(undefined);
    const r = await api.appointment(id);
    if (r.ok) setAppointment(r.data);
    else setFailure(r);
  }, [api, id]);
  useEffect(() => {
    setAppointment(undefined);
    void load();
  }, [load]);
  return { appointment, failure, reload: load };
}

/** PP-15: appointment detail with Change time, Cancel and Add to calendar. */
export function DetailPage({ id }: { id: string }) {
  const { go } = useBooking();
  const { appointment: a, failure, reload } = useAppointment(id);
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Appointment');

  if (failure !== undefined) return <Problem failure={failure} onRetry={() => void reload()} />;
  if (a === undefined) return <LoadingState label="Loading your appointment" lines={4} />;
  const open = a.status === 'confirmed';
  return (
    <section aria-labelledby="detail-h" className="ehr-card booking">
      <h1 id="detail-h" ref={heading} tabIndex={-1}>
        Appointment details
      </h1>
      <VisitSummary
        serviceId={a.serviceId}
        locationId={a.locationId}
        startsAt={a.startsAt}
        mode={a.mode}
        timeZone={a.locationTimeZone}
        status={statusChip(a)}
      />
      {open && <PolicyText />}
      <p className="booking-actions">
        {open && (
          <>
            <Button variant="primary" onClick={() => go(`/appointments/${a.id}/change`)}>
              Change time
            </Button>{' '}
            <Button onClick={() => go(`/appointments/${a.id}/cancel`)}>
              Cancel appointment
            </Button>{' '}
          </>
        )}
        <Button onClick={() => downloadIcs(a)}>Add to calendar</Button>{' '}
        <Button onClick={() => go('/appointments')}>Back to appointments</Button>
      </p>
    </section>
  );
}
