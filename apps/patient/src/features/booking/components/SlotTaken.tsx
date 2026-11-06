import { Banner, Button } from '@ehr/ui';
import { clockLabel, dayLabel } from '../time.js';

/**
 * "That time was just taken" (X-02, `scheduling.slot_taken`; phone mockup 2): nearby alternatives from the server, a
 * waitlist offer, and a disabled primary with its reason in text. `title` changes for an expired hold (X-01).
 */
export function SlotTaken({
  title = 'That time was just taken',
  alternatives,
  timeZone,
  busy,
  onPick,
  onWaitlist,
  continueLabel = 'Continue',
}: {
  title?: string;
  alternatives: string[];
  timeZone: string;
  busy: boolean;
  onPick: (startsAt: string) => void;
  onWaitlist: () => void;
  continueLabel?: string;
}) {
  return (
    <section className="booking-taken" aria-labelledby="taken-h">
      <Banner tone="warning" title={title}>
        Another person booked it first. You have not lost anything.
      </Banner>
      {alternatives.length > 0 ? (
        <>
          <h2 id="taken-h">Times near that</h2>
          <ul className="ehr-plain-list booking-alternatives">
            {alternatives.map((iso) => (
              <li key={iso}>
                <Button disabled={busy} onClick={() => onPick(iso)}>
                  {dayLabel(iso, timeZone)}, {clockLabel(iso, timeZone)}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <h2 id="taken-h" className="ehr-visually-hidden">
          Other options
        </h2>
      )}
      <p>
        <Button onClick={onWaitlist}>Join the waitlist for this visit</Button>
      </p>
      <p>
        <Button variant="primary" disabled aria-describedby="taken-why">
          {continueLabel}
        </Button>{' '}
        <span id="taken-why" className="ehr-muted">
          Choose another time to continue.
        </span>
      </p>
    </section>
  );
}
