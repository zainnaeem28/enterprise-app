import { useEffect, useRef, useState } from 'react';
import { uiStrings } from '@ehr/ui';
import { mmss, secondsLeft } from '../time.js';

const ANNOUNCE_AT = new Map([
  [300, '5 minutes left on your held time.'],
  [120, '2 minutes left on your held time.'],
  [60, '1 minute left on your held time.'],
]);

/**
 * Hold countdown (UI-UX 7.2). It counts down to the server's `expiresAt`, corrected by the server clock offset taken
 * when the hold was created, not from a timer started on click. Text, `role="timer"`, and a separate polite
 * announcement at 5, 2 and 1 minute only (WCAG 2.2.1, 4.1.3).
 */
export function HoldTimer({
  expiresAt,
  clockOffsetMs,
  onExpired,
  label = uiStrings.slotHeld,
}: {
  expiresAt: string;
  clockOffsetMs: number;
  onExpired: () => void;
  label?: (t: string) => string;
}) {
  const [left, setLeft] = useState(() => secondsLeft(expiresAt, clockOffsetMs));
  const [said, setSaid] = useState('');
  const fired = useRef(false);
  const expired = useRef(onExpired);
  expired.current = onExpired;

  useEffect(() => {
    fired.current = false;
    const tick = () => {
      const n = secondsLeft(expiresAt, clockOffsetMs);
      setLeft(n);
      const say = ANNOUNCE_AT.get(n);
      if (say !== undefined) setSaid(say);
      if (n === 0 && !fired.current) {
        fired.current = true;
        expired.current();
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt, clockOffsetMs]);

  return (
    <>
      <p role="timer" className="booking-timer">
        {label(mmss(left))}
      </p>
      <p role="status" className="ehr-visually-hidden">
        {said}
      </p>
    </>
  );
}
