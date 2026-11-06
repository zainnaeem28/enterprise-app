import { useRef, useState } from 'react';
import { Banner, Button } from '@ehr/ui';
import { newKey } from '../api.js';
import type { Failure } from '../api.js';
import { useBooking, useHeadingFocus, usePageTitle } from '../context.js';
import { HoldTimer } from '../components/HoldTimer.js';
import { isRefusal, Problem, Refusal } from '../components/Problem.js';

/**
 * PP-19: a waitlist offer, accept within the countdown. The contract has no read for an offer, so the page knows only the
 * offer id from the link and, when the notification link carries it, the expiry (`expires`, an ISO time; README open item 3).
 * The server decides: an expired offer answers 409 `scheduling.offer_expired`.
 */
export function OfferPage({ offerId, expires }: { offerId: string; expires: string | null }) {
  const { api, go, setBooked } = useBooking();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [outcome, setOutcome] = useState<'accepted' | 'declined' | 'ended' | undefined>();
  const acceptKey = useRef(newKey());
  const declineKey = useRef(newKey());
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Waitlist offer');
  const expiry = expires !== null && !Number.isNaN(Date.parse(expires)) ? expires : undefined;

  async function accept() {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    const r = await api.acceptOffer(offerId, acceptKey.current);
    setBusy(false);
    if (!r.ok) {
      if (r.code === 'scheduling.offer_expired') return setOutcome('ended');
      return setFailure(r);
    }
    if (r.data !== true) {
      setBooked({ appointment: r.data, kind: 'booked' });
      return go(`/book/done/${r.data.id}`);
    }
    setOutcome('accepted');
  }

  async function decline() {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    const r = await api.declineOffer(offerId, declineKey.current);
    setBusy(false);
    if (!r.ok) {
      if (r.code === 'scheduling.offer_expired') return setOutcome('ended');
      return setFailure(r);
    }
    setOutcome('declined');
  }

  if (outcome !== undefined) {
    const text = {
      accepted: [
        'You accepted the offer',
        'Your appointment is booked. You can see it in your appointments.',
      ],
      declined: [
        'You declined the offer',
        'You stay on the waitlist for other times that open up.',
      ],
      ended: [
        'This offer has run out',
        'The time went back to the schedule. You can book another time.',
      ],
    }[outcome];
    return (
      <section aria-labelledby="offer-h" className="ehr-card booking">
        <h1 id="offer-h" ref={heading} tabIndex={-1}>
          {text[0]}
        </h1>
        <Banner tone="info">{text[1]}</Banner>
        <p className="booking-actions">
          <Button variant="primary" onClick={() => go('/appointments')}>
            Back to appointments
          </Button>
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="offer-h" className="ehr-card booking">
      <h1 id="offer-h" ref={heading} tabIndex={-1}>
        A time opened up for you
      </h1>
      <p>You asked to be told when a time opened up. Accept it to book it now.</p>
      {expiry !== undefined ? (
        <HoldTimer
          expiresAt={expiry}
          clockOffsetMs={0}
          label={(t) => `Offer open for ${t}`}
          onExpired={() => setOutcome('ended')}
        />
      ) : (
        <p className="ehr-muted">This offer is open for a short time only.</p>
      )}
      {failure !== undefined &&
        (isRefusal(failure) ? (
          <Refusal failure={failure} />
        ) : (
          <Problem failure={failure} onRetry={() => void accept()} />
        ))}
      <p className="booking-actions">
        <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => void accept()}>
          Accept this time
        </Button>{' '}
        <Button disabled={busy} onClick={() => void decline()}>
          No thanks
        </Button>
      </p>
    </section>
  );
}
