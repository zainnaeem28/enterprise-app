import { useRef, useState } from 'react';
import { AlertDialog, Banner, Button, LoadingState, TextAreaField } from '@ehr/ui';
import { newKey } from '../api.js';
import type { Failure } from '../api.js';
import { useBooking, useHeadingFocus, usePageTitle } from '../context.js';
import { isRefusal, Problem, Refusal } from '../components/Problem.js';
import { PolicyText, VisitSummary } from '../components/Summary.js';
import { useAppointment } from './DetailPage.js';

const MAX_REASON = 500;

/**
 * PP-17: cancel with the policy text. Block-only default (D-3): a cancel inside the cut-off is refused by the server
 * (`scheduling.cutoff_passed`), the page says to call the clinic, and no fee is shown or accepted (`acceptFee` is never sent).
 */
export function CancelPage({ id }: { id: string }) {
  const { api, go } = useBooking();
  const { appointment: a, failure: loadFailure, reload } = useAppointment(id);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [done, setDone] = useState(false);
  // One key for this cancel; a retry after a timeout is the same request (CN-06).
  const key = useRef(newKey());
  const inFlight = useRef(false);
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Cancel appointment');

  if (loadFailure !== undefined)
    return <Problem failure={loadFailure} onRetry={() => void reload()} />;
  if (a === undefined) return <LoadingState label="Loading your appointment" lines={3} />;

  async function cancel() {
    if (a === undefined || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const r = await api.cancel(a.id, a.version, key.current, reason.trim() || undefined);
    inFlight.current = false;
    setBusy(false);
    setConfirming(false);
    if (r.ok) return setDone(true);
    setFailure(r);
  }

  if (done) {
    return (
      <section aria-labelledby="cancel-h" className="ehr-card booking">
        <h1 id="cancel-h" ref={heading} tabIndex={-1}>
          Your appointment was cancelled
        </h1>
        <Banner tone="info">The time was released. You can book another visit at any time.</Banner>
        <p className="booking-actions">
          <Button variant="primary" onClick={() => go('/book')}>
            Book an appointment
          </Button>{' '}
          <Button onClick={() => go('/appointments')}>Back to appointments</Button>
        </p>
      </section>
    );
  }

  const stale = failure?.status === 412;
  const blocked =
    failure?.code === 'scheduling.cutoff_passed' ||
    failure?.code === 'scheduling.fee_acceptance_required';

  return (
    <section aria-labelledby="cancel-h" className="ehr-card booking">
      <h1 id="cancel-h" ref={heading} tabIndex={-1}>
        Cancel this appointment?
      </h1>
      <VisitSummary
        serviceId={a.serviceId}
        locationId={a.locationId}
        startsAt={a.startsAt}
        mode={a.mode}
        timeZone={a.locationTimeZone}
      />
      <PolicyText />
      {failure !== undefined &&
        (stale ? (
          <Problem failure={failure} onReload={() => go(`/appointments/${a.id}`)} />
        ) : isRefusal(failure) ? (
          <Refusal failure={failure} />
        ) : (
          <Problem failure={failure} onRetry={() => void cancel()} />
        ))}
      {!blocked && !stale && (
        <TextAreaField
          label="Reason (optional)"
          hint="You do not need to give a reason. Please do not include health details."
          maxLength={MAX_REASON}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      )}
      <p className="booking-actions">
        {!blocked && !stale && (
          <>
            <Button variant="primary" disabled={busy} onClick={() => setConfirming(true)}>
              Cancel appointment
            </Button>{' '}
          </>
        )}
        <Button onClick={() => go(`/appointments/${a.id}`)}>Keep appointment</Button>
      </p>
      {confirming && (
        <AlertDialog
          title="Cancel this appointment?"
          initialFocus="[data-keep]"
          actions={
            <>
              <Button data-keep onClick={() => setConfirming(false)}>
                Keep appointment
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void cancel()}
              >
                Cancel appointment
              </Button>
            </>
          }
        >
          <p>The time will be released for other patients. You can book again at any time.</p>
        </AlertDialog>
      )}
    </section>
  );
}
