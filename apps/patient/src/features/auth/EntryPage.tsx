import { Button } from '@ehr/ui';

export type Intent = 'sign-in' | 'create';

/** Entry: both buttons lead to the same secure sign-in; no password, code or passkey field lives on our pages. */
export function EntryPage({ onContinue }: { onContinue: (intent: Intent) => void }) {
  return (
    <section className="ehr-card" aria-labelledby="entry-h">
      <h1 id="entry-h">Patient portal</h1>
      <p>Sign in to see your visits and messages, or create an account.</p>
      <p>
        <Button variant="primary" onClick={() => onContinue('sign-in')}>
          Sign in
        </Button>{' '}
        <Button onClick={() => onContinue('create')}>Create account</Button>
      </p>
    </section>
  );
}
