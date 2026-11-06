import { useEffect, useRef, useState } from 'react';
import { Banner, Button } from '@ehr/ui';
import type { Failure } from '../api.js';
import { useBooking, useHeadingFocus, usePageTitle } from '../context.js';
import { BookingSteps } from '../components/BookingSteps.js';
import { HoldTimer } from '../components/HoldTimer.js';
import { isRefusal, Problem, Refusal } from '../components/Problem.js';
import { SlotTaken } from '../components/SlotTaken.js';
import { PolicyText, VisitSummary } from '../components/Summary.js';
import type { Doctor } from '../types.js';

/**
 * PP-13 (confirm a booking) and the confirm half of PP-16 (change time). Confirm has its own idempotency key
 * (step 2): double click and refresh are safe, and a retried request shows the same confirmation (UI-UX 7.2).
 */
export function ConfirmStep() {
  const { api, go, draft, pending, setPending, setBooked, places } = useBooking();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [doctor, setDoctor] = useState<Doctor | undefined>();
  const [lost, setLost] = useState<{ alternatives: string[]; expired: boolean } | undefined>();
  const inFlight = useRef(false);
  const heading = useHeadingFocus<HTMLHeadingElement>();
  // Remembered across the moment the hold is cleared, so the "lost" view still knows what it was for.
  const last = useRef<{ changing: boolean; zone: string }>({ changing: false, zone: 'UTC' });
  if (pending !== undefined)
    last.current = {
      changing: pending.rescheduleOf !== undefined,
      zone: places.find((p) => p.id === pending.slot.locationId)?.timeZone ?? 'UTC',
    };
  const { changing, zone } = last.current;
  usePageTitle(changing ? 'Change time: confirm' : 'Book: confirm');

  const slot = pending?.slot;
  useEffect(() => {
    if (pending === undefined && lost === undefined)
      return go(changing ? '/appointments' : '/book/time');
  }, [pending, lost, changing, go]);
  useEffect(() => {
    if (slot === undefined || draft.serviceId === undefined) return;
    let live = true;
    void api.doctors(draft.serviceId, slot.locationId).then((r) => {
      if (live && r.ok) setDoctor(r.data.find((d) => d.clinicianId === slot.clinicianId));
    });
    return () => {
      live = false;
    };
  }, [api, draft.serviceId, slot]);

  async function confirm() {
    if (pending === undefined || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(undefined);
    const r = pending.rescheduleOf
      ? await api.reschedule(
          pending.rescheduleOf.id,
          pending.hold.reservationId,
          pending.rescheduleOf.version,
          pending.confirmKey,
        )
      : await api.confirm(pending.hold.reservationId, pending.confirmKey);
    inFlight.current = false;
    setBusy(false);
    if (r.ok) {
      setBooked({ appointment: r.data, kind: changing ? 'changed' : 'booked' });
      setPending(undefined);
      return go(`/book/done/${r.data.id}`);
    }
    if (r.code === 'scheduling.hold_expired' || r.code === 'scheduling.slot_taken') {
      setPending(undefined);
      return setLost({
        alternatives: r.alternatives,
        expired: r.code === 'scheduling.hold_expired',
      });
    }
    setFailure(r);
  }

  const holdEnded = () => {
    setPending(undefined);
    setLost({ alternatives: [], expired: true });
  };

  if (lost !== undefined) {
    return (
      <section aria-labelledby="confirm-h" className="ehr-card booking">
        <h1 id="confirm-h" ref={heading} tabIndex={-1}>
          {lost.expired ? 'Your hold on that time ran out' : 'That time was just taken'}
        </h1>
        <SlotTaken
          title={lost.expired ? 'Your hold on that time ran out' : 'That time was just taken'}
          alternatives={lost.alternatives}
          timeZone={zone}
          busy={false}
          onPick={() => go(changing ? '/appointments' : '/book/time')}
          onWaitlist={() => go('/waitlist/join')}
          continueLabel="Confirm appointment"
        />
        <p>
          <Button variant="primary" onClick={() => go(changing ? '/appointments' : '/book/time')}>
            Choose another time
          </Button>
        </p>
        <p className="ehr-muted">Your service and doctor are kept.</p>
      </section>
    );
  }

  if (pending === undefined || slot === undefined || draft.serviceId === undefined) return null;

  return (
    <section aria-labelledby="confirm-h" className="ehr-card booking">
      {!changing && <BookingSteps current="confirm" />}
      <h1 id="confirm-h" ref={heading} tabIndex={-1}>
        {changing ? 'Confirm the new time' : 'Check and confirm'}
      </h1>
      <VisitSummary
        serviceId={draft.serviceId}
        locationId={slot.locationId}
        startsAt={slot.startsAt}
        mode={slot.mode}
        timeZone={zone}
        doctorName={doctor?.displayName}
      />
      <HoldTimer
        expiresAt={pending.hold.expiresAt}
        clockOffsetMs={pending.hold.clockOffsetMs}
        onExpired={holdEnded}
      />
      <PolicyText />
      {failure !== undefined &&
        (isRefusal(failure) ? (
          <Refusal failure={failure} />
        ) : (
          <Problem
            failure={failure}
            onRetry={() => void confirm()}
            onReload={() => go('/appointments')}
          />
        ))}
      {busy && <Banner tone="info">Confirming…</Banner>}
      <p className="booking-actions">
        <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => void confirm()}>
          {changing ? 'Change to this time' : 'Confirm appointment'}
        </Button>{' '}
        <Button
          disabled={busy}
          onClick={() =>
            go(changing ? `/appointments/${pending.rescheduleOf?.id ?? ''}/change` : '/book/time')
          }
        >
          Back
        </Button>
      </p>
    </section>
  );
}
