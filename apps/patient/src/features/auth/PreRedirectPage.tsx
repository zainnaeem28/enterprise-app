import { useEffect, useRef } from 'react';
import { Button } from '@ehr/ui';
import type { Intent } from './EntryPage.js';

/** Says what happens next. There is no automatic redirect, so nobody is moved without pressing the button. */
export function PreRedirectPage({
  intent,
  busy,
  onContinue,
  onBack,
}: {
  intent: Intent;
  busy: boolean;
  onContinue: () => void;
  onBack: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="ehr-card" aria-labelledby="pre-h">
      <h1 id="pre-h" tabIndex={-1} ref={heading}>
        {intent === 'create' ? 'Create your account' : 'Sign in'}
      </h1>
      <p>
        You will go to our secure sign-in page. Checking your email or phone and setting up a
        passkey happen there.
      </p>
      <p>
        <Button variant="primary" onClick={onContinue} disabled={busy}>
          Continue to secure sign-in
        </Button>{' '}
        <Button onClick={onBack} disabled={busy}>
          Back
        </Button>
      </p>
      <p role="status">{busy ? 'Opening the secure sign-in page…' : ''}</p>
    </section>
  );
}
