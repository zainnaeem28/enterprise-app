import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, LoadingState, RefreshingContent } from '@ehr/ui';
import type { Failure } from '../api.js';
import { useBooking, useHeadingFocus, usePageTitle } from '../context.js';
import { Problem } from '../components/Problem.js';
import { statusChip } from '../components/Summary.js';
import { appointmentWhen } from '../time.js';
import type { Appointment } from '../types.js';

/** The patient's upcoming appointments. No timer-driven polling on this route (UI-UX 7.4): refresh on open and on the button. */
export function AppointmentsPage() {
  const { api, go, patientId, reset, services } = useBooking();
  const [items, setItems] = useState<Appointment[] | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string>();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Appointments');

  const load = useCallback(async () => {
    setRefreshing(true);
    const r = await api.appointments(patientId);
    setRefreshing(false);
    if (!r.ok) return setFailure(r);
    setFailure(undefined);
    setItems([...r.data].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
    setUpdatedAt(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
  }, [api, patientId]);
  useEffect(() => {
    void load();
  }, [load]);

  const book = () => {
    reset();
    go('/book');
  };

  return (
    <section aria-labelledby="appts-h" className="ehr-card booking">
      <h1 id="appts-h" ref={heading} tabIndex={-1}>
        Your appointments
      </h1>
      <p>
        <Button variant="primary" onClick={book}>
          Book an appointment
        </Button>
      </p>
      {failure !== undefined ? (
        <Problem failure={failure} onRetry={() => void load()} />
      ) : items === undefined ? (
        <LoadingState label="Loading your appointments" lines={3} onRetry={() => void load()} />
      ) : items.length === 0 ? (
        <EmptyState
          message="No appointments yet. Book your first visit."
          action={
            <Button variant="primary" onClick={book}>
              Book an appointment
            </Button>
          }
        />
      ) : (
        <RefreshingContent refreshing={refreshing}>
          <ul className="ehr-plain-list booking-list">
            {items.map((a) => (
              <li key={a.id} className="ehr-card">
                <h2 className="booking-list__title">
                  {services.find((s) => s.id === a.serviceId)?.name ?? 'Appointment'}
                </h2>
                {appointmentWhen(a).map((l) => (
                  <p key={l} className="booking-line">
                    {l}
                  </p>
                ))}
                <p>
                  {statusChip(a)} {a.mode === 'video' ? 'Video visit' : 'In person'}
                </p>
                <Button onClick={() => go(`/appointments/${a.id}`)}>View details</Button>
              </li>
            ))}
          </ul>
          <p className="ehr-muted">
            {updatedAt !== undefined && <>Updated at {updatedAt}. </>}
            <Button onClick={() => void load()}>Refresh</Button>
          </p>
        </RefreshingContent>
      )}
    </section>
  );
}
