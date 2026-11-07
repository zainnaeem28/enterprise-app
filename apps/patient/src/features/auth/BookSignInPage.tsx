import { useEffect, useRef } from 'react';
import { Button } from '@ehr/ui';
import type { Intent } from './EntryPage.js';

/** BS-06: a visitor sent here by "Book" on the brand site. No automatic redirect; the buttons lead to the secure sign-in. */
export function BookSignInPage({ onContinue }: { onContinue: (intent: Intent) => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="ehr-card" aria-labelledby="bs06-h">
      <h1 id="bs06-h" tabIndex={-1} ref={heading}>
        Sign in or create an account to finish booking
      </h1>
      <p>You will go to our secure sign-in page and come back here to continue.</p>
      <p>
        <Button variant="primary" onClick={() => onContinue('sign-in')}>
          Sign in
        </Button>{' '}
        <Button onClick={() => onContinue('create')}>Create account</Button>
      </p>
    </section>
  );
}
